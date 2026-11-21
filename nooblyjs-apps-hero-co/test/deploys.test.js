// Phase 3 (roadmap 3.8–3.11) through the API, on the infrastructure accelerator's mock platform and the mock GitHub:
// a push deploys (the webhook is signed per workspace, filtered by branch, and a redelivery deploys once); Manual
// deploy, Restart, Suspend and Resume; a Private Service's internal name and a worker with no URL; "is full" in the
// customer's words; idle sleep on cloud web services only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, connectGithub } from './helpers.js';
import { toWorkloadSpec, customerReason } from '../src/platform/workloads.js';
import { mockTokenFor } from '../src/github/mock-data.js';

let t;
before(async () => {
  t = await startApp();
  await t.accounts.addMember('exclusivity-life', 'amara', 'Member');
  const done = await connectGithub(t, 'stevie', 'exclusivity-life', 'stevie');
  assert.equal(done.location, '/w/exclusivity-life/github?connected=1');
});
after(async () => { await t?.close(); });

const WS = '/api/v1/workspaces/exclusivity-life';
const service = (over = {}) => ({
  type: 'web', name: 'blog', repo: 'stevie/nooblyjs-blog', branch: 'main', region: 'af-south', runtime: 'node22',
  startCommand: 'npm start', plan: 'standard', instances: 2, env: [], autoDeploy: true, ...over,
});
const deploysOf = async (name) => (await t.get(`${WS}/services/${name}/deploys`, { as: 'stevie' })).json.deploys;

