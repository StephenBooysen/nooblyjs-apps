// The watch screens' API (roadmap 4.1–4.7) for a Local network service, offline with the in-process mock agent: Docker
// stats become the service's metrics and instance tiles, requests through the proxy its Requests and Bandwidth, its
// console lines and build lines searchable logs with levels, files on disk and a download; the dashboard, Deploys,
// Metrics and Logs pages read the same; Scaling calls services.platform.workloads.scale(). Another workspace: 404.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { startApp } from './helpers.js';

let t;
const WS = '/api/v1/workspaces/exclusivity-life';
const SVC = `${WS}/services/watched`;
const infra = () => t.accelerators.mounted.infrastructure;
const docker = () => infra().local.agent.docker;
const containers = async () => (await infra().local.runtime.list()).filter((c) => c.labels['noobly-workload'] === 'watched');
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

before(async () => {
  t = await startApp();
  await infra().local.agent.welcome;
  const res = await t.post(`${WS}/services`, {
    as: 'stevie',
    body: { type: 'web', name: 'watched', repoUrl: 'https://github.com/render-examples/express-hello-world', branch: 'main', region: 'local', runtime: 'node22', plan: 'starter', instances: 2, env: [] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await t.idle();
});
after(async () => { await t?.close(); });

test('4.1 4.2 4.5 Docker stats become the metrics (summed over instances, with the plan\'s limits) and the instance tiles', async () => {
  const list = await containers();
  assert.equal(list.length, 2);
  for (const c of list) docker().setUsage(c.name, { cpu: 0.2, memoryMb: 100, rxBytes: 1000, txBytes: 2000 });
  await infra().local.runtime.statsNow(list[0].server);
  assert.ok(await until(async () => (await t.get(`${SVC}/metrics`, { as: 'stevie' })).json.current.cpu === 0.4), 'both instances counted');

  const m = (await t.get(`${SVC}/metrics?range=1h`, { as: 'stevie' })).json;
  assert.deepEqual([m.limits.cpu, m.limits.memoryMb, m.limits.instances], [1, 1024, 2]);
  assert.deepEqual([m.current.cpu, m.current.memoryMb, m.current.cpuLimit, m.current.memoryLimitMb], [0.4, 200, 1, 1024]);
  assert.equal(m.step, 10_000);
  assert.ok(m.points.some((p) => p.cpu === 0.4 && p.mem === 200));
  for (const range of ['24h', '7d', '30d']) assert.equal((await t.get(`${SVC}/metrics?range=${range}`, { as: 'stevie' })).status, 200, range);
  const bad = await t.get(`${SVC}/metrics?range=1y`, { as: 'stevie' });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.details[0].path, 'range');

  const { instances } = (await t.get(`${SVC}/instances`, { as: 'stevie' })).json;
  assert.equal(instances.length, 2);
  for (const i of instances) {
    assert.match(i.id, /^[a-z0-9]{6}$/);
    assert.deepEqual([i.status, i.restarts, i.cpu.used, i.cpu.limit, i.memory.usedMb, i.memory.limitMb], ['running', 0, 0.2, 0.5, 100, 512]);
    assert.ok(Date.parse(i.startedAt) <= Date.now());
  }
  assert.equal((await t.get(`${SVC}/metrics`, { as: 'amara' })).status, 404, 'another workspace');
  assert.equal((await t.get(`${SVC}/instances`, { as: 'amara' })).status, 404);
});

test('4.2 requests through the proxy are counted, with the bytes sent back and the 5xx, by the minute and for the month', async () => {
  // Stand in for the two containers on their host ports.
  const servers = await Promise.all((await t.platform().workloads.endpoints('exclusivity-life', 'watched')).map(async (e) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/boom') return res.writeHead(500).end('broken');
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello from an instance');
    });
    await new Promise((r) => s.listen(Number(new URL(e.url).port), '127.0.0.1', r));
    return s;
  }));
  try {
    const before_ = (await t.get(`${SVC}/metrics`, { as: 'stevie' })).json;
    let bytes = 0;
    for (const p of ['/', '/', '/boom']) {
      const res = await fetch(`${t.base}/exclusivity-life/watched${p}`);
      bytes += (await res.arrayBuffer()).byteLength;
      assert.equal(res.status, p === '/boom' ? 500 : 200);
    }
    assert.ok(await until(async () => (await t.get(`${SVC}/metrics`, { as: 'stevie' })).json.current.monthRequests === before_.current.monthRequests + 3));
    const now = (await t.get(`${SVC}/metrics`, { as: 'stevie' })).json;
    assert.equal(bytes, 2 * 'hello from an instance'.length + 'broken'.length);
    assert.equal(now.current.monthBytes - before_.current.monthBytes, bytes);
    assert.ok(now.current.reqPerMin >= 3);
    assert.equal(now.totals.requests - before_.totals.requests, 3);
    assert.equal(now.totals.errors - before_.totals.errors, 1, 'the 500');
  } finally {
    for (const s of servers) s.close();
  }
});

