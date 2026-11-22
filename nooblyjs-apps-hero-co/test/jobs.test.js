// Cron Jobs (roadmap 5.3), offline with the in-process mock agent: create one on the Local network with a UTC schedule
// and a command; the scheduler runs it when its minute comes (once), skips a fire while a run is still going and says
// so in the logs; Run now; a run's output, start and end are in the service's logs; runs list with exit code, duration
// and peak memory; the schedule and command change without a rebuild; only the instance type scales. Another
// workspace, or a service that is not a Cron Job, is a 404.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let t;
const WS = '/api/v1/workspaces/exclusivity-life';
const SVC = `${WS}/services/nightly`;
const infra = () => t.accelerators.mounted.infrastructure;
const docker = () => infra().local.agent.docker;
const lines = async (q = '') => (await t.get(`${SVC}/logs${q}`, { as: 'stevie' })).json.lines.map((l) => l.line);
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};
const body = (over = {}) => ({
  type: 'cron', name: 'nightly', repoUrl: 'https://github.com/render-examples/express-hello-world', branch: 'main',
  region: 'local', runtime: 'node22', plan: 'starter', schedule: '*/5 * * * *', command: 'node task.js', env: [], ...over,
});

before(async () => {
  t = await startApp();
  await infra().local.agent.welcome;
});
after(async () => { await t?.close(); });

test('5.3 create: the schedule and command are checked, kept, and given to the platform with the job', async () => {
  for (const [over, path, message] of [
    [{ schedule: '0 2 * *' }, 'schedule', /five fields/],
    [{ schedule: '0 25 * * *' }, 'schedule', /hour field goes from 0 to 23/],
    [{ command: '' }, 'command', /command each run starts/],
    [{ command: 'a\nb' }, 'command', /One line/],
  ]) {
    const r = await t.post(`${WS}/services`, { as: 'stevie', body: body(over) });
    assert.equal(r.status, 422, JSON.stringify(over));
    const d = r.json.error.details.find((x) => x.path === path);
    assert.match(d?.message ?? '', message);
  }
  const res = await t.post(`${WS}/services`, { as: 'stevie', body: body({ schedule: ' */5  * * * * ' }) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await t.idle();
  const svc = (await t.get(SVC, { as: 'stevie' })).json;
  assert.deepEqual([svc.type, svc.typeLabel, svc.status, svc.schedule, svc.command, svc.scheduleText], ['cron', 'Cron Job', 'live', '*/5 * * * *', 'node task.js', 'Every 5 minutes']);
  assert.equal(svc.nextRuns.length, 3);
  assert.equal(svc.url, null, 'a cron job has no URL');
  const w = await t.platform().workloads.get('exclusivity-life', 'nightly');
  assert.deepEqual([w.kind, w.schedule, w.run.command, w.instances, w.plan.memoryMb], ['job', '*/5 * * * *', 'node task.js', 1, 512]);
  assert.equal((await infra().local.runtime.list()).filter((c) => c.labels['noobly-workload'] === 'nightly').length, 0, 'nothing runs between runs');

  const runs = (await t.get(`${SVC}/runs`, { as: 'stevie' })).json;
  assert.deepEqual([runs.schedule.expression, runs.schedule.text, runs.schedule.command, runs.schedule.limitMb, runs.runs], ['*/5 * * * *', 'Every 5 minutes', 'node task.js', 512, []]);
});

test('5.3 the scheduler runs it in its minute, once; the run is in the runs list and the logs', async () => {
  assert.deepEqual(await t.cron.tick(new Date('2026-11-22T10:03:00Z')), [], 'not its minute');
  const events = [];
  const stop = t.realtime.subscribe(['exclusivity-life'], (e) => events.push(e));
  assert.deepEqual(await t.cron.tick(new Date('2026-11-22T10:05:00Z')), ['nightly']);
  assert.deepEqual(await t.cron.tick(new Date('2026-11-22T10:05:40Z')), [], 'a second tick in the same minute does nothing');
  await t.idle();
  stop();
  const { runs } = (await t.get(`${SVC}/runs`, { as: 'stevie' })).json;
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].status, runs[0].trigger, runs[0].by, runs[0].exitCode, runs[0].peakMemoryMb, runs[0].command], ['succeeded', 'schedule', 'Schedule', 0, 32, 'node task.js']);
  assert.ok(runs[0].startedAt && runs[0].finishedAt && typeof runs[0].durationMs === 'number');
  assert.deepEqual(events.filter((e) => e.type === 'run').map((e) => e.data.run.status), ['running', 'succeeded']);

  const got = await lines();
  for (const line of ['Run started by the schedule.', 'Running /bin/sh -c node task.js', 'Done']) assert.ok(got.includes(line), `${line} in ${JSON.stringify(got)}`);
  assert.ok(got.some((l) => /^Run succeeded: exit code 0 after less than a second, at most 32 MB of 512 MB\.$/.test(l)), JSON.stringify(got));

  // Its log is its own output and our lines about it, from the service's logs, with their levels.
  const one = (await t.get(`${SVC}/runs/${runs[0].id}`, { as: 'stevie' })).json;
  const texts = one.log.map((l) => l.text);
  assert.ok(texts.includes('Run started by the schedule.') && texts.includes('Done') && texts.some((l) => /^Run succeeded/.test(l)), JSON.stringify(texts));
  assert.ok(one.log.every((l) => l.level && l.level !== 'build' && l.at), 'no build lines; every line has its level');
  assert.equal((await t.get(`${SVC}/runs/op_nope`, { as: 'stevie' })).status, 404);
});

