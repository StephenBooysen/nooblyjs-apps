// Workflows (roadmap 5.4), offline with the in-process mock agent: create one on the Local network with tasks and a
// concurrency; Run a task with input and it runs in a container of its own with TASK_NAME, TASK_INPUT, TASK_RUN_ID and
// TASK_ATTEMPT; runs past the concurrency wait in the queue and start as others end; a queued run can be cancelled; a
// failed run is tried again after a backoff until its retries are spent; tasks and concurrency change without a
// rebuild; a suspended Workflow keeps its queue; code triggers a task with the Workflow's key; the dashboard shows
// Tasks running and Queue. Another workspace, or a service that is not a Workflow, is a 404.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let t;
const WS = '/api/v1/workspaces/exclusivity-life';
const SVC = `${WS}/services/mailer`;
const infra = () => t.accelerators.mounted.infrastructure;
const docker = () => infra().local.agent.docker;
const lines = async (q = '') => (await t.get(`${SVC}/logs${q}`, { as: 'stevie' })).json.lines.map((l) => l.line);
const tasks = async () => (await t.get(`${SVC}/tasks`, { as: 'stevie' })).json;
const run = (task, input, as = 'stevie') => t.post(`${SVC}/tasks/${task}/runs`, { as, body: input === undefined ? {} : { input } });
/** The platform and our queue hand work to each other: idle until neither has anything left. */
const settle = async () => { for (let i = 0; i < 6; i += 1) await t.idle(); };
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};
const TASKS = [
  { name: 'send-email', command: 'node tasks/send-email.js', retries: 2 },
  { name: 'flaky', command: 'node tasks/flaky.js; exit 3', retries: 1 },
];
const body = (over = {}) => ({
  type: 'workflow', name: 'mailer', repoUrl: 'https://github.com/render-examples/express-hello-world', branch: 'main',
  region: 'local', runtime: 'node22', plan: 'starter', tasks: TASKS, concurrency: 3, env: [], ...over,
});
const envOf = (job) => Object.fromEntries(job.env.map((e) => [e.key, e.value]));

before(async () => {
  t = await startApp();
  await infra().local.agent.welcome;
});
after(async () => { await t?.close(); });

test('5.4 create: tasks and concurrency are checked, kept, and the platform gets a job that runs that many at once', async () => {
  for (const [over, path, message] of [
    [{ tasks: [] }, 'tasks', /From 1 to 20 tasks/],
    [{ tasks: [{ name: 'Send Email', command: 'x' }] }, 'tasks.0.name', /Lower-case letters/],
    [{ tasks: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] }, 'tasks.1.name', /named twice/],
    [{ tasks: [{ name: 'a', command: '' }] }, 'tasks.0.command', /command this task runs/],
    [{ tasks: [{ name: 'a', command: 'x', retries: 9 }] }, 'tasks.0.retries', /From 0 to 5/],
    [{ concurrency: 0 }, 'concurrency', /From 1 to 10/],
    [{ concurrency: 11 }, 'concurrency', /From 1 to 10/],
  ]) {
    const r = await t.post(`${WS}/services`, { as: 'stevie', body: body(over) });
    assert.equal(r.status, 422, JSON.stringify(over));
    const d = r.json.error.details.find((x) => x.path === path);
    assert.match(d?.message ?? '', message, JSON.stringify(r.json.error.details));
  }
  const res = await t.post(`${WS}/services`, { as: 'stevie', body: body() });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await settle();
  const svc = (await t.get(SVC, { as: 'stevie' })).json;
  assert.deepEqual([svc.type, svc.typeLabel, svc.status, svc.concurrency, svc.url, svc.triggerKey], ['workflow', 'Workflow', 'live', 3, null, null]);
  assert.deepEqual(svc.tasks, TASKS);
  const w = await t.platform().workloads.get('exclusivity-life', 'mailer');
  assert.deepEqual([w.kind, w.concurrency, w.schedule, w.instances], ['job', 3, null, 1]);
  const got = await tasks();
  assert.deepEqual([got.concurrency, got.counts.running, got.counts.queued, got.counts.queueLimit, got.limitMb, got.runs], [3, 0, 0, 1000, 512, []]);
  assert.deepEqual(got.env, ['TASK_NAME', 'TASK_INPUT', 'TASK_RUN_ID', 'TASK_ATTEMPT']);
  assert.equal(got.trigger.url, `${t.base}/api/v1/tasks/exclusivity-life/mailer/:task/runs`);
});