/** Sends GitHub's request for `event`, signed with `secret` (or a given signature). */
async function deliver(workspace, payload, { event = 'push', secret, signature, delivery = crypto.randomUUID() } = {}) {
  const body = JSON.stringify(payload);
  const sig = signature ?? `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  const res = await fetch(`${t.base}/hooks/github/${workspace}`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': sig },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const push = (branch, sha, message = 'Fix the header') => ({
  ref: `refs/heads/${branch}`, after: sha, deleted: false, repository: { full_name: 'stevie/nooblyjs-blog' },
  pusher: { name: 'stevie' }, head_commit: { id: sha, message: `${message}\n\nThe longer story.` },
});

test('3.8 creating a service adds a signed push webhook; a push to its branch deploys that commit, once', async () => {
  const created = await t.post(`${WS}/services`, { as: 'amara', body: service() });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await t.idle();
  assert.deepEqual((await t.get(`${WS}/services/blog`, { as: 'stevie' })).json.webhook.ok, true);

  // The hook is on the repository, pointing at this workspace's URL, with a secret GitHub keeps.
  const hooks = await fetch(`${t.base}/dev/github/api/repos/stevie/nooblyjs-blog/hooks`, { headers: { Authorization: `Bearer ${mockTokenFor('stevie')}` } }).then((r) => r.json());
  assert.deepEqual(hooks.map((h) => [h.config.url, h.events, h.config.content_type]), [[`${t.base}/hooks/github/exclusivity-life`, ['push'], 'json']]);

  // A push through the mock GitHub: delivered, signed, and it deploys.
  const pushed = await t.post('/dev/github/push', { body: { repo: 'stevie/nooblyjs-blog', branch: 'main', message: 'Fix the header' } });
  assert.deepEqual(pushed.json.deliveries.map((d) => d.status), [202]);
  await t.idle();
  const [latest, first] = await deploysOf('blog');
  assert.deepEqual([latest.trigger, latest.commit, latest.message, latest.by?.name, latest.status], ['push', pushed.json.commit.sha, 'Fix the header', 'stevie', 'live']);
  assert.equal(first.status, 'superseded');

  // A push to another branch, a branch deletion, and a tag deploy nothing.
  const secret = await t.github.webhookSecret('exclusivity-life');
  const sha = 'a'.repeat(40);
  assert.deepEqual((await deliver('exclusivity-life', push('develop', sha), { secret })).json, { deploys: [] });
  assert.equal((await deliver('exclusivity-life', { ...push('main', sha), deleted: true }, { secret })).json.deploys.length, 0);
  assert.equal((await deliver('exclusivity-life', { ...push('main', sha), ref: 'refs/tags/v1' }, { secret })).json.deploys.length, 0);
  assert.deepEqual((await deliver('exclusivity-life', { zen: 'Keep it logically awesome.', hook_id: 1 }, { secret, event: 'ping' })).json, { ok: true }, 'GitHub pings a new hook');

  // The same delivery twice: one deploy.
  const once = await deliver('exclusivity-life', push('main', 'b'.repeat(40)), { secret, delivery: 'delivery-1' });
  const twice = await deliver('exclusivity-life', push('main', 'b'.repeat(40)), { secret, delivery: 'delivery-1' });
  assert.deepEqual([once.status, once.json.deploys, twice.json.duplicate], [202, [{ service: 'blog', started: true }], true]);
  await t.idle();
  assert.equal((await deploysOf('blog')).filter((d) => d.commit === 'b'.repeat(40)).length, 1);

  // A wrong signature, another workspace's URL, or no signature: 401, and the same answer for each.
  const forged = await deliver('exclusivity-life', push('main', 'c'.repeat(40)), { signature: `sha256=${'0'.repeat(64)}` });
  const elsewhere = await deliver('amara-labs', push('main', 'c'.repeat(40)), { secret });
  const unsigned = await deliver('exclusivity-life', push('main', 'c'.repeat(40)), { signature: '' });
  assert.deepEqual([forged.status, elsewhere.status, unsigned.status], [401, 401, 401]);
  assert.deepEqual(forged.json, elsewhere.json);
  assert.ok(t.host.auditLog.some((r) => r.action === 'service.deployed' && r.actor === 'github:stevie'));
});

test('3.8 Manual deploy, Restart, Suspend and Resume; a suspended service ignores pushes', async () => {
  const deploy = await t.post(`${WS}/services/blog/deploys`, { as: 'amara', body: {} });
  assert.equal(deploy.status, 202, JSON.stringify(deploy.json));
  await t.idle();
  const [manual] = await deploysOf('blog');
  assert.deepEqual([manual.trigger, manual.by?.name, manual.status, manual.message], ['manual', 'Amara', 'live', 'Latest on main']);

  assert.equal((await t.post(`${WS}/services/blog/restart`, { as: 'amara', body: {} })).status, 202);
  await t.idle();
  assert.equal((await t.post(`${WS}/services/blog/suspend`, { as: 'amara', body: {} })).status, 202);
  await t.idle();
  assert.equal((await t.get(`${WS}/services/blog`, { as: 'stevie' })).json.status, 'suspended');

  const secret = await t.github.webhookSecret('exclusivity-life');
  assert.deepEqual((await deliver('exclusivity-life', push('main', 'd'.repeat(40)), { secret })).json.deploys, [{ service: 'blog', skipped: 'suspended' }]);
  const refused = await t.post(`${WS}/services/blog/deploys`, { as: 'amara', body: {} });
  assert.deepEqual([refused.status, refused.json.error.message], [409, 'blog is suspended. Resume it to deploy.']);
  assert.deepEqual((await t.post(`${WS}/services/blog/restart`, { as: 'amara', body: {} })).json.error.message, 'blog is suspended. Resume it instead.');

  assert.equal((await t.post(`${WS}/services/blog/resume`, { as: 'stevie', body: {} })).status, 202);
  await t.idle();
  assert.equal((await t.get(`${WS}/services/blog`, { as: 'stevie' })).json.status, 'live');
  for (const action of ['service.deployed', 'service.restarted', 'service.suspended', 'service.resumed']) {
    assert.ok(t.host.auditLog.some((r) => r.action === action && r.detail?.service === 'blog'), action);
  }
  assert.equal((await t.post(`${WS}/services/nothing/restart`, { as: 'stevie', body: {} })).status, 404);
});

test('3.9 a Private Service shows its internal name; a worker has no URL; 3.11 only cloud web services sleep', async () => {
  for (const body of [service({ type: 'private', name: 'api', repo: 'stevie/space-trader' }), service({ type: 'worker', name: 'jobs', repo: 'stevie/space-trader', instances: 1 })]) {
    const res = await t.post(`${WS}/services`, { as: 'stevie', body });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
  await t.idle();
  const api = (await t.get(`${WS}/services/api`, { as: 'stevie' })).json;
  const jobs = (await t.get(`${WS}/services/jobs`, { as: 'stevie' })).json;
  const blog = (await t.get(`${WS}/services/blog`, { as: 'stevie' })).json;
  assert.deepEqual([api.internalHost, api.url, api.sleepsWhenIdle], ['api.exclusivity-life.internal:10000', null, false]);
  assert.deepEqual([jobs.internalHost ?? null, jobs.url, jobs.sleepsWhenIdle], [null, null, false]);
  assert.equal(blog.sleepsWhenIdle, true);

  // The platform: the web service sleeps after 15 minutes; the private service and the worker never do.
  const w = (name) => t.platform().workloads.get('exclusivity-life', name);
  assert.deepEqual([(await w('blog')).sleep, (await w('api')).sleep ?? null, (await w('jobs')).sleep ?? null], [{ afterMin: 15 }, null, null]);
  // A Local network service has no ingress to wake it: it never sleeps either.
  const local = toWorkloadSpec({ id: 's', workspaceId: 'a', name: 'w', type: 'web', region: 'local', plan: 'starter', instances: 1, source: { repo: 'a/b', branch: 'main' }, build: { runtime: 'node22' } }, { appDomain: 'x.app' });
  assert.equal(local.sleep, undefined);
});

test('3.11 a sleeping service says so; the platform\'s status reaches the page', async () => {
  t.eventEmitter.emit('infrastructure.workload.status', { tenantId: 'exclusivity-life', workload: 'blog', status: 'sleeping', was: 'live' });
  await t.idle();
  assert.equal((await t.get(`${WS}/services/blog`, { as: 'stevie' })).json.status, 'sleeping');
  t.eventEmitter.emit('infrastructure.workload.status', { tenantId: 'exclusivity-life', workload: 'blog', status: 'live', was: 'sleeping' });
  await t.idle();
});

test('3.10 a full region is named as the customer chose it, on the form and on a failed deploy', async () => {
  const reason = 'Region af-south-1 is full: there is no room for 2 instances of 1 CPU and 2048 MB.';
  assert.equal(customerReason(reason, { region: 'af-south' }), 'Johannesburg is full right now: there is no room for 2 instances of 1 CPU and 2048 MB. Deploy again in a few minutes, or choose a smaller instance type.');
  assert.equal(customerReason('The build failed.', { region: 'af-south' }), 'The build failed.');

  // The platform refuses at create time.
  const workloads = t.platform().workloads;
  const create = workloads.create;
  workloads.create = async () => { throw Object.assign(new Error(reason), { code: 'quota' }); };
  try {
    const res = await t.post(`${WS}/services`, { as: 'stevie', body: service({ name: 'shop' }) });
    assert.equal(res.status, 422);
    assert.deepEqual(res.json.error.details, [{ path: 'region', message: 'Johannesburg is full right now. Try again in a few minutes, or choose another region.' }]);
    assert.equal((await t.get(`${WS}/services/shop`, { as: 'stevie' })).status, 404, 'nothing half-made');
  } finally {
    workloads.create = create;
  }

  // Or the deploy fails when it finds no room.
  t.eventEmitter.emit('infrastructure.deploy.failed', { tenantId: 'exclusivity-life', workload: 'jobs', deployId: 'dep_full', reason });
  await t.idle();
  const failed = (await deploysOf('jobs')).find((d) => d.id === 'dep_full');
  assert.equal(failed.reason, 'Johannesburg is full right now: there is no room for 2 instances of 1 CPU and 2048 MB. Deploy again in a few minutes, or choose a smaller instance type.');
});

test('infra 6.9 an operator app\'s push webhook reaches the infrastructure accelerator without a sign-in; nothing else there does', async () => {
  const hook = await fetch(`${t.base}/infrastructure/hooks/git/storefront`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'x-github-event': 'push' }, body: '{}' });
  assert.equal(hook.status, 401, 'the accelerator answers: the signature is the proof');
  assert.deepEqual((await hook.json()).error.code, 'signature');
  const write = await fetch(`${t.base}/infrastructure/api/v1/apps`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok([302, 303, 401, 403, 404].includes(write.status), `a signed-out write is refused by the gate (got ${write.status})`);
  const get = await fetch(`${t.base}/infrastructure/hooks/git/storefront`, { redirect: 'manual' });
  assert.notEqual(get.status, 200, 'only POST is open');
});
