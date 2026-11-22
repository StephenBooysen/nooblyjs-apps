// A Workflow's tasks and runs (roadmap 5.4). On the workspace router, behind requireWorkspace (another workspace, or a
// service that is not a Workflow, is a 404):
//
//   GET    /workspaces/:ws/services/:service/tasks                 tasks, concurrency, counts, the runs, the trigger
//   PUT    /workspaces/:ws/services/:service/tasks                 { tasks?, concurrency? }: from the next run, no rebuild
//   POST   /workspaces/:ws/services/:service/tasks/:task/runs      { input? }: queue a run (Run on the page)
//   GET    /workspaces/:ws/services/:service/task-runs/:run        one run with each attempt's log
//   POST   /workspaces/:ws/services/:service/task-runs/:run/cancel a run that has not started, or waits to try again
//   POST   /workspaces/:ws/services/:service/trigger-key           a new key (shown once; the old one stops working)
//   DELETE /workspaces/:ws/services/:service/trigger-key
//
// From code, with no sign-in (taskTriggerRoutes, mounted at /api/v1/tasks ahead of sessions): the key is the proof,
// sent as a bearer token. A wrong key, an unknown workspace or service, or a service with no key all get the same 401.
//
//   POST   /api/v1/tasks/:ws/:service/:task/runs    { input? } → 202 { run }
//   GET    /api/v1/tasks/:ws/:service/runs/:run     the run, to wait for its result
import crypto from 'node:crypto';
import { WORKFLOW, TASK_ENV, planOf } from '../../public/js/shared/catalog.js';
import { checkTasks } from './services.js';
import { taskRunView, TaskError } from '../scheduling/tasks.js';

const sendError = (res, status, code, message, details) => res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
const actorOf = (person) => ({ id: person.id, name: person.name, kind: 'person' });
const RUN_ID = /^trn_[a-z0-9]{1,40}$/;
const KEY = /^ntk_[A-Za-z0-9_-]{43}$/;

export const hashKey = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/** The run's input from a body: any JSON value up to WORKFLOW.inputKb, or a problem. → { input } | { problem } */
function inputOf(body) {
  const input = body?.input ?? null;
  const size = Buffer.byteLength(JSON.stringify(input));
  if (size > WORKFLOW.inputKb * 1024) return { problem: { path: 'input', message: `Up to ${WORKFLOW.inputKb} KB of JSON.` } };
  return { input };
}

/** Where code triggers a task of this Workflow. */
export const triggerUrl = (config, s, task = ':task') => `${config.publicUrl}/api/v1/tasks/${s.workspaceId}/${s.name}/${task}/runs`;

/**
 * @param {import('express').Router} router
 * @param {object} o
 * @param {() => ReturnType<import('../scheduling/tasks.js').createTasks>} o.tasks   read when a request comes
 */