test('5.4 Run a task: its own container, with its name, input, run id and attempt; the run and the logs say how it went', async () => {
  assert.equal((await run('nope')).status, 404);
  const big = await run('send-email', { blob: 'x'.repeat(17 * 1024) });
  assert.ok([413, 422].includes(big.status), `too much input: ${big.status}`);
  const before = docker().jobs.length;
  const res = await run('send-email', { to: 'ada@example.com', order: 42 });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.deepEqual([res.json.run.task, res.json.run.status, res.json.run.attempt, res.json.run.maxAttempts, res.json.run.by], ['send-email', 'running', 1, 3, 'Stevie']);
  await settle();
  const [r] = (await tasks()).runs;
  assert.deepEqual([r.id, r.status, r.exitCode, r.peakMemoryMb, r.trigger], [res.json.run.id, 'succeeded', 0, 32, 'manual']);
  assert.deepEqual(r.input, { to: 'ada@example.com', order: 42 });
  assert.ok(r.startedAt && r.finishedAt && typeof r.durationMs === 'number');
  const job = docker().jobs.at(-1);
  assert.equal(docker().jobs.length, before + 1);
  assert.deepEqual(job.command, ['/bin/sh', '-c', 'node tasks/send-email.js']);
  const env = envOf(job);
  assert.deepEqual([env.TASK_NAME, JSON.parse(env.TASK_INPUT), env.TASK_RUN_ID, env.TASK_ATTEMPT], ['send-email', { to: 'ada@example.com', order: 42 }, r.id, '1']);
  const got = await lines();
  assert.ok(got.includes('Task send-email started (attempt 1 of 3, by Stevie).'), JSON.stringify(got));
  assert.ok(got.some((l) => /^Task send-email succeeded: exit code 0 after less than a second, at most 32 MB of 512 MB\.$/.test(l)), JSON.stringify(got));
  const one = (await t.get(`${SVC}/task-runs/${r.id}`, { as: 'stevie' })).json;
  assert.deepEqual(one.attempts.map((a) => a.status), ['succeeded']);
  assert.ok(one.attempts[0].log.some((l) => /Exited with code 0/.test(l.text)), JSON.stringify(one.attempts[0].log));
  assert.ok(t.host.auditLog.some((a) => a.action === 'service.task-queued' && a.detail?.run === r.id));
  assert.equal((await t.get(`${SVC}/task-runs/trn_nope`, { as: 'stevie' })).status, 404);
});

test('5.4 past the concurrency runs wait in the queue and start as others end; a waiting run can be cancelled', async () => {
  const release = docker().holdJobs();
  const ids = [];
  for (let i = 1; i <= 5; i += 1) ids.push((await run('send-email', { n: i })).json.run);
  assert.deepEqual(ids.map((r) => r.status), ['running', 'running', 'running', 'queued', 'queued']);
  let got = await tasks();
  assert.deepEqual([got.counts.running, got.counts.queued], [3, 2]);
  const card = (await t.get(`${WS}/dashboard`, { as: 'stevie' })).json.cards.find((c) => c.name === 'mailer');
  assert.deepEqual([card.tasks.running, card.tasks.queued, card.tasks.concurrency, card.tasks.queueLimit, card.tasks.tasks], [3, 2, 3, 1000, 2]);
  assert.ok(await until(() => docker().jobs.filter((j) => JSON.parse(envOf(j).TASK_INPUT)?.n).length === 3), 'three containers, side by side');

  const cancelled = await t.post(`${SVC}/task-runs/${ids[4].id}/cancel`, { as: 'stevie', body: {} });
  assert.deepEqual([cancelled.status, cancelled.json.run.status], [200, 'cancelled']);
  const busy = await t.post(`${SVC}/task-runs/${ids[0].id}/cancel`, { as: 'stevie', body: {} });
  assert.deepEqual([busy.status, busy.json.error.message], [409, 'It is running: it ends when its command ends.']);
  release();
  await settle();
  got = await tasks();
  const byId = new Map(got.runs.map((r) => [r.id, r]));
  assert.deepEqual(ids.map((r) => byId.get(r.id).status), ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'cancelled']);
  assert.deepEqual([got.counts.running, got.counts.queued], [0, 0]);
  const fourth = docker().jobs.find((j) => JSON.parse(envOf(j).TASK_INPUT)?.n === 4);
  assert.ok(fourth, 'the fourth ran once a place was free');
  assert.ok(!docker().jobs.some((j) => JSON.parse(envOf(j).TASK_INPUT)?.n === 5), 'the cancelled one never ran');
  assert.ok((await lines()).some((l) => /^Task send-email cancelled by Stevie before it started\.$/.test(l)));
});