test('4.3 logs: levels, search, the build\'s lines, the live channel, files on disk and a download', async () => {
  const [c] = await containers();
  const events = [];
  const stop = t.realtime.subscribe(['exclusivity-life'], (e) => events.push(e));
  docker().emit(c.name, 'WARN disk nearly full', 'stdout');
  docker().emit(c.name, 'Payment provider timeout', 'stderr');
  docker().emit(c.name, '{"level":"info","msg":"order 42 paid"}', 'stdout');
  assert.ok(await until(async () => (await t.get(`${SVC}/logs?q=order%2042`, { as: 'stevie' })).json.lines.length === 1));
  assert.ok(await until(() => events.some((e) => e.type === 'log' && e.data.lines.some((l) => l.line === 'WARN disk nearly full' && l.level === 'warn'))), 'live lines carry their level');
  stop();

  const warn = (await t.get(`${SVC}/logs?level=warn`, { as: 'stevie' })).json.lines;
  assert.deepEqual(warn.map((l) => l.line), ['WARN disk nearly full']);
  assert.equal(warn[0].instance, c.name.slice(-6));
  assert.deepEqual((await t.get(`${SVC}/logs?level=error`, { as: 'stevie' })).json.lines.map((l) => l.line), ['Payment provider timeout'], 'stderr is an error');
  const build = (await t.get(`${SVC}/logs?level=build`, { as: 'stevie' })).json.lines;
  assert.ok(build.some((l) => /Cloning https:\/\/github.com\/render-examples\/express-hello-world/.test(l.line)), 'the deploy\'s build lines');
  assert.ok(build.every((l) => l.instance === 'build'));
  for (const [q, path_] of [['level=loud', 'level'], ['since=yesterday', 'since'], ['limit=0', 'limit']]) {
    const r = await t.get(`${SVC}/logs?${q}`, { as: 'stevie' });
    assert.equal(r.status, 422, q);
    assert.equal(r.json.error.details[0].path, path_);
  }

  const all = (await t.get(`${WS}/logs?service=watched&level=warn,error`, { as: 'stevie' })).json;
  assert.deepEqual(all.lines.map((l) => [l.service, l.level]), [['watched', 'warn'], ['watched', 'error']]);
  assert.equal((await t.get(`${WS}/logs?service=nope`, { as: 'stevie' })).status, 404);
  assert.equal((await t.get(`${WS}/logs`, { as: 'amara' })).status, 404);

  const dl = await t.get(`${SVC}/logs/download?level=error`, { as: 'stevie' });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="watched-logs-[\d-T]+\.txt"$/);
  assert.match(dl.text, /ERROR Payment provider timeout\n$/);

  await t.telemetry.flush();
  const dir = path.join(t.dataDir, 'telemetry', 'logs', 'exclusivity-life', 'watched');
  const files = await fs.readdir(dir);
  assert.ok(files.length >= 1 && files.every((f) => /^\d{4}-\d\d-\d\dT\d\d-\d\d-[0-9a-z]+\.ndjson$/.test(f)), files.join(', '));
  const kept = (await Promise.all(files.map((f) => fs.readFile(path.join(dir, f), 'utf8')))).join('');
  assert.ok(kept.includes('"line":"Payment provider timeout"'));
  await fs.access(path.join(t.dataDir, 'telemetry', 'metrics', 'exclusivity-life', 'watched.json'));
});

test('4.4 4.6 the dashboard, Deploys and Metrics pages read the same numbers', async () => {
  const d = (await t.get(`${WS}/dashboard`, { as: 'stevie' })).json;
  const card = d.cards.find((c) => c.name === 'watched');
  assert.deepEqual([card.status, card.instances, card.cpu.used, card.cpu.limit, card.memory.usedMb, card.memory.limitMb], ['live', 2, 0.4, 1, 200, 1024]);
  assert.match(card.last.commit, /^[0-9a-f]{40}$/);
  assert.ok(d.allocation.some((a) => a.service === 'watched' && a.cpu === 1));
  assert.ok(d.cpu.used >= 0.4 && d.cpu.allocated >= 1);
  assert.equal(d.bandwidth.includedBytes, 100e9);
  assert.ok(d.deploys.some((x) => x.service === 'watched' && x.status === 'live'));
  assert.equal(d.services.total, d.cards.length);

  const deploys = (await t.get(`${WS}/deploys?service=watched`, { as: 'stevie' })).json.deploys;
  assert.ok(deploys.length >= 1 && deploys.every((x) => x.service === 'watched'));
  assert.equal((await t.get(`${WS}/deploys?service=nope`, { as: 'stevie' })).status, 404);

  const m = (await t.get(`${WS}/metrics?range=1h`, { as: 'stevie' })).json;
  const row = m.services.find((s) => s.name === 'watched');
  assert.ok(row.points.some((p) => p.cpu === 0.4));
  assert.equal((await t.get(`${WS}/metrics?range=2h`, { as: 'stevie' })).status, 422);
  for (const p of ['dashboard', 'deploys', 'metrics']) assert.equal((await t.get(`${WS}/${p}`, { as: 'amara' })).status, 404, p);
});

