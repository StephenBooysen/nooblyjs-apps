// The Content-Security-Policy (roadmap 8.7.6; the audit's S2): no whole CDN, no Tag Manager, third-party files by exact
// URL only, and on the pages that carry the card form (Billing, the hosted checkout) scripts from this origin and
// Stripe only. Every page below is fetched as it is served, and each third-party file it loads must be allowed by its
// own policy: a file core or an accelerator adds is found here, not by a blank page in production.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startApp, cookieJar } from './helpers.js';
import { directivesFor, policyFor, THIRD_PARTY } from '../src/platform/csp.js';
import { loadConfig, productionProblem, ROOT } from '../src/config.js';

let t;
/** Signed in as core's start-up admin (a platform operator): core's /services pages take its session and role. */
const operator = cookieJar();
before(async () => {
  t = await startApp({ cards: false });
  const password = (await fs.readFile(path.join(t.dataDir, 'auth', 'INITIAL_ADMIN_PASSWORD.txt'), 'utf8')).match(/^password:\s*(\S+)/m)[1];
  const res = await t.post('/services/authservice/api/login', { jar: operator, body: { email: 'admin@localhost', password }, headers: { origin: t.base } });
  assert.equal(res.status, 200, res.text);
});
after(() => t?.close());

/** The policy header as { directive: [sources] }. */
function parse(header) {
  return Object.fromEntries(header.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));
}

/** Whether a source list allows an absolute URL (exact file, folder ending in /, or a bare origin). */
function allows(sources, url) {
  const u = new URL(url);
  return sources.some((s) => {
    if (!/^https?:\/\//.test(s)) return false;
    const src = new URL(s);
    if (src.origin !== u.origin) return false;
    if (src.pathname === '/' && !s.endsWith('/')) return true;
    return s.endsWith('/') ? u.pathname.startsWith(src.pathname) : u.pathname === src.pathname;
  });
}

const NEVER = /cdn\.jsdelivr\.net(?![^\s]*\/npm\/[^\s]+@)|unpkg\.com(?![^\s]*@)|googletagmanager|google-analytics/;

test('hero-co\'s pages, Billing among them, run scripts from this origin only', async () => {
  for (const page of ['/', '/w/exclusivity-life/billing', '/w/exclusivity-life/services/blog', '/infrastructure/', '/admin/payments/p/invoices/x', '/admin/marketing/p/preferences/x']) {
    const header = (await t.get(page, { as: 'stevie' })).headers.get('content-security-policy');
    const csp = parse(header);
    assert.deepEqual(csp['script-src'], ["'self'"], `${page}: ${csp['script-src']}`);
    assert.deepEqual(csp['connect-src'], ["'self'"], page);
    assert.deepEqual(csp['script-src-attr'], ["'none'"], page);
    assert.doesNotMatch(header, /unsafe-inline|unsafe-eval|googletagmanager|google-analytics|unpkg/, page);
  }
});

test('core\'s and the customers accelerator\'s pages get the exact files they load, never a whole host', async () => {
  for (const page of ['/services/authservice/views/login.html', '/services/', '/admin/customer/', '/admin/marketing/']) {
    assert.equal(policyFor(page), 'operator', page);
    const header = (await t.get(page, { jar: operator })).headers.get('content-security-policy');
    const scripts = parse(header)['script-src'];
    assert.ok(scripts.includes('https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js'), page);
    for (const s of scripts.filter((s) => s.startsWith('https://'))) assert.match(s, /\/[^/]+@[^/]+\/.+\.js$/, `${page}: ${s} is a file, not a host`);
    assert.doesNotMatch(header, /googletagmanager|google-analytics|unsafe-inline/, page);
  }
});

test('every third-party file a served page loads is allowed by that page\'s policy', async () => {
  const pages = [
    '/', '/w/exclusivity-life/billing', '/services/authservice/views/login.html', '/services/', '/services/api/docs',
    '/services/workflow/', '/services/logging/', '/admin', '/admin/customer/', '/admin/marketing/', '/admin/payments/',
    '/infrastructure/',
  ];
  const checked = [];
  for (const page of pages) {
    const res = await t.get(page, { jar: operator });
    if (res.status !== 200 || !/text\/html/.test(res.headers.get('content-type') ?? '')) continue;
    const csp = parse(res.headers.get('content-security-policy'));
    for (const [, url] of res.text.matchAll(/<script[^>]+src="(https?:\/\/[^"]+)"/g)) {
      assert.ok(allows(csp['script-src'], url), `${page} loads ${url}, which its script-src blocks`);
    }
    for (const [, url] of res.text.matchAll(/<link[^>]+href="(https?:\/\/[^"]+)"/g)) {
      assert.ok(allows(csp['style-src'], url), `${page} loads ${url}, which its style-src blocks`);
    }
    checked.push(page);
  }
  for (const page of ['/', '/services/authservice/views/login.html', '/services/', '/services/api/docs', '/admin/customer/', '/admin/marketing/', '/infrastructure/']) {
    assert.ok(checked.includes(page), `${page} was served and checked (checked: ${checked.join(', ')})`);
  }
});

