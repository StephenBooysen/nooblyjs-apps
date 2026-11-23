// The watch screens' API (roadmap 4.4–4.7), on the workspace router (behind requireWorkspace, so another workspace
// is a 404; test/isolation.test.js walks these too):
//
//   GET  /workspaces/:ws/dashboard                         stat tiles, CPU allocated by service, service cards, deploys
//   GET  /workspaces/:ws/deploys?service=&limit=           every deploy of the workspace, newest first
//   GET  /workspaces/:ws/metrics?range=                    each service's chart and current use
//   GET  /workspaces/:ws/logs?service=&level=&q=&since=&until=&limit=
//   GET  /workspaces/:ws/services/:service/metrics?range=  1h | 24h | 7d | 30d
//   GET  /workspaces/:ws/services/:service/instances       instance tiles: status, uptime, restarts, CPU, memory
//   GET  /workspaces/:ws/services/:service/logs?level=&q=&since=&until=&limit=
//   GET  /workspaces/:ws/services/:service/logs/download   the same lines as text
//   POST /workspaces/:ws/services/:service/scale           { plan?, instances? } → services.platform.workloads.scale
import { CREATABLE, PLANS, MAX_INSTANCES, BANDWIDTH_INCLUDED_GB, WORKFLOW, planOf, regionOf } from '../../public/js/shared/catalog.js';
import { serviceView } from '../domain/records.js';
import { RANGES } from '../telemetry/metrics.js';
import { LEVELS } from '../telemetry/logs.js';
import { shortInstance } from '../telemetry/index.js';
import { describeCron, nextRuns } from '../../public/js/shared/cron.js';

const sendError = (res, status, code, message, details) => res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
const invalid = (res, details) => sendError(res, 422, 'invalid', 'Check the highlighted fields.', details);
const actorOf = (person) => ({ id: person.id, name: person.name, kind: 'person' });
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
/** Names of the kinds the seed story has that cannot be created yet (product.md §6.2 names them). */
const OTHER_LABELS = { postgres: 'Postgres', keyvalue: 'Key Value', cron: 'Cron Job', workflow: 'Workflow', sandbox: 'Sandbox Group' };
/** Services that hold their CPU and memory: not suspended, not asleep, not deleted. */
const HOLDING = new Set(['live', 'deploying', 'building', 'failed', 'degraded', 'unknown']);

/** A log query's fields from the query string, or the problems with them. */
function logQuery(q) {
  const problems = [];
  const out = {};
  if (q.level) {
    const levels = String(q.level).split(',').filter(Boolean);
    if (levels.some((l) => !LEVELS.includes(l))) problems.push({ path: 'level', message: `Use ${LEVELS.join(', ')}, separated by commas.` });
    else out.level = levels.join(',');
  }
  if (q.q) {
    if (String(q.q).length > 200) problems.push({ path: 'q', message: 'Search for at most 200 characters.' });
    else out.q = String(q.q);
  }
  for (const k of ['since', 'until']) {
    if (!q[k]) continue;
    if (Number.isNaN(Date.parse(q[k]))) problems.push({ path: k, message: 'Use a time like 2026-11-21T10:00:00Z.' });
    else out[k] = new Date(Date.parse(q[k])).toISOString();
  }
  if (q.limit !== undefined) {
    const n = Number.parseInt(q.limit, 10);
    if (!(n >= 1 && n <= 2000)) problems.push({ path: 'limit', message: 'Ask for 1 to 2,000 lines.' });
    else out.limit = n;
  }
  return { query: out, problems };
}

/**
 * @param {import('express').Router} router
 * @param {object} o
 */
