// Local network services on this app's own URL (infra spec 8.9; decided 2026-11-20): <base URL>/<workspace>/<service>/…
// is passed to the service's running containers with the prefix taken off, round robin, and their answer comes back.
//
// Routes are kept in memory (workspace/service → the instances' URLs), filled from the platform at start and kept in
// step with its deploy, status and delete events, so a request for any other page costs one Map lookup.
//
// The apps are other people's code on our origin, so:
//   - none of our cookies are passed to them, and their Set-Cookie headers are dropped (no planting a session cookie);
//   - every answer carries `Content-Security-Policy: sandbox …` without allow-same-origin, so their pages run in an
//     opaque origin: their scripts cannot read our cookies or call our API as the viewer;
//   - our own security headers (helmet's CSP for this app) are taken off their answers and replaced by that sandbox.
// The price: apps cannot use cookies or localStorage on this URL yet. A separate apps origin (or a domain) lifts that.
//
// A Static Site (roadmap 5.1; infra spec 8.8) has no containers: its files are the platform's, answered by
// services.platform.staticSites.respond() with their cache headers, ETags, redirects and _headers, under the same
// sandbox. A redirect to one of its own paths stays under its prefix; whether the cache answered is counted.
import http from 'node:http';
import { REGIONS } from '../../public/js/shared/catalog.js';
import { isReserved } from '../platform/reserved.js';

const LOCAL = new Set(REGIONS.filter((r) => r.local).map((r) => r.id));
const OURS = new Set(['hero.sid', 'noobly.csrf', 'noobly.dev-person', 'connect.sid']);
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';
// Headers a service may not set on our origin (roadmap 8.3): cookies and its own CSP (it gets our sandbox), and the
// ones that act on the whole origin rather than its own page: Clear-Site-Data would sign every viewer out of us,
// Strict-Transport-Security could turn our HSTS off, NEL / Report-To / Reporting-Endpoints would send it reports about
// our pages, Alt-Svc could point our origin at another host, Service-Worker-Allowed widens a worker's scope.
export const DROPPED = new Set([
  'set-cookie', 'content-security-policy', 'content-security-policy-report-only', 'clear-site-data',
  'strict-transport-security', 'nel', 'report-to', 'reporting-endpoints', 'alt-svc', 'service-worker-allowed',
]);
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The Cookie header without our cookies. */
export function stripOurCookies(header) {
  if (!header) return null;
  const kept = String(header).split(';').map((c) => c.trim()).filter((c) => c && !OURS.has(c.split('=')[0].trim()));
  return kept.length ? kept.join('; ') : null;
}

/**
 * The service's headers in place of ours (helmet's are for our pages), less DROPPED, then our sandbox. Our own
 * Strict-Transport-Security stays: the address is ours whatever answers it.
 */
function takeHeaders(res, theirs) {
  const hsts = res.getHeader('strict-transport-security');
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  for (const [k, v] of Object.entries(theirs)) if (!HOP.has(k) && !DROPPED.has(k.toLowerCase())) res.setHeader(k, v);
  if (hsts) res.setHeader('strict-transport-security', hsts);
  res.setHeader('content-security-policy', SANDBOX);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
}

/**
 * @param {object} o
 * @param {object} o.records
 * @param {() => object} o.platform   services.platform
 * @param {import('node:events').EventEmitter} o.eventEmitter
 * @param {{ warn?: Function }} [o.log]
 * @param {(ws: string, service: string, info: { status: number, bytes: number }) => void} [o.onRequest]
 *   told when a proxied request ends: its status and the bytes sent back (the service's Requests and Bandwidth)
 */
