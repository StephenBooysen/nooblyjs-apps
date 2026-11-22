// Services on the platform (roadmap 2.2, 2.7; stack.md §4.1, §4.2). A NooblyJS Cloud service becomes a workload of
// the infrastructure accelerator (`services.platform`, spec 8.1) whose tenant is the workspace id; plan names become
// { cpu, memoryMb }. Environment values never leave this app: the workload carries a secretRef per variable, which the
// platform resolves through us when it starts a container (8.2).
//
// Deploy progress comes back as `infrastructure.deploy.*` events on the shared EventEmitter: followDeploys() keeps our
// deploy records and the service's status from them and publishes each change to the workspace's live channel.
import { CREATABLE, PLANS, SLEEP, STATIC, WORKFLOW, planOf, regionOf } from '../../public/js/shared/catalog.js';

/** Deploy statuses in the order they happen; a record never moves back (events may arrive after a slower write). */
const RANK = { queued: 0, building: 1, deploying: 2, live: 3, failed: 3, cancelled: 3, superseded: 4 };
const PLATFORM_RESULT = { queued: 'queued', building: 'building', deploying: 'deploying', live: 'live', failed: 'failed', cancelled: 'cancelled', superseded: 'superseded' };

export const secretRefFor = (service, key) => `hero:svc:${service.id}:${key}`;
export const groupRefFor = (group, key) => `hero:grp:${group.id}:${key}`;

/** The public URL of a service on the app domain: <name>.nooblyjs.app. */
export const hostFor = (name, appDomain) => `${name}.${appDomain}`;

/** A Local network service's path on this app's own URL (infra spec 8.9; the decision of 2026-11-20): /<workspace>/<name>/. */
export const pathFor = (workspaceId, name) => `/${workspaceId}/${name}/`;

/**
 * The workload spec for a service.
 * @param {object} service   our service record
 * @param {{ appDomain: string, groups?: object[] }} o   the env groups it links (their variables, under its own)
 */
export function toWorkloadSpec(service, { appDomain, groups = [] }) {
  const type = CREATABLE[service.type];
  if (!type) throw new Error(`A ${service.type} service cannot run on the platform yet.`);
  const plan = planOf(service.plan);
  const own = new Set((service.env ?? []).map((e) => e.key));
  const env = [
    ...(service.env ?? []).map((e) => ({ key: e.key, secretRef: secretRefFor(service, e.key) })),
    ...groups.flatMap((g) => (g.vars ?? []).filter((v) => !own.has(v.key)).map((v) => ({ key: v.key, secretRef: groupRefFor(g, v.key) }))),
  ];
  // A key in two linked groups: the first group linked wins.
  const seen = new Set();
  let uniqueEnv = env.filter((e) => (seen.has(e.key) ? false : seen.add(e.key)));
  const region = regionOf(service.region);
  const site = service.type === 'static';
  if (site) {
    // A static site's variables are for its build (nothing runs after it). On the Local network it answers under
    // /<workspace>/<name>/, which its build gets as BASE_PATH unless the service sets its own.
    uniqueEnv = uniqueEnv.map((e) => ({ ...e, build: true }));
    if (region.local && !seen.has(STATIC.basePathVar)) uniqueEnv.push({ key: STATIC.basePathVar, value: pathFor(service.workspaceId, service.name), build: true });
  }
  return {
    name: service.name,
    kind: type.kind,
    region: region.platform,
    source: { repo: service.source.url ?? service.source.repo, branch: service.source.branch, rootDir: service.source.rootDir ?? '', ...(service.source.url ? {} : { gitConnection: service.workspaceId }) },
    build: { runtime: service.build.runtime, buildCommand: service.build.buildCommand || null, startCommand: site ? null : service.build.startCommand || null, ...(site ? { publishDir: service.build.publishDir ?? STATIC.publishDir } : {}) },
    ...(site ? { site: { spa: service.spa === true } } : {}),
    run: { ...(type.port ? { port: service.port ?? 10000 } : {}), ...(type.schedule ? { command: service.command ?? null } : {}), env: uniqueEnv },
    plan: { cpu: plan.cpu, memoryMb: plan.memoryMb },
    instances: type.instances ? service.instances : 1,
    ...(type.port ? { healthCheck: { path: service.healthCheckPath ?? '/' } } : {}),
    // A Local network service answers on this app's own URL, not on a domain of its own.
    domains: type.publicUrl && !region.local ? [hostFor(service.name, appDomain)] : [],
    autoDeploy: service.autoDeploy ? { branch: service.source.branch } : null,
    // Idle sleep (roadmap 3.11): a web service in a cloud region, where the ingress wakes it.
    ...(type.sleeps && !region.local ? { sleep: { afterMin: SLEEP.afterMinutes } } : {}),
    // A Cron Job's schedule is kept by us (src/scheduling/cron.js); the platform stores it for its operators' screens.
    ...(type.schedule ? { schedule: service.schedule ?? null } : {}),
    // A Workflow's task runs go side by side up to its concurrency (infra 8.2 R6); its queue is ours (src/scheduling/tasks.js).
    ...(type.tasks ? { concurrency: service.concurrency ?? WORKFLOW.defaults.concurrency } : {}),
  };
}

/** Whether a service sleeps when idle (the same rule as the spec's `sleep`). */
export const sleepsWhenIdle = (service) => Boolean(CREATABLE[service.type]?.sleeps && !regionOf(service.region)?.local);

/**
 * A failed deploy's reason in the customer's words. The platform names its own regions ("Region af-south-1 is full: …");
 * the customer chose Johannesburg (roadmap 3.10).
 */