test('hero-co\'s own page loads Bootstrap from public/vendor/, byte for byte the published files', async () => {
  const index = (await t.get('/')).text;
  assert.doesNotMatch(index, /cdn\.jsdelivr|unpkg/);
  const published = {
    '/vendor/bootstrap@5.3.3/dist/css/bootstrap.min.css': 'sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH',
    '/vendor/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css': 'sha384-XGjxtQfXaH2tnPFa9x+ruJTuLE3Aa6LhHSWRr1XeTyhezb4abCG4ccI5AkVDxqC+',
    '/vendor/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff2': 'sha384-QV+/zNG6sFIQ/qAWRxaR4sjpF37wr046d3pTS5QlogmJfbmyeiWip4YIIGmdK4pa',
  };
  const { createHash } = await import('node:crypto');
  assert.match(index, /href="\/vendor\/bootstrap@5\.3\.3\/dist\/css\/bootstrap\.min\.css"/);
  assert.match(index, /href="\/vendor\/bootstrap-icons@1\.11\.3\/font\/bootstrap-icons\.min\.css"/);
  for (const [url, sri] of Object.entries(published)) {
    const bytes = await fs.readFile(path.join(ROOT, 'public', url));
    assert.equal(`sha384-${createHash('sha384').update(bytes).digest('base64')}`, sri, url);
    assert.equal((await t.get(url)).status, 200, url);
  }
});

test('Stripe adds its own origins and nothing else; the operator policy never reaches the strict pages', () => {
  const strict = directivesFor('strict', { payProvider: 'stripe' });
  assert.deepEqual(strict.scriptSrc, ["'self'", 'https://js.stripe.com']);
  assert.deepEqual(strict.connectSrc, ["'self'", 'https://api.stripe.com']);
  assert.deepEqual(strict.frameSrc, ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com']);
  for (const f of THIRD_PARTY.filter((f) => f.policy === 'operator')) assert.ok(!strict.scriptSrc.includes(f.url) && !strict.styleSrc.includes(f.url), f.url);
  for (const s of [...directivesFor('operator').scriptSrc, ...directivesFor('operator').connectSrc]) assert.doesNotMatch(s, NEVER, s);
  assert.equal(policyFor('/admin'), 'strict', 'core\'s frame (the back office) loads only /ui');
  assert.equal(policyFor('/admin/payments/p/invoices/abc'), 'strict', 'the hosted checkout');
});

test('production refuses CSP_MODE=off', () => {
  const env = {
    NODE_ENV: 'production', SESSION_SECRET: 'a-0123456789', HERO_SECRET_KEY: 'b-0123456789', INFRA_SECRET_KEY: 'c-0123456789',
    SETTINGS_SECRET: 'd-0123456789', EMAIL: 'off', INFRA_PROVIDERS: 'gcp',
  };
  assert.equal(productionProblem(loadConfig(env)), null);
  assert.equal(productionProblem(loadConfig({ ...env, CSP_MODE: 'report-only' })), null);
  assert.match(productionProblem(loadConfig({ ...env, CSP_MODE: 'off' })), /CSP_MODE=off/);
});
