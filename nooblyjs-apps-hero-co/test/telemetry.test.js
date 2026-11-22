// Metric history and log storage (roadmap 4.2, 4.3), on their own with an in-memory stand-in for core `filing` and a
// clock the tests move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics, rollUp, combine, STEP } from '../src/telemetry/metrics.js';
import { createLogStore, levelOf } from '../src/telemetry/logs.js';

/** core filing's calls, over a Map. */
function memoryFiling() {
  const files = new Map();
  return {
    files,
    async create(p, content) { files.set(p, String(content)); },
    async read(p) {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    async delete(p) { files.delete(p); },
    async list(dir) {
      const out = new Map();
      for (const p of files.keys()) {
        if (!p.startsWith(`${dir}/`)) continue;
        const [first, ...rest] = p.slice(dir.length + 1).split('/');
        out.set(first, { name: first, isFile: rest.length === 0, isDirectory: rest.length > 0 });
      }
      if (!out.size) throw new Error('ENOENT');
      return [...out.values()];
    },
  };
}

const sample = (instance, at, cpu, mem, limits = { cpu: 1, mem: 2048 }) => ({
  instance, at: new Date(at).toISOString(), cpu: { value: cpu, unit: 'vCPU', limit: limits.cpu }, memory: { value: mem, unit: 'MB', limit: limits.mem },
});

test('roll-ups: means of CPU and memory, sums of counts, aligned buckets', () => {
  const pts = [{ t: 0, cpu: 1, mem: 100, req: 2, err: 0, bytes: 10 }, { t: 10_000, cpu: 3, mem: 300, req: 4, err: 1, bytes: 30 }, { t: 60_000, cpu: null, mem: null, req: 1, err: 0, bytes: 5 }];
  assert.deepEqual(combine(pts.slice(0, 2), 0), { t: 0, cpu: 2, mem: 200, req: 6, err: 1, bytes: 40 });
  assert.deepEqual(rollUp(pts, STEP.minute), [{ t: 0, cpu: 2, mem: 200, req: 6, err: 1, bytes: 40 }, { t: 60_000, cpu: null, mem: null, req: 1, err: 0, bytes: 5 }]);
});

test('metrics: two instances sum per 10 s point; the current use and its limits; requests and bytes per step', async () => {
  let clock = Date.parse('2026-11-21T10:00:05Z');
  const m = createMetrics({ now: () => clock });
  m.sample('ws', 'api', sample('a', clock, 0.4, 1000));
  m.sample('ws', 'api', sample('b', clock, 0.2, 500));
  for (let i = 0; i < 6; i += 1) m.request('ws', 'api', { status: i === 5 ? 503 : 200, bytes: 1000, at: clock });
  clock += 10_000;
  m.sample('ws', 'api', sample('a', clock, 0.6, 1100));
  m.sample('ws', 'api', sample('b', clock, 0.2, 520));

  const now = m.current('ws', 'api');
  assert.deepEqual([now.instances, now.cpu, now.cpuLimit, now.memoryMb, now.memoryLimitMb], [2, 0.8, 2, 1620, 4096]);
  assert.deepEqual([now.reqPerMin, now.bytesPerSec, now.monthRequests, now.monthBytes], [6, 100, 6, 6000]);

  const s = await m.series('ws', 'api', '1h');
  assert.equal(s.step, 10_000);
  assert.deepEqual(s.points.map((p) => [p.cpu, p.mem, p.req, p.err, p.reqPerMin, p.bytesPerSec]), [[0.6, 1500, 6, 1, 36, 600], [0.8, 1620, 0, 0, 0, 0]]);

  // An instance silent for over a minute no longer counts as using anything.
  clock += 70_000;
  assert.equal(m.current('ws', 'api').cpu, null);
});

test('metrics: minutes and hours roll up, survive a restart through filing, and month totals add up', async () => {
  const filing = memoryFiling();
  let clock = Date.parse('2026-11-21T10:00:00Z');
  const m = createMetrics({ filing, now: () => clock });
  // Three minutes of samples every 10 s: CPU 0.5 then 1.0 then 1.5.
  for (let minute = 0; minute < 3; minute += 1) {
    for (let k = 0; k < 6; k += 1) {
      m.sample('ws', 'api', sample('a', clock, 0.5 * (minute + 1), 100));
      m.request('ws', 'api', { bytes: 100, at: clock });
      clock += 10_000;
    }
  }
  const day = await m.series('ws', 'api', '24h');
  assert.equal(day.step, 60_000);
  assert.deepEqual(day.points.map((p) => [p.cpu, p.req, p.reqPerMin]), [[0.5, 6, 6], [1, 6, 6], [1.5, 6, 6]].slice(0, day.points.length));
  await m.flush();
  assert.ok(filing.files.has('metrics/ws/api.json'));

  // Later, a new process reads what was saved: the minutes are there, the month total too.
  clock += 2 * 3_600_000;
  const again = createMetrics({ filing, now: () => clock });
  await again.ready('ws', 'api');
  const week = await again.series('ws', 'api', '7d');
  assert.equal(week.step, 3_600_000);
  assert.equal(week.points.length, 1, 'the three minutes are one hour');
  assert.deepEqual([week.points[0].cpu, week.points[0].req], [1, 18]);
  again.request('ws', 'api', { bytes: 50, at: clock });
  assert.equal(again.current('ws', 'api').monthBytes, 1850);
  assert.equal(await again.monthBytes('ws'), 1850);
  assert.equal(await again.monthBytes('other'), 0);
});

test('metrics: a long range is merged down to at most 240 points', async () => {
  let clock = Date.parse('2026-11-21T00:00:00Z');
  const m = createMetrics({ now: () => clock });
  for (let i = 0; i < 360; i += 1) {
    m.sample('ws', 'api', sample('a', clock, 0.1, 10));
    clock += 10_000;
  }
  const s = await m.series('ws', 'api', '1h');
  assert.ok(s.points.length <= 240 && s.points.length >= 120, String(s.points.length));
  assert.equal(s.step, 20_000);
});

test('log levels: JSON, logfmt, tags, leading words; otherwise the stream decides', () => {
  const cases = [
    ['{"level":"warn","msg":"x"}', 'stdout', 'warn'], ['{"level":50,"msg":"pino"}', 'stdout', 'error'], ['{"severity":"INFO"}', 'stderr', 'info'],
    ['time=1 level=error msg=boom', 'stdout', 'error'], ['[2026-11-21 10:00:00 +0000] [7] [INFO] Booting worker', 'stderr', 'info'],
    ['WARNING:root:disk nearly full', 'stderr', 'warn'], ['ERROR something broke', 'stdout', 'error'], ['debug: cache miss', 'stdout', 'debug'],
    ['GET / 200 3ms', 'stdout', 'info'], ['Traceback (most recent call last):', 'stderr', 'error'], ['{not json', 'stdout', 'info'],
  ];
  for (const [line, stream, want] of cases) assert.equal(levelOf(line, stream), want, line);
});

test('logs: added lines are searchable by level and text; files are written once a minute; old files are swept by plan', async () => {
  const filing = memoryFiling();
  let clock = Date.parse('2026-11-21T10:00:00Z');
  const days = { api: 7, worker: 3 };
  const store = createLogStore({ filing, now: () => clock, retentionDays: async (ws, svc) => days[svc] ?? 7 });
  const at = (s) => new Date(clock + s * 1000).toISOString();
  const added = store.add('ws', 'api', [
    { at: at(1), instance: 'a1b2c3', stream: 'stdout', line: 'GET /v1/orders 200 · 38 ms' },
    { at: at(2), instance: 'a1b2c3', stream: 'stdout', line: 'WARN rate limit reached' },
    { at: at(3), instance: 'd4e5f6', stream: 'stderr', line: 'Payment provider timeout' },
    { at: at(4), instance: 'd4e5f6', stream: 'stdout', line: 'x'.repeat(20_000) },
  ]);
  assert.deepEqual(added.map((l) => l.level), ['info', 'warn', 'error', 'info']);
  assert.match(added[3].line, /… \(cut: the line was 20,000 characters\)$/);
  store.add('ws', 'api', [{ at: at(0.5), instance: 'build', line: '==> Deploying 2 instances', level: 'build' }]);

  const all = await store.query('ws', { services: ['api'] });
  assert.deepEqual(all.lines.map((l) => l.level), ['build', 'info', 'warn', 'error', 'info'], 'build lines take their place in time');
  assert.deepEqual((await store.query('ws', { services: ['api'], level: 'warn,error' })).lines.map((l) => l.line), ['WARN rate limit reached', 'Payment provider timeout']);
  assert.deepEqual((await store.query('ws', { services: ['api'], q: 'ORDERS' })).lines.length, 1);
  assert.deepEqual((await store.query('ws', { services: ['api'], q: 'd4e5f6' })).lines.length, 2, 'search finds an instance too');
  const two = await store.query('ws', { services: ['api'], limit: 2 });
  assert.deepEqual([two.lines.length, two.more], [2, true]);

  await store.flush();
  const files = [...filing.files.keys()].filter((p) => p.startsWith('logs/ws/api/'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^logs\/ws\/api\/2026-11-21T10-00-[0-9a-z]+\.ndjson$/);
  await store.flush();
  assert.equal([...filing.files.keys()].length, 1, 'nothing new, no new file');

  // After a restart, the lines come from the files.
  const later = createLogStore({ filing, now: () => clock });
  assert.equal((await later.query('ws', { services: ['api'], since: at(0), level: 'error' })).lines[0].line, 'Payment provider timeout');

  // Four days on: the worker (3 days) loses its file, the api (7 days) keeps it.
  store.add('ws', 'worker', [{ at: at(5), instance: 'w1', line: 'working' }]);
  await store.flush();
  clock += 4 * 86_400_000;
  assert.equal(await store.sweep(['ws']), 1);
  assert.ok([...filing.files.keys()].some((p) => p.startsWith('logs/ws/api/')));
  assert.ok(![...filing.files.keys()].some((p) => p.startsWith('logs/ws/worker/')));
});
