// Security review (roadmap 8.3): each test is a way in that was found and closed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { startApp, cookieJar } from './helpers.js';
import { ROOT } from '../src/config.js';
import { safeNext } from '../src/platform/session.js';
import { createLimiter } from '../src/platform/auth.js';
import { isReserved } from '../src/platform/reserved.js';
import { INFRA_MOUNT, CX_BASE, CX_PUBLIC } from '../src/platform/accelerators.js';

let t;
before(async () => {
  t = await startApp({ eventsRecheckMs: 50 });
  await t.accelerators.mounted.infrastructure.local.agent.welcome;
});
after(async () => { await t?.close(); });

/** Stands in for a service's container on its host port while fn runs. */
async function container(workspace, service, handler, fn) {
  const [endpoint] = await t.platform().workloads.endpoints(workspace, service);
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(Number(new URL(endpoint.url).port), '127.0.0.1', r));
  try {
    return await fn();
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('a team named like one of our paths gets another workspace id; every path of ours is reserved', async () => {
  for (const team of ['JS', 'Infrastructure', 'Hooks', 'CSS', 'Health', 'W']) {
    const ws = await t.accounts.createWorkspace({ name: team, ownerId: 'stevie' });
    assert.ok(!isReserved(ws.id) && ws.id.startsWith(team.length > 1 ? `${team.toLowerCase()}-` : 'workspace-'), `${team} → ${ws.id}`);
  }
  await assert.rejects(t.accounts.createWorkspace({ id: 'js', name: 'JS', ownerId: 'stevie' }), /one of our paths/);

  // Every first path segment the app answers: its routers (walked), public/ and the accelerators' mounts.
  const segments = new Set(await fs.readdir(path.join(ROOT, 'public')));
  const walk = (stack) => {
    for (const layer of stack ?? []) {
      if (layer.route) for (const p of [].concat(layer.route.path)) segments.add(String(p).split('/')[1]);
      if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk(t.app.router.stack);
  for (const mount of [INFRA_MOUNT, CX_BASE, CX_PUBLIC]) for (const s of mount.split('/')) segments.add(s);
  const missing = [...segments].filter((s) => /^[a-z0-9][a-z0-9.-]*$/.test(s) && !isReserved(s));
  assert.deepEqual(missing, [], 'add these to src/platform/reserved.js');
});

test('a workspace that already has one of our paths as its id cannot put a service in front of our files', async () => {
  // Local network services answer at /<workspace>/<service>/ ahead of every route of ours: a workspace "js" with a
  // service "pages" would answer /js/pages/*.js, our own scripts. Written straight to the store, as older data might be.
  const now = new Date().toISOString();
  await t.data.addWithKey('hero_workspaces', 'js', { id: 'js', name: 'JS', createdBy: 'stevie', organizationId: null, createdAt: now });
  await t.data.addWithKey('hero_memberships', 'm_js', { id: 'm_js', workspaceId: 'js', personId: 'stevie', role: 'Owner', createdAt: now });
  const created = await t.post('/api/v1/workspaces/js/services', {
    as: 'stevie',
    body: { type: 'web', name: 'pages', repoUrl: 'https://github.com/render-examples/express-hello-world', branch: 'main', region: 'local', runtime: 'node22', plan: 'starter', instances: 1 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await t.idle();
  const ours = await fs.readFile(path.join(ROOT, 'public/js/pages/service.js'), 'utf8');
  await container('js', 'pages', (req, res) => res.end('steal(document.cookie)'), async () => {
    const res = await fetch(`${t.base}/js/pages/service.js`);
    assert.equal(await res.text(), ours, 'our script, not the service');
  });
});

test('after signing in, the browser only goes to a path on this site: no tab or newline turns it into another site', async () => {
  for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', '/\n/evil.com', '/\r\n/evil.com', 'https://evil.com', 'evil.com', '/ok\u0000']) {
    assert.equal(safeNext(bad), null, JSON.stringify(bad));
  }
  for (const good of ['/', '/w/exclusivity-life', '/w/exclusivity-life/services/api?tab=logs#x', '/a%2F%2Fb']) assert.equal(safeNext(good), good);
  const jar = cookieJar();
  const res = await t.post('/services/authservice/api/login', { jar, body: { email: 'stevie@exclusivity.life', password: 'development-only-1', returnUrl: '/\t/evil.com' }, headers: { origin: t.base } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.redirectUrl, '/w/exclusivity-life', 'home, not evil.com');
});

test('a service cannot set headers that act on our whole origin', async () => {
  const created = await t.post('/api/v1/workspaces/exclusivity-life/services', {
    as: 'stevie',
    body: { type: 'web', name: 'headers', repoUrl: 'https://github.com/render-examples/express-hello-world', branch: 'main', region: 'local', runtime: 'node22', plan: 'starter', instances: 1 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await t.idle();
  const theirs = {
    'clear-site-data': '"cookies", "storage"', 'strict-transport-security': 'max-age=0', nel: '{"report_to":"x","max_age":86400}',
    'report-to': '{"group":"x","max_age":86400,"endpoints":[{"url":"https://evil.example/r"}]}', 'reporting-endpoints': 'x="https://evil.example/r"',
    'alt-svc': 'h2="evil.example:443"', 'service-worker-allowed': '/', 'set-cookie': 'hero.sid=planted; Path=/', 'x-their-own': 'kept',
  };
  await container('exclusivity-life', 'headers', (req, res) => { res.writeHead(200, { 'content-type': 'text/plain', ...theirs }); res.end('hi'); }, async () => {
    const res = await fetch(`${t.base}/exclusivity-life/headers/`);
    assert.equal(res.status, 200);
    for (const name of Object.keys(theirs).filter((n) => n !== 'x-their-own' && n !== 'strict-transport-security')) assert.equal(res.headers.get(name), null, name);
    assert.notEqual(res.headers.get('strict-transport-security'), 'max-age=0', 'our HSTS, not theirs');
    assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=[1-9]/);
    assert.equal(res.headers.get('x-their-own'), 'kept');
    assert.match(res.headers.get('content-security-policy'), /^sandbox /);
  });
});

test('the push webhook checks the signature before it reads the body', async () => {
  const res = await t.post('/hooks/github/exclusivity-life', { headers: { 'content-type': 'application/json', 'x-github-event': 'push' }, body: undefined });
  assert.equal(res.status, 401);
  const junk = await fetch(`${t.base}/hooks/github/exclusivity-life`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: '{not json' });
  assert.equal(junk.status, 401, 'an unsigned body is not even parsed');
});

test('the sign-in rate limiter keeps a bounded number of keys', () => {
  const limiter = createLimiter({ max: 3, windowMs: 60_000, MAX_KEYS: 100 });
  for (let i = 0; i < 1000; i += 1) limiter.hit(`made-up-${i}@example.com`);
  assert.ok(limiter.size() <= 100, `${limiter.size()} keys kept`);
  for (let i = 0; i < 3; i += 1) limiter.hit('victim@example.com');
  assert.equal(limiter.blocked('victim@example.com'), true, 'the newest keys still count');
});

/** Opens /api/v1/events; resolves with what it sent when the server ends the stream, rejects if it is open after ms. */
async function streamEnds(open, ms = 3000) {
  const res = await open();
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; reader.cancel('still open'); }, ms);
  let text = '';
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    text += Buffer.from(value).toString('utf8');
  }
  clearTimeout(timer);
  if (timedOut) throw new Error(`The event stream was still open after ${ms} ms.`);
  return text;
}

test('an open event stream ends when its person is removed from the workspace or signs out', async () => {
  // Removed from a workspace: the stream (logs, deploys) stops, and the next one has only what they may see.
  await t.accounts.addMember('exclusivity-life', 'amara');
  const removed = streamEnds(() => fetch(`${t.base}/api/v1/events`, { headers: { 'x-dev-person': 'amara' } }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await t.accounts.removeMember('exclusivity-life', 'amara'), true);
  const firstText = await removed;
  assert.match(firstText, /"topics":\["amara-labs","exclusivity-life"\]|"topics":\["exclusivity-life","amara-labs"\]/);
  const again = await fetch(`${t.base}/api/v1/events`, { headers: { 'x-dev-person': 'amara' } });
  const reader = again.body.getReader();
  const hello = Buffer.from((await reader.read()).value).toString('utf8');
  await reader.cancel();
  assert.match(hello, /"topics":\["amara-labs"\]/);

  // Signed out (a cookie sign-in): the open stream ends with the session.
  const jar = cookieJar();
  const signedIn = await t.post('/dev/login', { jar, form: { person: 'stevie' } });
  assert.equal(signedIn.status, 303);
  const open = streamEnds(() => fetch(`${t.base}/api/v1/events`, { headers: { cookie: jar.header() } }));
  await new Promise((r) => setTimeout(r, 150));
  const out = await t.post('/api/v1/auth/signout', { jar, headers: { origin: t.base } });
  assert.ok(out.status < 400, out.text);
  await open;
});