export function createServiceProxy({ records, platform, eventEmitter, log = {}, onRequest = () => {} }) {
  const routes = new Map(); // `${ws}/${name}` → { urls: string[], next: number }
  const key = (ws, name) => `${ws}/${name}`;

  async function refresh(ws, name) {
    try {
      const s = await records.services.byName(ws, name);
      if (!s || !LOCAL.has(s.region)) return void routes.delete(key(ws, name));
      if (s.type === 'static') return void routes.set(key(ws, name), { site: s.workload ?? name, urls: [], next: 0 });
      const endpoints = await platform().workloads.endpoints(ws, s.workload ?? name);
      // A Local network service with nothing answering (deploying, or its server is offline) keeps its route, empty,
      // so the address answers 503 for the service rather than falling through to our own pages.
      routes.set(key(ws, name), { urls: endpoints.map((e) => e.url), next: 0 });
    } catch (err) {
      if (err.code === 'not_found') routes.delete(key(ws, name));
      else log.warn?.(`[hero-co] proxy routes for ${ws}/${name}: ${err.message}`);
    }
  }

  const onChange = (e) => { if (e?.tenantId && e?.workload) refresh(e.tenantId, e.workload); };
  // `endpoints`: where a workload answers changed: a rollout switched to new instances (sent before the old ones are
  // removed, so no request meets a removed container), or an instance went unknown, came back or moved (infra 8.9).
  const types = ['infrastructure.workload.endpoints', 'infrastructure.deploy.succeeded', 'infrastructure.deploy.failed', 'infrastructure.workload.status', 'infrastructure.workload.deleted'];
  for (const t of types) eventEmitter.on(t, onChange);

  /** Fills the routes from every Local network service (at start). */
  async function load(workspaceIds) {
    for (const ws of workspaceIds) for (const s of await records.services.list(ws)) if (LOCAL.has(s.region)) await refresh(ws, s.name);
  }

  function forward(req, res, route, rest, attempt = 0) {
    const target = new URL(route.urls[(route.next++) % route.urls.length]);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== 'cookie' && k !== 'host') headers[k] = v;
    const cookie = stripOurCookies(req.headers.cookie);
    if (cookie) headers.cookie = cookie;
    const prefix = req.servicePrefix;
    Object.assign(headers, {
      host: req.headers.host ?? target.host,
      'x-forwarded-host': req.headers.host ?? '',
      'x-forwarded-proto': req.protocol,
      'x-forwarded-for': [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', '),
      'x-forwarded-prefix': prefix,
    });
    const upstream = http.request({ host: target.hostname, port: target.port, method: req.method, path: rest, headers, timeout: 60_000 }, (up) => {
      takeHeaders(res, up.headers);
      // A redirect to the app's own root stays under its prefix.
      const loc = up.headers.location;
      if (typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith('//') && !loc.startsWith(prefix)) res.setHeader('location', `${prefix.replace(/\/$/, '')}${loc}`);
      res.statusCode = up.statusCode ?? 502;
      up.on('data', (chunk) => { res.heroBytes = (res.heroBytes ?? 0) + chunk.length; });
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      // Another instance may answer (only for requests without a body we have already sent on).
      if (attempt + 1 < route.urls.length && (req.method === 'GET' || req.method === 'HEAD')) return forward(req, res, route, rest, attempt + 1);
      log.warn?.(`[hero-co] ${prefix} did not answer: ${err.message}`);
      res.status(502).type('text').send('This service is not answering. Its logs on the service page say why.');
    });
    // A request without a body is ended at once (a retry cannot pipe an ended request again).
    if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
    else req.pipe(upstream);
  }

  /** A static site's answer: the platform's status, headers and body, with our sandbox and its paths under the prefix. */
  async function serveSite(req, res, ws, route, rest) {
    const q = rest.indexOf('?');
    const path = q < 0 ? rest : rest.slice(0, q);
    const query = q < 0 ? '' : rest.slice(q + 1);
    let r;
    try {
      r = await platform().staticSites.respond(ws, route.site, { method: req.method, path, query, headers: { 'if-none-match': req.headers['if-none-match'] } });
    } catch (err) {
      log.warn?.(`[hero-co] ${req.servicePrefix} site: ${err.message}`);
      return res.status(502).type('text').send('This site cannot be served right now. Try again shortly.');
    }
    takeHeaders(res, r.headers ?? {});
    const loc = r.headers?.location;
    if (typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith('//')) res.setHeader('location', `${req.servicePrefix.replace(/\/$/, '')}${loc}`);
    res.heroHit = r.hit === true;
    res.heroBytes = r.body?.length ?? 0;
    res.statusCode = r.status;
    res.end(r.body ?? undefined);
  }

  /** Express middleware: answers /<workspace>/<service>[/…] for a running Local network service; anything else passes. */
  function middleware(req, res, next) {
    const [, ws, name] = req.path.split('/');
    // One of our own paths is never a service's, whatever workspace has that id (platform/reserved.js).
    if (!ws || !name || !SEGMENT.test(ws) || !SEGMENT.test(name) || isReserved(ws)) return next();
    const route = routes.get(key(ws, name));
    if (!route) return next();
    const base = `/${ws}/${name}`;
    const original = req.originalUrl;
    const after = original.slice(base.length);
    // /ws/name → /ws/name/, so the app's relative links resolve under its prefix.
    if (after === '' || after.startsWith('?')) return res.redirect(308, `${base}/${after}`);
    req.servicePrefix = `${base}/`;
    let told = false;
    const tell = () => {
      if (told) return;
      told = true;
      try {
        onRequest(ws, name, { status: res.statusCode, bytes: res.heroBytes ?? Number(res.getHeader('content-length') ?? 0), hit: res.heroHit === true });
      } catch { /* counting never breaks a request */ }
    };
    res.on('finish', tell);
    res.on('close', tell);
    if (route.site) return serveSite(req, res, ws, route, after);
    if (!route.urls.length) {
      res.set('Retry-After', '30');
      return res.status(503).type('text').send('This service has no instance answering right now: it is deploying, or its server is offline. Try again shortly.');
    }
    return forward(req, res, route, after);
  }

  return {
    middleware,
    load,
    refresh,
    routes: () => Object.fromEntries([...routes].map(([k, v]) => [k, v.urls])),
    stop: () => { for (const t of types) eventEmitter.off(t, onChange); },
  };
}
