// Telemetry (roadmap 4.1): what the platform streams about each service, kept and passed on.
//
//   services.platform.telemetry.subscribe (infra 8.5 R4)
//     onMetrics { tenantId, workload, samples }  → metrics store; the workspace's live channel ('metrics', at most
//                                                   every METRICS_EVERY_MS per service)
//     onLogs    { tenantId, workload, lines }    → log store (with a level); live channel ('log')
//   infrastructure.deploy.succeeded / failed      → the deploy's build lines into the log store (level `build`)
//   the proxy (src/routes/proxy.js)                → requests and bytes of Local network services
//
// tenantId is the workspace id and workload is the service name (src/routes/services.js creates them so).
// Stores are saved through core `filing` under <dataDir>/telemetry: metrics/<ws>/<svc>.json and
// logs/<ws>/<svc>/*.ndjson. Lines are written every minute; log files older than the plan keeps are swept hourly.
import path from 'node:path';
import { createMetrics } from './metrics.js';
import { createLogStore } from './logs.js';
import { planOf } from '../../public/js/shared/catalog.js';

const METRICS_EVERY_MS = 5_000;
const FLUSH_MS = 60_000;
const SWEEP_MS = 3_600_000;
export const shortInstance = (name) => (name && name !== 'build' ? String(name).slice(-6) : name ?? null);

/**
 * @param {object} o
 * @param {object} o.serviceRegistry
 * @param {import('node:events').EventEmitter} o.eventEmitter
 * @param {() => object} o.platform          services.platform
 * @param {object} o.records
 * @param {object} o.realtime
 * @param {() => Promise<string[]>} o.workspaceIds
 * @param {string} o.dataDir
 * @param {{ warn?: Function }} [o.log]
 * @param {boolean} [o.timers]   false in tests that drive flush/sweep themselves
 */
export function createTelemetry({ serviceRegistry, eventEmitter, platform, records, realtime, workspaceIds, dataDir, log = {}, timers = true }) {
  const filing = serviceRegistry.filing('local', { instanceName: 'hero-telemetry', baseDir: path.join(dataDir, 'telemetry') });
  const metrics = createMetrics({ filing, log });
  const logs = createLogStore({
    filing,
    log,
    retentionDays: async (ws, svc) => {
      const s = await records.services.byName(ws, svc).catch(() => null);
      return s ? planOf(s.plan)?.logDays ?? 7 : 1; // a deleted service's lines go after a day
    },
  });

  const lastPublished = new Map();
  function publishMetrics(ws, svc) {
    const key = `${ws}/${svc}`;
    const t = Date.now();
    if (t - (lastPublished.get(key) ?? 0) < METRICS_EVERY_MS) return;
    lastPublished.set(key, t);
    realtime.publish(ws, 'metrics', { service: svc, current: metrics.current(ws, svc) });
  }

  /** Lines as the service page and the Logs page draw them. */
  const forClient = (svc, lines) => lines.map((l) => ({ ...l, service: svc, out: l.stream, instance: shortInstance(l.instance) }));

  const unsubscribe = platform().telemetry.subscribe({
    onMetrics: ({ tenantId, workload, samples }) => {
      for (const x of samples) metrics.sample(tenantId, workload, x);
      publishMetrics(tenantId, workload);
    },
    onLogs: ({ tenantId, workload, lines }) => {
      const added = logs.add(tenantId, workload, lines);
      realtime.publish(tenantId, 'log', { service: workload, lines: forClient(workload, added) });
    },
  });

  // A deploy's build lines join its service's logs once it ends (each deploy once).
  const builds = new Set();
  let chain = Promise.resolve();
  const onDeployEnd = (p) => {
    if (!p?.tenantId || !p.workload || !p.deployId || builds.has(p.deployId)) return;
    builds.add(p.deployId);
    chain = chain.then(async () => {
      const d = await platform().deploys.get(p.tenantId, p.workload, p.deployId).catch(() => null);
      const lines = (d?.log ?? []).map((l) => ({ at: l.at, instance: 'build', stream: 'build', level: 'build', line: l.text ?? l.line ?? '' }));
      if (!lines.length) return;
      const added = logs.add(p.tenantId, p.workload, lines);
      realtime.publish(p.tenantId, 'log', { service: p.workload, lines: forClient(p.workload, added) });
    }).catch((err) => log.warn?.(`[hero-co] build lines for ${p.workload}: ${err.message}`));
  };
  eventEmitter.on('infrastructure.deploy.succeeded', onDeployEnd);
  eventEmitter.on('infrastructure.deploy.failed', onDeployEnd);

  const flush = async () => {
    await metrics.flush();
    await logs.flush();
  };
  const sweep = async () => logs.sweep(await workspaceIds());
  const intervals = timers ? [
    setInterval(() => flush().catch((err) => log.warn?.(`[hero-co] telemetry flush: ${err.message}`)), FLUSH_MS),
    setInterval(() => sweep().catch((err) => log.warn?.(`[hero-co] log sweep: ${err.message}`)), SWEEP_MS),
  ] : [];
  for (const i of intervals) i.unref?.();
  if (timers) setTimeout(() => sweep().catch(() => {}), 30_000).unref?.();

  return {
    metrics,
    logs,
    forClient,
    /** The proxy's hook: one request to a Local network service ended. */
    request: (ws, svc, info) => {
      metrics.request(ws, svc, info);
      publishMetrics(ws, svc);
    },
    flush,
    sweep,
    /** Resolves when every build-line fetch so far is done (tests). */
    idle: () => chain,
    async stop() {
      for (const i of intervals) clearInterval(i);
      unsubscribe();
      eventEmitter.off('infrastructure.deploy.succeeded', onDeployEnd);
      eventEmitter.off('infrastructure.deploy.failed', onDeployEnd);
      await chain;
      await flush().catch((err) => log.warn?.(`[hero-co] telemetry flush at shutdown: ${err.message}`));
    },
  };
}