export function customerReason(reason, service) {
  if (typeof reason !== 'string') return reason ?? null;
  const full = /^(?:Region|Site) \S+ is full: (.*)$/.exec(reason);
  if (!full) return reason;
  const where = regionOf(service?.region)?.name ?? 'This region';
  return `${where} is full right now: ${full[1]} Deploy again in a few minutes, or choose a smaller instance type.`;
}

/** Our deploy record's fields from the platform's deploy record. */
export function fromPlatformDeploy(d, service) {
  return {
    commit: d.commit ?? null,
    message: d.message ?? null,
    trigger: d.trigger ?? 'manual',
    by: d.by ? { id: d.by.id, name: d.by.name } : null,
    status: PLATFORM_RESULT[d.result] ?? 'queued',
    reason: customerReason(d.reason ?? null, service),
    startedAt: d.startedAt ?? null,
    endedAt: d.endedAt ?? null,
  };
}

/** Merges a change into a deploy record without moving its status back. */
export function mergeDeploy(prev, patch) {
  if (!prev) return patch;
  const keepStatus = patch.status && (RANK[patch.status] ?? 0) < (RANK[prev.status] ?? 0);
  const out = { ...prev };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null) out[k] = v;
  if (keepStatus) out.status = prev.status;
  return out;
}

/**
 * Follows the platform's deploy and status events into our records.
 * @returns {{ stop: () => void, idle: () => Promise<void> }} idle() resolves when every event seen so far is written
 */
export function followDeploys({ eventEmitter, records, realtime, platform, log }) {
  let chain = Promise.resolve();
  const later = (fn) => (payload) => {
    chain = chain.then(() => fn(payload)).catch((err) => log?.warn?.(`[hero-co] deploy event: ${err.message}`));
  };

  async function serviceOf(p) {
    if (!p?.tenantId || !p.workload) return null;
    return records.services.byName(p.tenantId, p.workload);
  }

  async function onDeploy(type, p) {
    const service = await serviceOf(p);
    if (!service || !p.deployId) return;
    const ws = service.workspaceId;
    const prev = await records.deploys.get(ws, p.deployId);
    let patch = { serviceId: service.id, serviceName: service.name, step: p.step ?? prev?.step ?? null, of: p.of ?? prev?.of ?? null };
    if (!prev?.message) {
      const d = await platform().deploys.get(ws, service.name, p.deployId).catch(() => null);
      if (d) patch = { ...fromPlatformDeploy(d, service), ...patch };
    }
    // A real build (Local network) finds the commit itself and reports it on a later event.
    if (p.commit && !prev?.commit) patch.commit = p.commit;
    // The first deploy's record is written before its build starts: the start is when this event says so.
    if (type === 'started') Object.assign(patch, { status: 'building', ...(prev?.startedAt ? {} : { startedAt: new Date().toISOString() }) });
    if (type === 'progress') patch.status = p.status === 'deploying' ? 'deploying' : 'building';
    if (type === 'succeeded') Object.assign(patch, { status: 'live', endedAt: new Date().toISOString(), step: p.of ?? patch.of, });
    if (type === 'failed') Object.assign(patch, { status: 'failed', reason: customerReason(p.reason, service), endedAt: new Date().toISOString() });
    const next = await records.deploys.upsert(ws, p.deployId, mergeDeploy(prev, patch));
    if (type === 'succeeded') {
      if (service.current?.deployId && service.current.deployId !== p.deployId) {
        const old = await records.deploys.get(ws, service.current.deployId);
        if (old?.status === 'live') await records.deploys.upsert(ws, old.id, { ...old, status: 'superseded' });
      }
      await records.services.update(ws, service.id, { current: { deployId: p.deployId, commit: p.commit ?? next.commit ?? null }, status: 'live' });
    }
    realtime.publish(ws, 'deploy', { service: service.name, deploy: next });
  }

  async function onStatus(p) {
    const service = await serviceOf(p);
    if (!service) return;
    await records.services.update(service.workspaceId, service.id, { status: p.status });
    realtime.publish(service.workspaceId, 'deploy', { service: service.name, status: p.status });
  }

  /** A scale that failed: the platform kept what ran before, and so does our record; the Scaling tab says why. */
  async function onScaleFailed(p) {
    const service = await serviceOf(p);
    if (!service) return;
    const plan = PLANS.find((x) => x.cpu === p.plan?.cpu && x.memoryMb === p.plan?.memoryMb);
    const back = p.reverted ? { instances: p.instances, ...(plan ? { plan: plan.key } : {}) } : {};
    const updated = Object.keys(back).length ? await records.services.update(service.workspaceId, service.id, back) : service;
    realtime.publish(service.workspaceId, 'scale', {
      service: service.name, failed: true, reason: customerReason(p.reason, service), instances: updated.instances, plan: updated.plan,
    });
  }

  const handlers = {
    'infrastructure.workload.scale_failed': later(onScaleFailed),
    'infrastructure.deploy.started': later((p) => onDeploy('started', p)),
    'infrastructure.deploy.progress': later((p) => onDeploy('progress', p)),
    'infrastructure.deploy.succeeded': later((p) => onDeploy('succeeded', p)),
    'infrastructure.deploy.failed': later((p) => onDeploy('failed', p)),
    'infrastructure.workload.status': later(onStatus),
  };
  for (const [type, fn] of Object.entries(handlers)) eventEmitter.on(type, fn);
  return {
    stop() {
      for (const [type, fn] of Object.entries(handlers)) eventEmitter.off(type, fn);
    },
    idle: () => chain,
  };
}
