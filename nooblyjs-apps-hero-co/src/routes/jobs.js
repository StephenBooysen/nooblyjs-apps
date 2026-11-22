// A Cron Job's runs and schedule (roadmap 5.3), behind requireWorkspace (src/routes/workspaces.js):
//
//   GET   /workspaces/:ws/services/:service/runs          the schedule in words, the next runs, and the runs, newest first
//   GET   /workspaces/:ws/services/:service/runs/:run     one run with its log: its output from the service's logs (one
//                                                         run at a time, so its window holds only its lines, with their
//                                                         levels), or the platform's record of it when those are gone
//   POST  /workspaces/:ws/services/:service/runs          Run now (one run at a time)
//   PATCH /workspaces/:ws/services/:service/schedule      { schedule?, command? }: takes effect from the next run
//
// Runs come from services.platform.jobs (infra 8.2 R6); the schedule is ours (src/scheduling/cron.js). Another
// workspace's service, or a service that is not a Cron Job, is a 404.
import { planOf } from '../../public/js/shared/catalog.js';
import { describeCron, nextRuns } from '../../public/js/shared/cron.js';
import { checkCron } from './services.js';
import { customerReason } from '../platform/workloads.js';

const sendError = (res, status, code, message, details) => res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
const actorOf = (person) => ({ id: person.id, name: person.name, kind: 'person' });

/** The schedule as the page shows it. */
export const scheduleView = (s, now = new Date()) => ({
  expression: s.schedule ?? null,
  text: describeCron(s.schedule ?? ''),
  next: nextRuns(s.schedule ?? '', now, 3).map((d) => d.toISOString()),
  command: s.command ?? null,
  limitMb: planOf(s.plan)?.memoryMb ?? null,
});

/** A platform run in the customer's words. */
export function runView(r, s) {
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    by: r.trigger === 'schedule' ? 'Schedule' : r.requestedBy?.name ?? null,
    command: r.command ?? s.command ?? null,
    startedAt: r.startedAt ?? r.createdAt,
    finishedAt: r.finishedAt ?? null,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    peakMemoryMb: r.peakMemoryMb,
    reason: customerReason(r.reason, s),
  };
}

/**
 * @param {import('express').Router} router
 * @param {object} o
 */
export function addJobRoutes(router, { records, platform, telemetry, audit, realtime, W }) {
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  /**
   * A run's lines from the service's logs (build lines left out), or the platform's log of it if they are gone; either
   * way as { at, level, text, instance }.
   */
  async function runLog(s, run, fallback) {
    if (telemetry && run.startedAt) {
      // A second either side: our "Run started" line can be written just before the platform marks the run started.
      const since = new Date(Date.parse(run.startedAt) - 1000).toISOString();
      const until = run.finishedAt ? new Date(Date.parse(run.finishedAt) + 1000).toISOString() : undefined;
      const { lines } = await telemetry.logs.query(s.workspaceId, { services: [s.name], since, until, limit: 2000 });
      const own = lines.filter((l) => l.level !== 'build');
      if (own.length) return telemetry.forClient(s.name, own).map((l) => ({ at: l.at, level: l.level, text: l.line, instance: l.instance }));
    }
    return fallback.map((l) => ({ at: l.at, level: l.level ?? 'info', text: l.text ?? l.line ?? '', instance: null }));
  }

  async function cronOr404(req, res) {
    const s = await records.services.byName(req.workspace.id, req.params.service);
    if (!s || s.type !== 'cron') {
      sendError(res, 404, 'not_found', s ? 'Only a Cron Job has runs.' : 'No such service.');
      return null;
    }
    return s;
  }

  router.get(`${W}/services/:service/runs`, wrap(async (req, res) => {
    const s = await cronOr404(req, res);
    if (!s) return;
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? '20', 10) || 20));
    const runs = s.workload ? (await platform().jobs.runs(s.workspaceId, s.workload, { limit }).catch((err) => (err.code === 'not_found' ? { runs: [] } : Promise.reject(err)))).runs : [];
    res.json({ schedule: scheduleView(s), runs: runs.map((r) => runView(r, s)) });
  }));

  router.get(`${W}/services/:service/runs/:run`, wrap(async (req, res) => {
    const s = await cronOr404(req, res);
    if (!s) return;
    if (!s.workload || !/^[A-Za-z0-9_-]{1,64}$/.test(req.params.run)) return sendError(res, 404, 'not_found', 'No such run.');
    try {
      const r = await platform().jobs.get(s.workspaceId, s.workload, req.params.run);
      const view = runView(r, s);
      res.json({ ...view, log: await runLog(s, view, r.log ?? []) });
    } catch (err) {
      if (err.code === 'not_found') return sendError(res, 404, 'not_found', 'No such run.');
      throw err;
    }
  }));

  router.post(`${W}/services/:service/runs`, wrap(async (req, res) => {
    const s = await cronOr404(req, res);
    if (!s) return;
    if (s.status === 'suspended') return sendError(res, 409, 'conflict', 'Resume the cron job before you run it.');
    if (!s.current || !s.workload) return sendError(res, 409, 'conflict', 'The first deploy has not finished yet. Run it once it is live.');
    let operation;
    try {
      ({ operation } = await platform().workloads.runJob(s.workspaceId, s.workload, { actor: actorOf(req.person), trigger: 'manual', command: s.command || null }));
    } catch (err) {
      if (err.code === 'conflict') return sendError(res, 409, 'conflict', /already running/.test(err.message) ? 'A run is already going. Wait for it to finish.' : err.message);
      throw err;
    }
    await audit({ action: 'service.run-started', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, run: operation.id } });
    res.status(202).json({ run: { id: operation.id, status: operation.status } });
  }));

  router.patch(`${W}/services/:service/schedule`, wrap(async (req, res) => {
    const s = await cronOr404(req, res);
    if (!s) return;
    const b = req.body ?? {};
    const problems = [];
    if (b.schedule === undefined && b.command === undefined) problems.push({ path: 'schedule', message: 'Send a schedule, a command or both.' });
    const changes = problems.length ? {} : checkCron(b, problems, { partial: true });
    if (problems.length) return sendError(res, 422, 'invalid', 'Check the highlighted fields.', problems);
    const changed = Object.fromEntries(Object.entries(changes).filter(([k, v]) => s[k] !== v));
    if (!Object.keys(changed).length) return res.json({ schedule: scheduleView(s), changed: false });
    // The platform keeps the schedule for its operators' screens only; the command goes with each run (no rebuild).
    if (changed.schedule && s.workload) await platform().workloads.update(s.workspaceId, s.workload, { schedule: changed.schedule }, { actor: actorOf(req.person) });
    const updated = await records.services.update(s.workspaceId, s.id, changed);
    await audit({ action: 'service.schedule-changed', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, from: Object.fromEntries(Object.keys(changed).map((k) => [k, s[k] ?? null])), to: changed } });
    realtime.publish(s.workspaceId, 'run', { service: s.name, schedule: scheduleView(updated) });
    res.json({ schedule: scheduleView(updated), changed: true });
  }));
}