test('4.7 Scaling: the instance type and count go to services.platform.workloads.scale(), checked and audited', async () => {
  for (const [body, field] of [[{ instances: 0 }, 'instances'], [{ instances: 11 }, 'instances'], [{ instances: 1.5 }, 'instances'], [{ plan: 'huge' }, 'plan']]) {
    const r = await t.post(`${SVC}/scale`, { as: 'stevie', body });
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal(r.json.error.details[0].path, field);
  }
  assert.equal((await t.post(`${SVC}/scale`, { as: 'amara', body: { instances: 3 } })).status, 404, 'another workspace');
  const same = await t.post(`${SVC}/scale`, { as: 'stevie', body: { instances: 2, plan: 'starter' } });
  assert.deepEqual([same.status, same.json.changed], [200, false]);

  const res = await t.post(`${SVC}/scale`, { as: 'stevie', body: { instances: 3, plan: 'standard' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual([res.json.changed, res.json.service.instances, res.json.service.plan], [true, 3, 'standard']);
  assert.ok(res.json.operation?.id);
  await t.idle();
  const w = await t.platform().workloads.get('exclusivity-life', 'watched');
  assert.deepEqual([w.instances, w.plan], [3, { cpu: 1, memoryMb: 2048 }]);
  const now = await containers();
  assert.equal(now.length, 3);
  assert.ok(now.every((c) => c.cpu === 1 && c.memoryMb === 2048), 'the new size');
  const { instances } = (await t.get(`${SVC}/instances`, { as: 'stevie' })).json;
  assert.equal(instances.length, 3);
  const m = (await t.get(`${SVC}/metrics`, { as: 'stevie' })).json;
  assert.deepEqual([m.limits.cpu, m.limits.memoryMb], [3, 6144]);
  const audited = t.host.auditLog.find((r) => r.action === 'service.scaled' && r.detail?.service === 'watched');
  assert.deepEqual([audited.actor, audited.detail.from, audited.detail.to], ['stevie', { plan: 'starter', instances: 2 }, { instances: 3, plan: 'standard' }]);

  // A count alone: one leaves and one joins again; the others are never started again.
  const three = now.map((c) => c.name);
  assert.equal((await t.post(`${SVC}/scale`, { as: 'stevie', body: { instances: 2 } })).status, 200);
  await t.idle();
  const two = (await containers()).map((c) => c.name);
  assert.equal(two.length, 2);
  assert.ok(two.every((n) => three.includes(n)), 'no new container when one leaves');
  assert.equal((await t.post(`${SVC}/scale`, { as: 'stevie', body: { instances: 3 } })).status, 200);
  await t.idle();
  const back = (await containers()).map((c) => c.name);
  assert.equal(back.length, 3);
  assert.ok(two.every((n) => back.includes(n)), 'the two running were left alone');

  // A scale that cannot finish (the mock server's 8 GB holds three Standard instances): the platform keeps what ran,
  // our record follows, and the Scaling tab hears why.
  const events = [];
  const stop = t.realtime.subscribe(['exclusivity-life'], (e) => events.push(e));
  assert.equal((await t.post(`${SVC}/scale`, { as: 'stevie', body: { instances: 4 } })).status, 200);
  await t.idle();
  stop();
  assert.deepEqual((await containers()).map((c) => c.name).sort(), [...back].sort(), 'the three serving were not touched');
  const svc = (await t.get(SVC, { as: 'stevie' })).json;
  assert.deepEqual([svc.instances, svc.plan], [3, 'standard'], 'back to what runs');
  const said = events.find((e) => e.type === 'scale' && e.data.service === 'watched');
  assert.deepEqual([said?.data.failed, said?.data.instances, said?.data.plan], [true, 3, 'standard']);
  assert.match(said.data.reason, /full/i);
});