test('5.4 a failed run is tried again after a backoff, then fails for good; each attempt keeps its log', async () => {
  const res = await run('flaky', { why: 'retry' });
  assert.equal(res.status, 202);
  await settle();
  let [r] = (await tasks()).runs;
  assert.deepEqual([r.status, r.attempt, r.maxAttempts, r.exitCode], ['retrying', 1, 2, 3]);
  assert.match(r.reason, /exited with code 3/);
  const wait = Date.parse(r.nextAttemptAt) - Date.now();
  assert.ok(wait > 5_000 && wait <= 10_000, `waits about 10 s (${wait} ms)`);
  assert.ok((await lines('?level=warn')).some((l) => /^Task flaky failed: The job exited with code 3 \(.*\)\. Trying again in 10 s \(attempt 2 of 2\)\.$/.test(l)));
  assert.deepEqual(await t.tasks.tick(new Date()), [], 'not before its time');
  assert.deepEqual(await t.tasks.tick(new Date(Date.now() + 11_000)), [r.id]);
  await settle();
  [r] = (await tasks()).runs;
  assert.deepEqual([r.status, r.attempt, r.exitCode], ['failed', 2, 3]);
  assert.equal(envOf(docker().jobs.at(-1)).TASK_ATTEMPT, '2');
  assert.ok((await lines('?level=error')).some((l) => /^Task flaky failed after 2 attempts: The job exited with code 3/.test(l)));
  const one = (await t.get(`${SVC}/task-runs/${r.id}`, { as: 'stevie' })).json;
  assert.deepEqual(one.attempts.map((a) => [a.attempt, a.status]), [[1, 'failed'], [2, 'failed']]);
});

test('5.4 tasks and concurrency change without a rebuild; a suspended Workflow keeps its queue until it resumes', async () => {
  const deploys = (await t.get(`${SVC}/deploys`, { as: 'stevie' })).json.deploys.length;
  assert.equal((await t.call('PUT', `${SVC}/tasks`, { as: 'stevie', body: {} })).status, 422);
  assert.equal((await t.call('PUT', `${SVC}/tasks`, { as: 'stevie', body: { concurrency: 50 } })).json.error.details[0].path, 'concurrency');
  const res = await t.call('PUT', `${SVC}/tasks`, { as: 'stevie', body: { tasks: [...TASKS, { name: 'resize', command: 'node tasks/resize.js', retries: 0 }], concurrency: 1 } });
  assert.deepEqual([res.status, res.json.changed, res.json.concurrency, res.json.tasks.length], [200, true, 1, 3]);
  await settle();
  assert.equal((await t.get(`${SVC}/deploys`, { as: 'stevie' })).json.deploys.length, deploys, 'no rebuild');
  assert.equal((await t.platform().workloads.get('exclusivity-life', 'mailer')).concurrency, 1);
  assert.ok(t.host.auditLog.some((a) => a.action === 'service.tasks-changed' && a.detail?.concurrency === 1));

  await t.post(`${SVC}/suspend`, { as: 'stevie', body: {} });
  await settle();
  const waiting = (await run('resize', { w: 100 })).json.run;
  assert.equal(waiting.status, 'queued', 'a suspended Workflow starts nothing');
  await t.tasks.tick(new Date());
  assert.equal((await tasks()).runs[0].status, 'queued');
  await t.post(`${SVC}/resume`, { as: 'stevie', body: {} });
  await settle();
  await t.tasks.tick(new Date());
  await settle();
  const [r] = (await tasks()).runs;
  assert.deepEqual([r.id, r.status, r.maxAttempts], [waiting.id, 'succeeded', 1]);
});

