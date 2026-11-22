// Workflows (roadmap 5.4; stack.md D11). A Workflow is a job workload whose runs may go side by side up to its
// concurrency (services.platform.workloads.runJob, infra 8.2 R6). Its tasks, its queue and its retries are ours:
//
//   - enqueue(): a task run waits in hero_task_runs (status queued), up to WORKFLOW.queue per Workflow.
//   - the pump: for a Workflow that is live (not suspended, deployed once), its oldest queued runs whose time has come
//     start while fewer than its concurrency are running, each with the task's command and TASK_NAME, TASK_INPUT,
//     TASK_RUN_ID and TASK_ATTEMPT. One pump at a time, in step with the follower.
//   - the follower: infrastructure.job.started / succeeded / failed of a Workflow's run → its task run's record, a line
//     in the service's logs, a `task` event on the workspace's live channel. A failed attempt with attempts left waits
//     again: 10 s, doubling, at most 5 minutes (WORKFLOW.backoffS, backoffMaxS).
//   - tick(): every 5 seconds (timers on), settles runs whose end we missed (the platform's record says they ended),
//     then pumps every Workflow, so a retry whose wait is over, a resumed Workflow or a first deploy that finished
//     starts what waits.
//
// Not core `workflow` (stack.md D11): it runs JavaScript step files in this server's own worker threads and keeps its
// state in memory, with no retries and no concurrency cap; a customer's task must run in the customer's container.
import { WORKFLOW, planOf } from '../../public/js/shared/catalog.js';
import { customerReason } from '../platform/workloads.js';
import { runSummary } from './cron.js';

const TICK_MS = 5000;
const ENDED = new Set(['succeeded', 'failed', 'cancelled']);

/** How long a run waits before its next attempt, after `attempt` attempts (1 → 10 s, 2 → 20 s, … at most 5 min). */
export const backoffMs = (attempt) => Math.min(WORKFLOW.backoffMaxS, WORKFLOW.backoffS * 2 ** Math.max(0, attempt - 1)) * 1000;

const waitText = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** Who started a run, as the platform's audit records it. */
const actorOf = (r) => (r.trigger === 'api' ? { id: `trigger-key:${r.serviceId}`, name: 'Trigger key', kind: 'system' } : { id: r.by?.id ?? 'unknown', name: r.by?.name ?? 'Someone', kind: 'person' });

/** The variables a run gets besides the service's own (catalog TASK_ENV). */
export const runEnv = (r, attempt) => [
  { key: 'TASK_NAME', value: r.task },
  { key: 'TASK_INPUT', value: JSON.stringify(r.input ?? null) },
  { key: 'TASK_RUN_ID', value: r.id },
  { key: 'TASK_ATTEMPT', value: String(attempt) },
];

/** A task run as the API and the page show it. A queued run that has failed before is Retrying. */
export function taskRunView(r) {
  return {
    id: r.id,
    task: r.task,
    status: r.status === 'queued' && r.attempt > 0 ? 'retrying' : r.status,
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    trigger: r.trigger,
    by: r.trigger === 'api' ? 'API' : r.by?.name ?? null,
    input: r.input ?? null,
    createdAt: r.createdAt,
    startedAt: r.startedAt ?? null,
    finishedAt: r.finishedAt ?? null,
    nextAttemptAt: r.status === 'queued' ? r.notBefore ?? null : null,
    exitCode: r.exitCode ?? null,
    durationMs: r.durationMs ?? null,
    peakMemoryMb: r.peakMemoryMb ?? null,
    reason: r.reason ?? null,
  };
}

/** An error the routes answer with its status and words. */
export class TaskError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {object} o
 * @param {object} o.records
 * @param {() => object} o.platform
 * @param {import('node:events').EventEmitter} o.eventEmitter
 * @param {object} o.realtime
 * @param {object} o.telemetry          for the lines it adds to a service's logs
 * @param {() => Promise<string[]>} o.workspaceIds
 * @param {{ warn?: Function }} [o.log]
 * @param {boolean} [o.timers]           false in tests, which call tick() themselves
 */