export function addTaskRoutes(router, { records, platform, tasks, audit, realtime, config, W }) {
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => (err instanceof TaskError ? sendError(res, err.status, err.code, err.message) : next(err)));

  async function workflowOr404(req, res) {
    const s = await records.services.byName(req.workspace.id, req.params.service);
    if (!s || s.type !== 'workflow') {
      sendError(res, 404, 'not_found', s ? 'Only a Workflow has tasks.' : 'No such service.');
      return null;
    }
    return s;
  }

  router.get(`${W}/services/:service/tasks`, wrap(async (req, res) => {
    const s = await workflowOr404(req, res);
    if (!s) return;
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? '50', 10) || 50));
    const runs = await records.taskRuns.list(s.workspaceId, { serviceId: s.id, limit });
    res.json({
      tasks: s.tasks ?? [],
      concurrency: s.concurrency ?? WORKFLOW.defaults.concurrency,
      counts: await tasks().counts(s),
      limitMb: planOf(s.plan)?.memoryMb ?? null,
      env: TASK_ENV,
      runs: runs.map(taskRunView),
      trigger: {
        url: triggerUrl(config, s),
        key: s.triggerKey ? { hint: s.triggerKey.hint, createdAt: s.triggerKey.createdAt, createdBy: s.triggerKey.createdBy ?? null } : null,
      },
    });
  }));

  router.put(`${W}/services/:service/tasks`, wrap(async (req, res) => {
    const s = await workflowOr404(req, res);
    if (!s) return;
    const b = req.body ?? {};
    const problems = [];
    if (b.tasks === undefined && b.concurrency === undefined) problems.push({ path: 'tasks', message: 'Send the tasks, the concurrency or both.' });
    const changes = problems.length ? {} : checkTasks(b, problems, { partial: true });
    if (problems.length) return sendError(res, 422, 'invalid', 'Check the highlighted fields.', problems);
    const changed = Object.fromEntries(Object.entries(changes).filter(([k, v]) => JSON.stringify(s[k] ?? null) !== JSON.stringify(v)));
    if (!Object.keys(changed).length) return res.json({ tasks: s.tasks ?? [], concurrency: s.concurrency, changed: false });
    // The platform holds the concurrency (how many runs it lets go at once); the tasks' commands go with each run.
    if (changed.concurrency && s.workload) await platform().workloads.update(s.workspaceId, s.workload, { concurrency: changed.concurrency }, { actor: actorOf(req.person) });
    const updated = await records.services.update(s.workspaceId, s.id, changed);
    await audit({ action: 'service.tasks-changed', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, changed: Object.keys(changed), tasks: (updated.tasks ?? []).map((t) => t.name), concurrency: updated.concurrency } });
    realtime.publish(s.workspaceId, 'task', { service: s.name, tasks: updated.tasks, concurrency: updated.concurrency });
    await tasks().pump(updated);
    res.json({ tasks: updated.tasks, concurrency: updated.concurrency, changed: true });
  }));

  router.post(`${W}/services/:service/tasks/:task/runs`, wrap(async (req, res) => {
    const s = await workflowOr404(req, res);
    if (!s) return;
    const { input, problem } = inputOf(req.body);
    if (problem) return sendError(res, 422, 'invalid', 'Check the highlighted fields.', [problem]);
    const run = await tasks().enqueue(s, { task: req.params.task, input, trigger: 'manual', by: req.person });
    await audit({ action: 'service.task-queued', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, task: run.task, run: run.id } });
    res.status(202).json({ run });
  }));

  router.get(`${W}/services/:service/task-runs/:run`, wrap(async (req, res) => {
    const s = await workflowOr404(req, res);
    if (!s) return;
    const r = RUN_ID.test(req.params.run) ? await records.taskRuns.get(s.workspaceId, req.params.run) : null;
    if (!r || r.serviceId !== s.id) return sendError(res, 404, 'not_found', 'No such task run.');
    // Each attempt's log is the platform's record of that run: its output, and how it ended.
    const attempts = [];
    for (const [i, runId] of (r.runIds ?? []).entries()) {
      const run = s.workload ? await platform().jobs.get(s.workspaceId, s.workload, runId).catch(() => null) : null;
      attempts.push({ attempt: i + 1, status: run?.status ?? 'unknown', log: (run?.log ?? []).map((l) => ({ at: l.at, level: 'info', text: l.text ?? l.line ?? '' })) });
    }
    res.json({ ...taskRunView(r), attempts });
  }));

  router.post(`${W}/services/:service/task-runs/:run/cancel`, wrap(async (req, res) => {
    const s = await workflowOr404(req, res);
    if (!s) return;
    if (!RUN_ID.test(req.params.run)) return sendError(res, 404, 'not_found', 'No such task run.');
    const run = await tasks().cancel(s, req.params.run, req.person);
    await audit({ action: 'service.task-cancelled', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, task: run.task, run: run.id } });
    res.json({ run });
  }));

  router.post(`${W}/services/:service/trigger-key`, wrap(async (req, res) => {
    const s = await workflowOr404(req, res);
    if (!s) return;
    const raw = `ntk_${crypto.randomBytes(32).toString('base64url')}`;
    const key = { hash: hashKey(raw), hint: raw.slice(-4), createdAt: new Date().toISOString(), createdBy: { id: req.person.id, name: req.person.name } };
    await records.services.update(s.workspaceId, s.id, { triggerKey: key });
    await audit({ action: s.triggerKey ? 'service.trigger-key-replaced' : 'service.trigger-key-created', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, hint: key.hint } });
    // The only time the key is shown: only its hash is kept.
    res.status(201).json({ key: raw, hint: key.hint, createdAt: key.createdAt, url: triggerUrl(config, s) });
  }));

  router.delete(`${W}/services/:service/trigger-key`, wrap(async (req, res) => {
    const s = await workflowOr404(req, res);
    if (!s) return;
    if (s.triggerKey) {
      await records.services.update(s.workspaceId, s.id, { triggerKey: null });
      await audit({ action: 'service.trigger-key-removed', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, hint: s.triggerKey.hint } });
    }
    res.status(204).end();
  }));
}

/**
 * Triggering a task from code: the Workflow's key as a bearer token, no sign-in.
 * @param {object} o
 * @param {typeof import('express')} o.express
 * @param {() => ReturnType<import('../scheduling/tasks.js').createTasks>} o.tasks
 */
export function taskTriggerRoutes({ express, records, tasks, audit }) {
  const router = express.Router();
  const NAME = /^[a-z0-9-]{1,63}$/;
  const refuse = (res) => sendError(res, 401, 'unauthenticated', 'The trigger key does not match. Send it as Authorization: Bearer <key>.');

  /** The Workflow the key opens, or null (every way of failing looks the same). */
  async function workflowFor(req) {
    const raw = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '')?.[1] ?? '';
    if (!KEY.test(raw) || !NAME.test(req.params.workspace) || !NAME.test(req.params.service)) return null;
    const s = await records.services.byName(req.params.workspace, req.params.service);
    if (s?.type !== 'workflow' || !s.triggerKey?.hash) return null;
    const a = Buffer.from(hashKey(raw), 'hex');
    const b = Buffer.from(s.triggerKey.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? s : null;
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => (err instanceof TaskError ? sendError(res, err.status, err.code, err.message) : next(err)));

  router.post('/:workspace/:service/:task/runs', express.json({ limit: `${WORKFLOW.inputKb + 1}kb` }), wrap(async (req, res) => {
    const s = await workflowFor(req);
    if (!s) return refuse(res);
    const { input, problem } = inputOf(req.body);
    if (problem) return sendError(res, 422, 'invalid', 'Check the highlighted fields.', [problem]);
    const run = await tasks().enqueue(s, { task: req.params.task, input, trigger: 'api' });
    await audit({ action: 'service.task-queued', actor: `trigger-key:${s.id}`, target: s.workspaceId, detail: { service: s.name, task: run.task, run: run.id, via: 'api' } });
    res.status(202).json({ run });
  }));

  router.get('/:workspace/:service/runs/:run', wrap(async (req, res) => {
    const s = await workflowFor(req);
    if (!s) return refuse(res);
    const r = RUN_ID.test(req.params.run) ? await records.taskRuns.get(s.workspaceId, req.params.run) : null;
    if (!r || r.serviceId !== s.id) return sendError(res, 404, 'not_found', 'No such task run.');
    res.json({ run: taskRunView(r) });
  }));

  return router;
}