test('5.4 code triggers a task with the Workflow\'s key; a wrong, old or missing key is a 401', async () => {
  const created = await t.post(`${SVC}/trigger-key`, { as: 'stevie', body: {} });
  assert.equal(created.status, 201);
  const key = created.json.key;
  assert.match(key, /^ntk_[A-Za-z0-9_-]{43}$/);
  const svc = (await t.get(SVC, { as: 'stevie' })).json;
  assert.deepEqual([svc.triggerKey.hint, svc.triggerKey.createdBy.name], [key.slice(-4), 'Stevie']);
  assert.ok(!JSON.stringify(svc).includes(key) && !JSON.stringify(await tasks()).includes('hash'), 'never the key or its hash again');

  const url = '/api/v1/tasks/exclusivity-life/mailer/send-email/runs';
  const bearer = (k) => ({ authorization: `Bearer ${k}` });
  const res = await t.post(url, { headers: bearer(key), body: { input: { from: 'api' } } });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.deepEqual([res.json.run.trigger, res.json.run.by], ['api', 'API']);
  await settle();
  const polled = await t.get(`/api/v1/tasks/exclusivity-life/mailer/runs/${res.json.run.id}`, { headers: bearer(key) });
  assert.deepEqual([polled.status, polled.json.run.status, polled.json.run.input], [200, 'succeeded', { from: 'api' }]);
  assert.ok((await lines()).includes('Task send-email started (attempt 1 of 3, through the API).'));
  assert.equal((await t.post('/api/v1/tasks/exclusivity-life/mailer/nope/runs', { headers: bearer(key), body: {} })).status, 404);

  for (const [what, u, headers] of [
    ['no key', url, {}],
    ['a wrong key', url, bearer(`ntk_${'A'.repeat(43)}`)],
    ['another service', '/api/v1/tasks/exclusivity-life/api/send-email/runs', bearer(key)],
    ['another workspace', '/api/v1/tasks/amara-labs/mailer/send-email/runs', bearer(key)],
    ['a signed-in person without the key', url, { 'x-dev-person': 'stevie' }],
  ]) {
    const r = await t.post(u, { headers, body: {} });
    assert.equal(r.status, 401, what);
    assert.match(r.json.error.message, /trigger key does not match/);
  }
  const replaced = (await t.post(`${SVC}/trigger-key`, { as: 'stevie', body: {} })).json.key;
  assert.equal((await t.post(url, { headers: bearer(key), body: {} })).status, 401, 'the old key stops working');
  assert.equal((await t.del(`${SVC}/trigger-key`, { as: 'stevie' })).status, 204);
  assert.equal((await t.post(url, { headers: bearer(replaced), body: {} })).status, 401, 'no key, no trigger');
  await settle();
  assert.ok(['service.trigger-key-created', 'service.trigger-key-replaced', 'service.trigger-key-removed'].every((a) => t.host.auditLog.some((x) => x.action === a)));
});

test('5.4 not a Workflow, or another workspace: 404; a Workflow scales by type only', async () => {
  assert.equal((await t.get(`${WS}/services/api/tasks`, { as: 'stevie' })).status, 404, 'a web service has no tasks');
  for (const [method, path] of [['GET', '/tasks'], ['PUT', '/tasks'], ['POST', '/tasks/send-email/runs'], ['POST', '/trigger-key'], ['DELETE', '/trigger-key'], ['POST', '/task-runs/trn_x/cancel'], ['GET', '/task-runs/trn_x']]) {
    const r = await t.call(method, `${SVC}${path}`, { as: 'amara', ...(['GET', 'DELETE'].includes(method) ? {} : { body: {} }) });
    assert.equal(r.status, 404, `${method} ${path} for another workspace`);
  }
  const two = await t.post(`${SVC}/scale`, { as: 'stevie', body: { instances: 2 } });
  assert.deepEqual([two.status, two.json.error.details[0].path], [422, 'instances']);
  assert.match(two.json.error.details[0].message, /no instances/);
});