test('5.3 Run now; a fire while a run is going is skipped and said; a second Run now is refused', async () => {
  const release = docker().holdJobs();
  const now = await t.post(`${SVC}/runs`, { as: 'stevie', body: {} });
  assert.equal(now.status, 202, JSON.stringify(now.json));
  assert.ok(await until(async () => (await t.get(`${SVC}/runs`, { as: 'stevie' })).json.runs[0]?.status === 'running'));
  assert.deepEqual(await t.cron.tick(new Date('2026-11-22T10:10:00Z')), []);
  assert.ok((await lines('?level=warn')).includes('Skipped the 10:10 UTC run: the previous run is still going.'));
  const again = await t.post(`${SVC}/runs`, { as: 'stevie', body: {} });
  assert.deepEqual([again.status, again.json.error.message], [409, 'A run is already going. Wait for it to finish.']);
  release();
  await t.idle();
  const { runs } = (await t.get(`${SVC}/runs`, { as: 'stevie' })).json;
  assert.deepEqual([runs.length, runs[0].trigger, runs[0].by, runs[0].status], [2, 'manual', 'Stevie', 'succeeded']);
  assert.ok((await lines()).includes('Run started by hand.'));
  assert.ok(t.host.auditLog.some((r) => r.action === 'service.run-started' && r.detail?.service === 'nightly' && r.detail.run === now.json.run.id));
});

test('5.3 the schedule and command change from the next run, without a rebuild; a failing run says why', async () => {
  const deploysBefore = (await t.get(`${SVC}/deploys`, { as: 'stevie' })).json.deploys.length;
  const bad = await t.patch(`${SVC}/schedule`, { as: 'stevie', body: { schedule: 'every day' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.details[0].path, 'schedule');
  assert.equal((await t.patch(`${SVC}/schedule`, { as: 'stevie', body: {} })).status, 422);
  const res = await t.patch(`${SVC}/schedule`, { as: 'stevie', body: { schedule: '30 9 * * 1-5', command: 'node task.js; exit 3' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual([res.json.changed, res.json.schedule.text, res.json.schedule.command], [true, 'Every weekday (Monday to Friday) at 09:30 UTC', 'node task.js; exit 3']);
  await t.idle();
  assert.equal((await t.get(`${SVC}/deploys`, { as: 'stevie' })).json.deploys.length, deploysBefore, 'no rebuild');
  assert.equal((await t.platform().workloads.get('exclusivity-life', 'nightly')).schedule, '30 9 * * 1-5');
  assert.ok(t.host.auditLog.some((r) => r.action === 'service.schedule-changed' && r.detail?.to?.schedule === '30 9 * * 1-5'));

  assert.deepEqual(await t.cron.tick(new Date('2026-11-22T09:30:00Z')), [], 'a Sunday');
  assert.deepEqual(await t.cron.tick(new Date('2026-11-23T09:30:00Z')), ['nightly'], 'a Monday');
  await t.idle();
  const [last] = (await t.get(`${SVC}/runs`, { as: 'stevie' })).json.runs;
  assert.deepEqual([last.status, last.exitCode, last.command], ['failed', 3, 'node task.js; exit 3']);
  assert.match(last.reason, /exited with code 3/);
  assert.ok((await lines('?level=error')).some((l) => /^Run failed: The job exited with code 3 \(after less than a second, at most 32 MB of 512 MB\)\.$/.test(l)));
  const log = (await t.get(`${SVC}/runs/${last.id}`, { as: 'stevie' })).json.log;
  assert.equal(log.at(-1).level, 'error', 'the failed run\'s last line is an error');
});

test('5.3 only the instance type scales; not a Cron Job or another workspace: 404', async () => {
  const two = await t.post(`${SVC}/scale`, { as: 'stevie', body: { instances: 2 } });
  assert.deepEqual([two.status, two.json.error.details[0].path], [422, 'instances']);
  const plan = await t.post(`${SVC}/scale`, { as: 'stevie', body: { plan: 'standard' } });
  assert.equal(plan.status, 200);
  assert.equal((await t.platform().workloads.get('exclusivity-life', 'nightly')).plan.memoryMb, 2048);
  assert.equal((await t.get(`${SVC}/runs`, { as: 'stevie' })).json.schedule.limitMb, 2048);

  assert.equal((await t.get(`${WS}/services/api/runs`, { as: 'stevie' })).status, 404, 'a web service has no runs');
  for (const [method, path] of [['get', '/runs'], ['post', '/runs'], ['patch', '/schedule']]) {
    assert.equal((await t[method](`${SVC}${path}`, { as: 'amara', ...(method === 'get' ? {} : { body: {} }) })).status, 404, `${method} ${path} for another workspace`);
  }
});