export function addTelemetryRoutes(router, { records, platform, telemetry, audit, realtime, billing, W }) {
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // Read when a request comes (the isolation test builds this router with stand-ins).
  const stores = () => telemetry;

  async function serviceOr404(req, res) {
    const s = await records.services.byName(req.workspace.id, req.params.service);
    if (!s) sendError(res, 404, 'not_found', 'No such service.');
    return s;
  }
  function rangeOr422(req, res) {
    const range = req.query.range ?? '1h';
    if (!RANGES[range]) {
      invalid(res, [{ path: 'range', message: `Use ${Object.keys(RANGES).join(', ')}.` }]);
      return null;
    }
    return range;
  }

  /** What a service reserves: per instance and in all (a static site reserves nothing). */
  function reserved(s) {
    const type = CREATABLE[s.type];
    const plan = planOf(s.plan);
    if (!plan || !type?.instances) return { cpu: 0, memoryMb: 0, perInstance: plan ? { cpu: plan.cpu, memoryMb: plan.memoryMb } : null, instances: 0 };
    const n = s.instances ?? 1;
    return { cpu: round(plan.cpu * n), memoryMb: plan.memoryMb * n, perInstance: { cpu: plan.cpu, memoryMb: plan.memoryMb }, instances: n };
  }

  /**
   * A Cron Job's runs for its card: the last one that ended (the platform keeps it on the workload), whether one is
   * going now, and the next time the schedule fires. Null for other kinds.
   */
  /**
   * A Postgres or Key Value service's meters (roadmap 6.4): storage and connections, or memory and clients, now.
   * → { storage?, memory?, connections } or null while it is not up.
   */
  async function storeFacts(s) {
    const api = s.type === 'postgres' ? platform().databases : s.type === 'keyvalue' ? platform().keyvalue : null;
    if (!api || !['live'].includes(s.status)) return null;
    const st = await api.stats(s.workspaceId, s.store ?? s.name).catch(() => null);
    if (!st) return null;
    return s.type === 'postgres'
      ? { storage: { bytes: st.bytes, limitBytes: st.limitBytes }, connections: { used: st.connections, limit: st.limitConnections } }
      : { memory: { usedMb: st.memoryUsedMb, limitMb: st.memoryMb }, connections: { used: null, limit: st.connections } };
  }

  async function runFacts(s) {
    if (['postgres', 'keyvalue'].includes(s.type)) return storeFacts(s);
    if (s.type === 'workflow') return taskFacts(s);
    if (s.type !== 'cron') return null;
    const [w, runs] = s.workload ? await Promise.all([
      platform().workloads.get(s.workspaceId, s.workload).catch(() => null),
      platform().jobs.runs(s.workspaceId, s.workload, { limit: 1 }).then((r) => r.runs).catch(() => []),
    ]) : [null, []];
    const last = w?.lastRun ?? null;
    return {
      last: last ? { status: last.result, exitCode: last.exitCode ?? null, durationMs: last.durationMs ?? null, peakMemoryMb: last.peakMemoryMb ?? null, at: last.at ?? null } : null,
      running: ['queued', 'running'].includes(runs[0]?.status),
      next: s.status === 'suspended' ? null : nextRuns(s.schedule ?? '', new Date(), 1)[0]?.toISOString() ?? null,
      scheduleText: describeCron(s.schedule ?? ''),
      limitMb: planOf(s.plan)?.memoryMb ?? null,
    };
  }

  /**
   * A Workflow's meters (product.md §6.4): task runs going against its concurrency, runs waiting against the queue's
   * limit, and the last run that ended.
   */
  async function taskFacts(s) {
    const open = await records.taskRuns.list(s.workspaceId, { serviceId: s.id, status: ['queued', 'running'], limit: Infinity });
    const [last] = await records.taskRuns.list(s.workspaceId, { serviceId: s.id, status: ['succeeded', 'failed'], limit: 1 });
    return {
      running: open.filter((r) => r.status === 'running').length,
      queued: open.filter((r) => r.status === 'queued').length,
      concurrency: s.concurrency ?? WORKFLOW.defaults.concurrency,
      queueLimit: WORKFLOW.queue,
      tasks: (s.tasks ?? []).length,
      last: last ? { task: last.task, status: last.status, at: last.finishedAt ?? last.createdAt, durationMs: last.durationMs ?? null, attempts: last.attempt } : null,
    };
  }

  /** A service's card on the dashboard and its row on the Metrics page. */
  function card(s, lastDeploy, run = null) {
    const r = reserved(s);
    const now = stores().metrics.current(s.workspaceId, s.name);
    const type = CREATABLE[s.type];
    return {
      name: s.name, type: s.type, typeLabel: type?.label ?? OTHER_LABELS[s.type] ?? s.type, status: s.status, region: s.region, regionName: regionOf(s.region)?.name ?? s.region,
      plan: s.plan, planName: planOf(s.plan)?.name ?? null, instances: type?.instances ? s.instances ?? 1 : null,
      cpu: { used: now.cpu, limit: r.cpu || null, unit: 'vCPU' },
      memory: { usedMb: now.memoryMb, limitMb: r.memoryMb || null },
      requests: { perMin: now.reqPerMin, month: now.monthRequests },
      bandwidth: { perSec: now.bytesPerSec, monthBytes: now.monthBytes },
      sampledAt: now.instances ? now.at : null,
      last: lastDeploy ? { id: lastDeploy.id, status: lastDeploy.status, commit: lastDeploy.commit ?? null, message: lastDeploy.message ?? null, at: lastDeploy.endedAt ?? lastDeploy.startedAt ?? lastDeploy.createdAt } : null,
      ...(run ? (s.type === 'workflow' ? { tasks: run } : ['postgres', 'keyvalue'].includes(s.type) ? { store: run } : { run }) : {}),
      // A Static Site's meters (product.md §6.4): its bandwidth this month against the workspace's included bandwidth,
      // and how many requests the cache answered (from memory, or a 304 for a file the browser has).
      ...(s.type === 'static' ? { site: { monthBytes: now.monthBytes, includedBytes: BANDWIDTH_INCLUDED_GB * 1e9, requests: now.monthRequests, hits: now.monthHits, hitRate: now.monthRequests ? round(now.monthHits / now.monthRequests, 4) : null } } : {}),
    };
  }

  const deployRow = (d) => ({
    id: d.id, service: d.serviceName, status: d.status, commit: d.commit ?? null, message: d.message ?? null, trigger: d.trigger ?? null,
    by: d.by ?? null, startedAt: d.startedAt ?? d.createdAt, endedAt: d.endedAt ?? null, reason: d.reason ?? null,
  });

  router.get(`${W}/dashboard`, wrap(async (req, res) => {
    const ws = req.workspace.id;
    const services = await records.services.list(ws);
    await Promise.all(services.map((s) => stores().metrics.ready(ws, s.name)));
    const deploys = await records.deploys.list(ws, { limit: 200 });
    const lastOf = new Map();
    for (const d of deploys) if (!lastOf.has(d.serviceId)) lastOf.set(d.serviceId, d);
    const cards = (await Promise.all(services.map(async (s) => card(s, lastOf.get(s.id), await runFacts(s))))).sort((a, b) => a.name.localeCompare(b.name));
    const holding = services.filter((s) => HOLDING.has(s.status));
    const allocation = holding.map((s) => ({ service: s.name, cpu: reserved(s).cpu })).filter((a) => a.cpu > 0).sort((a, b) => b.cpu - a.cpu || a.service.localeCompare(b.service));
    const sum = (list, f) => list.reduce((x, c) => x + (f(c) ?? 0), 0);
    res.json({
      at: new Date().toISOString(),
      services: {
        total: services.length,
        live: services.filter((s) => s.status === 'live').length,
        deploying: services.filter((s) => s.status === 'deploying' || s.status === 'building').map((s) => s.name),
        failed: services.filter((s) => s.status === 'failed').map((s) => s.name),
        asleep: services.filter((s) => s.status === 'sleeping' || s.status === 'suspended').map((s) => s.name),
      },
      cpu: { used: round(sum(cards, (c) => c.cpu.used), 3), allocated: round(sum(allocation, (a) => a.cpu)), unit: 'vCPU' },
      memory: { usedMb: Math.round(sum(cards, (c) => c.memory.usedMb)), allocatedMb: sum(holding, (s) => reserved(s).memoryMb) },
      bandwidth: { monthBytes: await stores().metrics.monthBytes(ws), includedBytes: BANDWIDTH_INCLUDED_GB * 1e9 },
      allocation,
      cards,
      deploys: deploys.slice(0, 8).map(deployRow),
    });
  }));

  router.get(`${W}/deploys`, wrap(async (req, res) => {
    const ws = req.workspace.id;
    let serviceId;
    if (req.query.service) {
      const s = await records.services.byName(ws, String(req.query.service));
      if (!s) return sendError(res, 404, 'not_found', 'No such service.');
      serviceId = s.id;
    }
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '100', 10) || 100, 1), 500);
    res.json({ deploys: (await records.deploys.list(ws, { serviceId, limit })).map(deployRow) });
  }));

  router.get(`${W}/metrics`, wrap(async (req, res) => {
    const range = rangeOr422(req, res);
    if (!range) return;
    const ws = req.workspace.id;
    const services = (await records.services.list(ws)).sort((a, b) => a.name.localeCompare(b.name));
    const rows = [];
    for (const s of services) {
      const series = await stores().metrics.series(ws, s.name, range);
      rows.push({ ...card(s, null, await runFacts(s)), step: series.step, points: series.points });
    }
    res.json({ range, from: Date.now() - RANGES[range].ms, to: Date.now(), services: rows });
  }));

  router.get(`${W}/logs`, wrap(async (req, res) => {
    const { query, problems } = logQuery(req.query);
    if (problems.length) return invalid(res, problems);
    const ws = req.workspace.id;
    let names = (await records.services.list(ws)).map((s) => s.name);
    if (req.query.service) {
      if (!names.includes(String(req.query.service))) return sendError(res, 404, 'not_found', 'No such service.');
      names = [String(req.query.service)];
    }
    const { lines, more } = await stores().logs.query(ws, { services: names, ...query });
    res.json({ lines: lines.map((l) => ({ ...l, out: l.stream, instance: shortInstance(l.instance) })), more, services: names });
  }));

  router.get(`${W}/services/:service/metrics`, wrap(async (req, res) => {
    const s = await serviceOr404(req, res);
    if (!s) return;
    const range = rangeOr422(req, res);
    if (!range) return;
    const series = await stores().metrics.series(s.workspaceId, s.name, range);
    const withCpu = series.points.filter((p) => p.cpu !== null);
    res.json({
      service: s.name, ...series,
      limits: reserved(s),
      current: stores().metrics.current(s.workspaceId, s.name),
      peak: {
        cpu: withCpu.length ? Math.max(...withCpu.map((p) => p.cpu)) : null,
        memoryMb: withCpu.length ? Math.max(...withCpu.map((p) => p.mem)) : null,
        reqPerMin: series.points.length ? Math.max(...series.points.map((p) => p.reqPerMin)) : null,
        bytesPerSec: series.points.length ? Math.max(...series.points.map((p) => p.bytesPerSec)) : null,
      },
      totals: { requests: series.points.reduce((x, p) => x + p.req, 0), errors: series.points.reduce((x, p) => x + p.err, 0), bytes: series.points.reduce((x, p) => x + p.bytes, 0) },
    });
  }));

  router.get(`${W}/services/:service/instances`, wrap(async (req, res) => {
    const s = await serviceOr404(req, res);
    if (!s) return;
    let list = [];
    try {
      list = await platform().workloads.instances(s.workspaceId, s.workload ?? s.name);
    } catch (err) {
      if (err.code !== 'not_found') throw err;
    }
    const latest = stores().metrics.instances(s.workspaceId, s.name);
    res.json({
      instances: list.map((i) => {
        const x = latest.get(i.instance);
        return {
          id: shortInstance(i.instance), status: i.status, startedAt: i.startedAt, restarts: i.restarts, lastExitCode: i.lastExitCode,
          cpu: { used: x?.cpu ?? null, limit: x?.cpuLimit ?? i.plan.cpu, unit: 'vCPU' },
          memory: { usedMb: x?.mem ?? null, limitMb: x?.memLimit ?? i.plan.memoryMb },
          sampledAt: x?.at ?? null,
        };
      }),
    });
  }));

  router.get(`${W}/services/:service/logs`, wrap(async (req, res) => {
    const s = await serviceOr404(req, res);
    if (!s) return;
    const { query, problems } = logQuery(req.query);
    if (problems.length) return invalid(res, problems);
    const { lines, more } = await stores().logs.query(s.workspaceId, { services: [s.name], ...query });
    res.json({ lines: lines.map((l) => ({ ...l, out: l.stream, instance: shortInstance(l.instance) })), more });
  }));

  router.get(`${W}/services/:service/logs/download`, wrap(async (req, res) => {
    const s = await serviceOr404(req, res);
    if (!s) return;
    const { query, problems } = logQuery({ ...req.query, limit: undefined });
    if (problems.length) return invalid(res, problems);
    const since = query.since ?? new Date(Date.now() - 86_400_000).toISOString();
    const { lines, more } = await stores().logs.query(s.workspaceId, { services: [s.name], ...query, since, limit: 100_000, cap: 100_000 });
    const body = lines.map((l) => `${l.at} ${String(shortInstance(l.instance) ?? '-').padEnd(6)} ${l.level.toUpperCase().padEnd(5)} ${l.line}`).join('\n');
    const stamp = new Date().toISOString().slice(0, 16).replace(':', '-');
    res.set('Content-Disposition', `attachment; filename="${s.name}-logs-${stamp}.txt"`);
    res.type('text/plain; charset=utf-8').send(`${body}${body ? '\n' : ''}${more ? '… (more lines than one download holds: narrow the time or the search)\n' : ''}`);
  }));

  /** Changes the instance type and/or the instance count (product.md §6.5 Scaling). */
  router.post(`${W}/services/:service/scale`, wrap(async (req, res) => {
    const s = await serviceOr404(req, res);
    if (!s) return;
    const type = CREATABLE[s.type];
    if (!type?.plan) return sendError(res, 409, 'conflict', 'A static site has no instances to scale: it is served from the CDN.');
    if (s.status === 'suspended') return sendError(res, 409, 'conflict', 'Resume the service before you scale it.');
    const b = req.body ?? {};
    const problems = [];
    const changes = {};
    if (b.plan !== undefined && b.plan !== s.plan) {
      if (!planOf(b.plan)) problems.push({ path: 'plan', message: `Choose ${PLANS.map((p) => p.name).join(', ')}.` });
      else changes.plan = b.plan;
    }
    if (b.instances !== undefined && b.instances !== s.instances && !type.instances) problems.push({ path: 'instances', message: type.tasks ? 'A Workflow has no instances: choose the instance type each task run gets. How many run at once is set with its tasks.' : `A ${type.label} runs one at a time: choose its instance type only.` });
    else if (b.instances !== undefined && b.instances !== s.instances) {
      if (!Number.isInteger(b.instances) || b.instances < 1 || b.instances > MAX_INSTANCES) problems.push({ path: 'instances', message: `Choose 1 to ${MAX_INSTANCES} instances.` });
      else changes.instances = b.instances;
    }
    if (problems.length) return invalid(res, problems);
    if (!Object.keys(changes).length) return res.json({ service: serviceView(s), operation: null, changed: false });
    if (changes.plan) await billing?.requireCardFor(s.workspaceId, s.type, changes.plan);
    const plan = planOf(changes.plan ?? s.plan);
    let operation = null;
    if (s.workload) {
      ({ operation } = await platform().workloads.scale(s.workspaceId, s.workload, {
        ...(changes.instances !== undefined ? { instances: changes.instances } : {}),
        ...(changes.plan ? { plan: { cpu: plan.cpu, memoryMb: plan.memoryMb } } : {}),
      }, { actor: actorOf(req.person) }));
    }
    const updated = await records.services.update(s.workspaceId, s.id, changes);
    await audit({ action: 'service.scaled', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, from: { plan: s.plan, instances: s.instances }, to: changes, operation: operation?.id ?? null } });
    realtime.publish(s.workspaceId, 'deploy', { service: s.name, status: updated.status });
    res.json({ service: serviceView(updated), operation: operation ? { id: operation.id, status: operation.status } : null, changed: true });
  }));
}
