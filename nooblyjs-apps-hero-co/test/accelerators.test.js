// The accelerators mounted with mount() (roadmap 0.3): operators reach the infrastructure accelerator (in the
// nooblyjs-core frame) and the customers accelerator; customers reach neither; payments is reported as pending.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let t;
before(async () => { t = await startApp(); });
after(async () => { await t?.close(); });

test('operators reach the infrastructure accelerator: its API, its pages in the frame, the operator shell', async () => {
  const about = await t.get('/infrastructure/api/v1/about', { as: 'ops-platform' });
  assert.equal(about.status, 200);
  assert.deepEqual([about.json.name, about.json.mountPath, about.json.providers], ['infrastructure', '/infrastructure', ['mock']]);
  const page = await t.get('/infrastructure/vms', { as: 'ops-platform' });
  assert.equal(page.status, 200);
  assert.match(page.text, /<!doctype html>/i);
  const shell = await t.get('/api/v1/shell', { as: 'ops-platform' });
  assert.equal(shell.status, 200);
  assert.ok(shell.json.apps.some((a) => a.name === 'infrastructure' && a.mountPath === '/infrastructure'));
  assert.equal((await t.get('/ui/js/api.js')).status, 200);
});

test('the infrastructure accelerator sees operators with their access roles', async () => {
  const owner = await t.get('/infrastructure/api/v1/accounts', { as: 'ops-platform' });
  assert.equal(owner.status, 200);
  const viewer = await t.post('/infrastructure/api/v1/accounts', { as: 'ops-support', body: { cloud: 'gcp', name: 'nope' } });
  assert.equal(viewer.status, 403, 'support (Viewer) may not connect cloud accounts');
  assert.ok(t.host.auditLog.some((r) => r.action === 'access.refused' && r.actor === 'ops-support'), 'the refusal is audited');
});

test('operators reach the customers accelerator\'s API and admin UI', async () => {
  const health = await t.get('/admin/customer/api/v1/health', { as: 'ops-platform' });
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  assert.equal((await t.get('/admin/customer/', { as: 'ops-platform' })).status, 200);
  const list = await t.get('/admin/customer/api/v1/customers?limit=1', { as: 'ops-platform' });
  assert.equal(list.status, 200);
  assert.ok(list.json.total > 0, 'the demo customers are seeded in development');
});

test('customers reach neither accelerator, nor the operator API', async () => {
  for (const url of ['/infrastructure/', '/infrastructure/api/v1/about', '/admin/customer/', '/admin/customer/api/v1/health', '/api/v1/admin/accelerators', '/api/v1/shell', '/admin', '/customers', '/marketing', '/payments']) {
    assert.equal((await t.get(url, { as: 'stevie' })).status, 404, url);
  }
  assert.equal((await t.get('/infrastructure/api/v1/about')).status, 401, 'signed out: 401 on the API');
});

test('the customers accelerator\'s public marketing routes need no sign-in', async () => {
  const res = await t.get('/admin/marketing/p/u/not-a-token');
  assert.notEqual(res.status, 302);
  assert.notEqual(res.status, 401);
});

test('the operator rail: Customers, Marketing, Payments and Infrastructure, each in nooblyjs-core\'s frame', async () => {
  const { json } = await t.get('/api/v1/shell', { as: 'ops-platform' });
  const rail = json.apps.filter((a) => a.rail);
  assert.deepEqual(rail.map((a) => [a.name, a.label, a.mountPath]), [
    ['customers', 'Customers', '/customers'], ['marketing', 'Marketing', '/marketing'], ['payments', 'Payments', '/payments'], ['infrastructure', 'Infrastructure', '/infrastructure'],
  ]);
  // The first three show their accelerator's own page; each knows them all, so a link inside one can switch the rail.
  assert.deepEqual(rail.slice(0, 3).map((a) => a.ui.src), ['/admin/customer/', '/admin/marketing/', '/admin/payments/']);
  assert.deepEqual(rail[0].ui.screens.map((s) => s.mountPath), ['/customers', '/marketing', '/payments']);
  // The back office is the frame's page at /admin, without a button of its own.
  const office = json.apps.find((a) => a.name === 'back-office');
  assert.deepEqual([office.mountPath, office.rail, office.apiOnly], ['/admin', false, false]);

  for (const url of ['/admin', '/customers', '/marketing', '/payments']) {
    const page = await t.get(url, { as: 'ops-support' });
    assert.equal(page.status, 200, url);
    assert.match(page.text, /id="noobly-rail"/, url);
  }
  for (const url of ['/js/operator/embed.js', '/js/operator/back-office.js', '/css/operator.css']) assert.equal((await t.get(url)).status, 200, url);
  // The accelerators' own pages still answer where they are, for links and bookmarks.
  for (const url of ['/admin/customer/', '/admin/marketing/', '/admin/payments/']) {
    const page = await t.get(url, { as: 'ops-platform' });
    assert.equal(page.status, 200, url);
    assert.doesNotMatch(page.text, /id="noobly-rail"/, url);
  }
});

test('the back office lists customers, marketing, payments and infrastructure as mounted, in the rail\'s order', async () => {
  const res = await t.get('/api/v1/admin/accelerators', { as: 'ops-platform' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map((a) => [a.name, a.state, a.href]), [
    ['customers', 'mounted', '/customers'], ['marketing', 'mounted', '/marketing'], ['payments', 'mounted', '/payments'], ['infrastructure', 'mounted', '/infrastructure'],
  ]);
  const byName = Object.fromEntries(res.json.items.map((a) => [a.name, a]));
  assert.deepEqual(byName.payments.links, ['/admin/payments/']);
  // Its operator screens are for operators; its public paths (webhooks, hosted invoices, the card form) are open.
  assert.equal((await t.get('/admin/payments/', { as: 'ops-platform' })).status, 200);
  assert.equal((await t.get('/admin/payments/', { as: 'stevie' })).status, 404);
  assert.equal((await t.get('/admin/payments/api/v1/overview', { as: 'stevie' })).status, 404);
  assert.equal((await t.get('/admin/payments/api/v1/overview', { as: 'ops-platform' })).status, 200);
  assert.equal((await t.get('/admin/payments/components/card-form.js')).status, 200);
  assert.equal((await t.get('/admin/payments/p/invoices/not-a-token')).status, 404);
  assert.equal((await t.get('/admin/payments-not/components/card-form.js')).status, 302, 'only the exact public prefixes');
});

test('infrastructure events reach the shared EventEmitter (mount() mirrors them)', async () => {
  const seen = [];
  const { mounted } = t.accelerators;
  assert.ok(mounted.infrastructure.shutdown, 'the description has shutdown()');
  const listener = (payload) => seen.push(payload);
  // Connecting an account emits infrastructure.account.connected once the mock cloud has made its network.
  const emitter = t.eventEmitter;
  emitter.on('infrastructure.account.connected', listener);
  const res = await t.post('/infrastructure/api/v1/accounts', {
    as: 'ops-platform',
    body: { cloud: 'gcp', name: 'hero-dev', projectId: 'hero-dev-1', defaultRegion: 'europe-west2', credentials: JSON.stringify({ type: 'service_account', project_id: 'hero-dev', private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n' }) },
  });
  assert.equal(res.status, 202);
  await mounted.infrastructure.idle();
  emitter.off('infrastructure.account.connected', listener);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'hero-dev');
});
