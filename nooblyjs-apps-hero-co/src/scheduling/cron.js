// Cron Jobs (roadmap 5.3). The platform runs a job when asked (services.platform.workloads.runJob, infra 8.2 R6) and
// leaves the schedule to the launcher, so this is the launcher's half:
//
//   - the scheduler: at the start of every UTC minute, each Cron Job whose schedule matches runs (trigger `schedule`,
//     with the command on its record). The platform refuses a second run while one is going; that fire is skipped and
//     the service's logs say so.
//   - the follower: infrastructure.job.started / succeeded / failed → a line in the service's logs (level info, or
//     error for a failed run) and a `run` event on the workspace's live channel for its page.
//
// Not core `scheduling` (stack.md D10): its cron matches the server's local time, and a fire only runs a worker script.
import { parseCron, cronMatches, describeCron } from '../../public/js/shared/cron.js';
import { planOf } from '../../public/js/shared/catalog.js';
import { customerReason } from '../platform/workloads.js';

export const SCHEDULE_ACTOR = { id: 'schedule', name: 'Schedule', kind: 'system' };

const two = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
const seconds = (ms) => {
  if (!Number.isFinite(ms)) return null;
  if (ms < 1000) return 'less than a second';
  if (ms < 10_000) return `${Math.round(ms / 100) / 10} s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
};

/** A run's facts as a sentence: "exit code 0 after 4.2 s, at most 210 MB of 1 GB". */
export function runSummary({ exitCode, durationMs, peakMemoryMb }, limitMb) {
  const limit = limitMb >= 1024 ? `${limitMb / 1024} GB` : `${limitMb} MB`;
  const code = exitCode === null || exitCode === undefined ? null : `exit code ${exitCode}`;
  const took = seconds(durationMs) ? `after ${seconds(durationMs)}` : null;
  return [[code, took].filter(Boolean).join(' '), Number.isFinite(peakMemoryMb) ? `at most ${peakMemoryMb} MB of ${limit}` : null].filter(Boolean).join(', ');
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
export function createCron({ records, platform, eventEmitter, realtime, telemetry, workspaceIds, log = {}, timers = true }) {
  const say = (ws, svc, line, level = 'info') => {
    const added = telemetry.logs.add(ws, svc, [{ at: new Date().toISOString(), instance: 'run', stream: 'stdout', level, line }]);
    realtime.publish(ws, 'log', { service: svc, lines: telemetry.forClient(svc, added) });
  };

  // ----- the scheduler
  const fired = new Map(); // service id → the minute it last fired (a tick twice in one minute fires once)
  let chain = Promise.resolve();

  /** Fires every Cron Job due in the UTC minute holding `at`. → the names that started */
  async function tick(at = new Date()) {
    const minute = new Date(Math.floor(new Date(at).getTime() / 60_000) * 60_000);
    const started = [];
    for (const ws of await workspaceIds()) {
      for (const s of await records.services.list(ws)) {
        if (s.type !== 'cron' || !s.schedule || !s.workload || s.status === 'suspended') continue;
        const parsed = parseCron(s.schedule);
        if (parsed.error || !cronMatches(parsed, minute) || fired.get(s.id) === minute.getTime()) continue;
        fired.set(s.id, minute.getTime());
        if (!s.current) {
          say(ws, s.name, `Skipped the ${hhmm(minute)} run: the first deploy has not finished yet.`, 'warn');
          continue;
        }
        try {
          await platform().workloads.runJob(ws, s.workload, { actor: SCHEDULE_ACTOR, trigger: 'schedule', command: s.command || null });
          started.push(s.name);
        } catch (err) {
          if (err.code === 'conflict') say(ws, s.name, `Skipped the ${hhmm(minute)} run: ${/already running/.test(err.message) ? 'the previous run is still going' : err.message}.`, 'warn');
          else log.warn?.(`[hero-co] cron ${ws}/${s.name}: ${err.message}`);
        }
      }
    }
    return started;
  }

  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    // A second into the next minute, recomputed from the clock each time so the timer never drifts past a minute.
    const wait = 60_000 - (Date.now() % 60_000) + 1_000;
    timer = setTimeout(() => {
      chain = chain.then(() => tick(new Date())).catch((err) => log.warn?.(`[hero-co] cron tick: ${err.message}`));
      schedule();
    }, wait);
    timer.unref?.();
  };
  if (timers) schedule();

  // ----- the follower
  const serviceOf = async (p) => (p?.tenantId && p.workload ? records.services.byName(p.tenantId, p.workload) : null);
  const later = (fn) => (p) => {
    chain = chain.then(() => fn(p)).catch((err) => log.warn?.(`[hero-co] job event: ${err.message}`));
  };
  const onRun = (type) => later(async (p) => {
    const s = await serviceOf(p);
    if (!s) return;
    const ws = s.workspaceId;
    const by = p.trigger === 'schedule' ? 'by the schedule' : 'by hand';
    if (type === 'started') say(ws, s.name, `Run started ${by}.`);
    else {
      const limitMb = planOf(s.plan)?.memoryMb ?? 512;
      if (type === 'succeeded') {
        const facts = runSummary(p, limitMb);
        say(ws, s.name, `Run succeeded${facts ? `: ${facts}` : ''}.`);
      } else {
        // The reason names the exit code already ("The job exited with code 3.").
        const facts = runSummary({ ...p, exitCode: null }, limitMb);
        say(ws, s.name, `Run failed: ${String(customerReason(p.reason, s) ?? 'it stopped').replace(/\.$/, '')}${facts ? ` (${facts})` : ''}.`, 'error');
      }
    }
    realtime.publish(ws, 'run', { service: s.name, run: { id: p.runId, status: type === 'started' ? 'running' : type, trigger: p.trigger, exitCode: p.exitCode ?? null, durationMs: p.durationMs ?? null, peakMemoryMb: p.peakMemoryMb ?? null } });
  });
  const handlers = { 'infrastructure.job.started': onRun('started'), 'infrastructure.job.succeeded': onRun('succeeded'), 'infrastructure.job.failed': onRun('failed') };
  for (const [type, fn] of Object.entries(handlers)) eventEmitter.on(type, fn);

  return {
    tick,
    describe: describeCron,
    /** Resolves when every tick and event so far is handled (tests). */
    idle: () => chain,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const [type, fn] of Object.entries(handlers)) eventEmitter.off(type, fn);
    },
  };
}