export function createTasks({ records, platform, eventEmitter, realtime, telemetry, workspaceIds, log = {}, timers = true }) {
  const say = (ws, svc, line, level = 'info') => {
    const added = telemetry.logs.add(ws, svc, [{ at: new Date().toISOString(), instance: 'task', stream: 'stdout', level, line }]);
    realtime.publish(ws, 'log', { service: svc, lines: telemetry.forClient(svc, added) });
  };
  const publish = (ws, s, r, counts) => realtime.publish(ws, 'task', { service: s.name, run: taskRunView(r), ...(counts ? { counts } : {}) });

  // Everything that reads and writes task runs goes through this chain, one step at a time.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch((err) => log.warn?.(`[hero-co] tasks: ${err.message}`));
    return p;
  };

  /** Running and waiting runs of a Workflow, and how many may run at once. */
  async function counts(s) {
    const open = await records.taskRuns.list(s.workspaceId, { serviceId: s.id, status: ['queued', 'running'], limit: Infinity });
    return { running: open.filter((r) => r.status === 'running').length, queued: open.filter((r) => r.status === 'queued').length, concurrency: s.concurrency ?? WORKFLOW.defaults.concurrency, queueLimit: WORKFLOW.queue };
  }

  /** Starts what may start now. Call inside the chain. → the ids it started */
  async function pumpNow(ws, serviceId, at = Date.now()) {
    const s = (await records.services.list(ws)).find((x) => x.id === serviceId);
    if (!s || s.type !== 'workflow' || !s.workload || s.status === 'suspended' || !s.current) return [];
    const open = await records.taskRuns.list(ws, { serviceId: s.id, status: ['queued', 'running'], limit: Infinity });
    let going = open.filter((r) => r.status === 'running').length;
    const limit = s.concurrency ?? WORKFLOW.defaults.concurrency;
    const due = open.filter((r) => r.status === 'queued' && (!r.notBefore || Date.parse(r.notBefore) <= at))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    const started = [];
    for (const r of due) {
      if (going >= limit) break;
      const task = (s.tasks ?? []).find((t) => t.name === r.task);
      if (!task) {
        const failed = await records.taskRuns.update(ws, r.id, { status: 'failed', reason: `The task ${r.task} no longer exists.`, finishedAt: new Date().toISOString(), notBefore: null });
        say(ws, s.name, `Task ${r.task} failed: it no longer exists.`, 'error');
        publish(ws, s, failed);
        continue;
      }
      const attempt = r.attempt + 1;
      let operation;
      try {
        ({ operation } = await platform().workloads.runJob(ws, s.workload, { command: task.command, env: runEnv(r, attempt), trigger: r.trigger === 'api' ? 'api' : 'manual', actor: actorOf(r) }));
      } catch (err) {
        // The platform is at its limit (runs we did not start), or not ready (a deploy, a suspend): wait for the next tick.
        if (err.code === 'conflict') break;
        const failed = await records.taskRuns.update(ws, r.id, { status: 'failed', reason: err.message, finishedAt: new Date().toISOString(), notBefore: null });
        say(ws, s.name, `Task ${r.task} could not start: ${err.message}`, 'error');
        publish(ws, s, failed);
        continue;
      }
      const running = await records.taskRuns.update(ws, r.id, (x) => ({ ...x, status: 'running', attempt, runIds: [...(x.runIds ?? []), operation.id], notBefore: null }));
      going += 1;
      started.push(r.id);
      publish(ws, s, running, await counts(s));
    }
    return started;
  }

  /** The platform's run `p` (an event, or its record when we missed the event) on the task run it belongs to. */
  async function settle(s, type, p) {
    const ws = s.workspaceId;
    const r = await records.taskRuns.byRunId(ws, p.runId);
    // Only the attempt going now: a late or repeated event of an earlier attempt changes nothing.
    if (!r || r.status !== 'running' || r.runIds.at(-1) !== p.runId) return;
    const of = `attempt ${r.attempt} of ${r.maxAttempts}`;
    if (type === 'started') {
      const updated = await records.taskRuns.update(ws, r.id, (x) => ({ ...x, startedAt: x.startedAt ?? new Date().toISOString() }));
      say(ws, s.name, `Task ${r.task} started (${of}, ${r.trigger === 'api' ? 'through the API' : `by ${r.by?.name ?? 'hand'}`}).`);
      publish(ws, s, updated);
      return;
    }
    const facts = { exitCode: p.exitCode ?? null, durationMs: p.durationMs ?? null, peakMemoryMb: p.peakMemoryMb ?? null };
    const limitMb = planOf(s.plan)?.memoryMb ?? 512;
    const at = new Date().toISOString();
    let updated;
    if (type === 'succeeded') {
      updated = await records.taskRuns.update(ws, r.id, { ...facts, status: 'succeeded', finishedAt: at, reason: null });
      const sum = runSummary(p, limitMb);
      say(ws, s.name, `Task ${r.task} succeeded${sum ? `: ${sum}` : ''}.`);
    } else {
      const reason = String(customerReason(p.reason, s) ?? 'It stopped.');
      const sum = runSummary({ ...p, exitCode: null }, limitMb);
      const why = `${reason.replace(/\.$/, '')}${sum ? ` (${sum})` : ''}`;
      if (r.attempt < r.maxAttempts) {
        const wait = backoffMs(r.attempt);
        updated = await records.taskRuns.update(ws, r.id, { ...facts, status: 'queued', notBefore: new Date(Date.now() + wait).toISOString(), reason });
        say(ws, s.name, `Task ${r.task} failed: ${why}. Trying again in ${waitText(wait)} (attempt ${r.attempt + 1} of ${r.maxAttempts}).`, 'warn');
      } else {
        updated = await records.taskRuns.update(ws, r.id, { ...facts, status: 'failed', finishedAt: at, reason });
        say(ws, s.name, `Task ${r.task} failed${r.maxAttempts > 1 ? ` after ${r.maxAttempts} attempts` : ''}: ${why}.`, 'error');
      }
    }
    publish(ws, s, updated, await counts(s));
    await pumpNow(ws, s.id);
  }

  // ----- the follower
  const serviceOf = async (p) => (p?.tenantId && p.workload ? records.services.byName(p.tenantId, p.workload) : null);
  const onRun = (type) => (p) => serial(async () => {
    const s = await serviceOf(p);
    if (s?.type === 'workflow') await settle(s, type, p);
  });
  const handlers = { 'infrastructure.job.started': onRun('started'), 'infrastructure.job.succeeded': onRun('succeeded'), 'infrastructure.job.failed': onRun('failed') };
  for (const [type, fn] of Object.entries(handlers)) eventEmitter.on(type, fn);

  /** Runs whose end we did not hear (a restart, a lost event): the platform's record of each settles it. */
  async function catchUp(s) {
    const open = await records.taskRuns.list(s.workspaceId, { serviceId: s.id, status: 'running', limit: Infinity });
    if (!open.length) return;
    const { runs } = await platform().jobs.runs(s.workspaceId, s.workload, { limit: 100 }).catch(() => ({ runs: [] }));
    const byId = new Map(runs.map((x) => [x.id, x]));
    for (const r of open) {
      const run = byId.get(r.runIds.at(-1));
      if (!run || !ENDED.has(run.status)) continue;
      await settle(s, run.status === 'succeeded' ? 'succeeded' : 'failed', { runId: run.id, exitCode: run.exitCode, durationMs: run.durationMs, peakMemoryMb: run.peakMemoryMb, reason: run.reason ?? (run.status === 'cancelled' ? 'The run was cancelled.' : null) });
    }
  }

  /** Settles missed ends and starts what may start, in every Workflow. → the ids it started */
  function tick(at = new Date()) {
    return serial(async () => {
      const started = [];
      for (const ws of await workspaceIds()) {
        for (const s of await records.services.list(ws)) {
          if (s.type !== 'workflow' || !s.workload) continue;
          await catchUp(s);
          started.push(...(await pumpNow(ws, s.id, new Date(at).getTime())));
        }
      }
      return started;
    });
  }

  let timer = null;
  if (timers) {
    timer = setInterval(() => tick().catch((err) => log.warn?.(`[hero-co] tasks tick: ${err.message}`)), TICK_MS);
    timer.unref?.();
  }

  return {
    tick,
    counts,
    /**
     * Queues a run of one of a Workflow's tasks and starts it if there is room. → the task run (its view)
     * @param {object} s   the Workflow's record
     * @param {{ task: string, input?: any, trigger?: 'manual'|'api', by?: { id: string, name: string } }} o
     */
    enqueue(s, { task, input = null, trigger = 'manual', by = null }) {
      return serial(async () => {
        const def = (s.tasks ?? []).find((t) => t.name === task);
        if (!def) throw new TaskError(404, 'not_found', `${s.name} has no task called ${task}.`);
        const { queued } = await counts(s);
        if (queued >= WORKFLOW.queue) throw new TaskError(429, 'queue_full', `The queue is full: ${WORKFLOW.queue.toLocaleString('en')} runs are waiting already. Try again when some have started.`);
        const r = await records.taskRuns.create({
          workspaceId: s.workspaceId, serviceId: s.id, serviceName: s.name, task, input, status: 'queued', attempt: 0, maxAttempts: (def.retries ?? 0) + 1,
          trigger, by: by ? { id: by.id, name: by.name } : null, notBefore: null, startedAt: null, finishedAt: null, exitCode: null, durationMs: null, peakMemoryMb: null, reason: null,
        });
        publish(s.workspaceId, s, r, await counts(s));
        await pumpNow(s.workspaceId, s.id);
        return taskRunView(await records.taskRuns.get(s.workspaceId, r.id));
      });
    },
    /** Cancels a run that has not started (or waits to try again). → its view */
    cancel(s, runId, by) {
      return serial(async () => {
        const r = await records.taskRuns.get(s.workspaceId, runId);
        if (!r || r.serviceId !== s.id) throw new TaskError(404, 'not_found', 'No such task run.');
        if (r.status === 'running') throw new TaskError(409, 'conflict', 'It is running: it ends when its command ends.');
        if (r.status !== 'queued') throw new TaskError(409, 'conflict', `It has ${r.status} already.`);
        const updated = await records.taskRuns.update(s.workspaceId, r.id, { status: 'cancelled', finishedAt: new Date().toISOString(), notBefore: null, reason: `Cancelled by ${by?.name ?? 'someone'}.` });
        say(s.workspaceId, s.name, `Task ${r.task} cancelled by ${by?.name ?? 'someone'}${r.attempt ? ` after ${r.attempt} attempt${r.attempt === 1 ? '' : 's'}` : ' before it started'}.`);
        publish(s.workspaceId, s, updated, await counts(s));
        return taskRunView(updated);
      });
    },
    /** Starts what waits in one Workflow (after its tasks, concurrency or status change). */
    pump: (s) => serial(() => pumpNow(s.workspaceId, s.id)),
    /** Resolves when every tick, event and change so far is handled (tests). */
    idle: () => chain,
    stop() {
      if (timer) clearInterval(timer);
      for (const [type, fn] of Object.entries(handlers)) eventEmitter.off(type, fn);
    },
  };
}
