// Postgres and Key Value (roadmap 6.1–6.4; infra specs 8.6, 8.7), behind requireWorkspace (src/routes/workspaces.js):
//
//   POST  /workspaces/:ws/datastores                          { type, name, region, plan, backupTime?, eviction? }
//   GET   /workspaces/:ws/services/:service/datastore         status, plan, connection details (no password), storage or
//                                                             memory and connections now, backups, linked services
//   PATCH /workspaces/:ws/services/:service/datastore         { plan?, backupTime?, eviction? }
//   POST  /workspaces/:ws/services/:service/datastore/reveal  { confirm: <name> } → { url }; audited
//   POST  /workspaces/:ws/services/:service/datastore/backups Back up now (Postgres)
//   POST  /workspaces/:ws/services/:service/datastore/restore { backup, into }: a new database from a backup
//   PUT   /workspaces/:ws/services/:service/links             { links: [{ key, store }] }: Link to service. Each link is
//                                                             the store's connection string in that variable, from the
//                                                             platform when the container starts (never kept by us), and
//                                                             the service deploys again to get it.
//
// A data store is one of our service records (type postgres or keyvalue, `store`: its name on the platform); the
// database or store itself is the platform's (services.platform.databases / .keyvalue), which only the workspace's own
// containers reach. Another workspace's store is a 404, as everywhere.
import { DATA_PLANS, DATA_DEFAULTS, DATA_TYPES, EVICTIONS, dataPlanOf, dataPlanText, regionOf, REGIONS, CREATABLE } from '../../public/js/shared/catalog.js';
import { toWorkloadSpec } from '../platform/workloads.js';

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_LINKS = 10;
const sendError = (res, status, code, message, details) => res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
const invalid = (res, problems) => sendError(res, 422, 'invalid', problems[0]?.message ?? 'Check the highlighted fields.', problems);
const actorOf = (person) => ({ id: person.id, name: person.name, kind: 'person' });
/** The platform's status as ours: available is Live. */
export const storeStatus = (s) => (s === 'available' ? 'live' : s);

/** The platform's plan for one of ours. */
export function platformPlan(type, planKey, { eviction } = {}) {
  const p = dataPlanOf(type, planKey);
  return type === 'postgres' ? { connections: p.connections, storageMb: p.storageMb } : { memoryMb: p.memoryMb, connections: p.connections, eviction: eviction ?? DATA_DEFAULTS.keyvalue.eviction };
}

/**
 * Keeps our records' status in step with the platform's databases and Key Value stores, and tells the workspace's
 * live channel.
 */
export function followDataStores({ eventEmitter, records, realtime, log = console }) {
  const on = async (p, name) => {
    const s = await records.services.byName(p.tenantId, name).catch(() => null);
    if (!s || !DATA_TYPES.includes(s.type)) return;
    const status = storeStatus(p.status);
    await records.services.update(s.workspaceId, s.id, { status, reason: p.reason ?? null });
    realtime.publish(s.workspaceId, 'datastore', { service: s.name, status });
  };
  const handlers = {
    'infrastructure.database.status': (p) => on(p, p.database),
    'infrastructure.keyvalue.status': (p) => on(p, p.keyvalue),
    'infrastructure.database.backed_up': async (p) => realtime.publish(p.tenantId, 'datastore', { service: p.database, backup: p.backupId }),
  };
  const wrapped = Object.entries(handlers).map(([type, fn]) => [type, (p) => Promise.resolve(fn(p)).catch((err) => log.warn?.(`${type}: ${err.message}`))]);
  for (const [type, fn] of wrapped) eventEmitter.on(type, fn);
  return { stop: () => { for (const [type, fn] of wrapped) eventEmitter.off(type, fn); } };
}

/**
 * @param {import('express').Router} router
 * @param {object} o
 */
export function addDataStoreRoutes(router, { records, platform, config, audit, realtime, billing, W }) {
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const apiOf = (type) => (type === 'postgres' ? platform().databases : platform().keyvalue);

  async function storeOr404(req, res) {
    const s = await records.services.byName(req.workspace.id, req.params.service);
    if (!s || !DATA_TYPES.includes(s.type)) {
      sendError(res, 404, 'not_found', s ? 'Only a Postgres or Key Value service has this.' : 'No such service.');
      return null;
    }
    return s;
  }
  const linkedTo = async (ws, name) => (await records.services.list(ws))
    .flatMap((x) => (x.links ?? []).filter((l) => l.store === name).map((l) => ({ service: x.name, key: l.key })));

  async function view(s) {
    const api = apiOf(s.type);
    const name = s.store ?? s.name;
    const info = await api.get(s.workspaceId, name).catch((err) => (err.code === 'not_found' ? null : Promise.reject(err)));
    const stats = info?.status === 'available' ? await api.stats(s.workspaceId, name).catch(() => null) : null;
    const plan = dataPlanOf(s.type, s.plan);
    const region = regionOf(s.region);
    return {
      name: s.name, type: s.type, status: info ? storeStatus(info.status) : 'missing', reason: info?.reason ?? null,
      region: s.region, regionName: region?.name ?? s.region, local: Boolean(region?.local),
      plan: s.plan, planName: plan?.name ?? s.plan, planText: dataPlanText(s.type, plan), priceUsd: plan?.priceUsd ?? null,
      engine: info?.engine ?? null, version: info?.version ?? null,
      connection: info ? {
        host: info.host, port: info.port,
        ...(s.type === 'postgres' ? { database: info.database, user: info.user } : { user: 'default' }),
        // A Local network database is reached through the relay on the workspace's own network: the link gives the
        // address its containers use; the host and port here are the server's.
        through: region?.local ? (s.type === 'postgres' ? 'relay' : 'network') : 'private',
      } : null,
      ...(s.type === 'postgres' ? {
        backupTime: info?.backupTime ?? null, keepBackups: DATA_DEFAULTS.postgres.keepBackups,
        backups: info?.backups ?? [], lastBackupAt: info?.lastBackupAt ?? null, restoredFrom: info?.restoredFrom ?? null,
        storage: stats ? { bytes: stats.bytes, limitBytes: stats.limitBytes } : null,
        connections: stats ? { used: stats.connections, limit: stats.limitConnections } : null,
      } : {
        eviction: info?.plan?.eviction ?? null, persistence: false,
        memory: stats ? { usedMb: stats.memoryUsedMb, limitMb: stats.memoryMb } : null,
        connections: stats ? { used: null, limit: stats.connections } : null,
      }),
      linkKey: DATA_DEFAULTS[s.type].linkKey,
      linked: await linkedTo(s.workspaceId, s.name),
      createdAt: s.createdAt ?? null,
    };
  }

  /** A data store record of ours and the platform's database or store behind it. */
  async function create(req, res, { type, name, region, plan, backupTime, eviction, restore = null }) {
    const ws = req.workspace.id;
    // The free tier (roadmap 7.6): Postgres, and a paid Key Value plan, need a card on file (402 card_required).
    await billing?.requireCardFor(ws, type, plan.key);
    const service = await records.services.create({
      workspaceId: ws, name, type, source: null, build: null, region: region.id, plan: plan.key, instances: 1, env: [], envGroups: [],
      autoDeploy: false, url: null, internalHost: null, status: 'creating', current: null, workload: null, store: name,
      createdBy: { id: req.person.id, name: req.person.name },
    });
    try {
      const actor = actorOf(req.person);
      if (restore) await platform().databases.restore(ws, restore.from, restore.backup, { into: name, actor });
      else if (type === 'postgres') await platform().databases.create(ws, { name, region: region.platform, plan: platformPlan(type, plan.key), backupTime }, { actor });
      else await platform().keyvalue.create(ws, { name, region: region.platform, plan: platformPlan(type, plan.key, { eviction }) }, { actor });
    } catch (err) {
      await records.services.remove(ws, service.id);
      const fields = err.details?.fields ?? {};
      if (err.code === 'conflict') return invalid(res, [{ path: restore ? 'into' : 'name', message: `You already have a ${type === 'postgres' ? 'database' : 'store'} called ${name}.` }]);
      if (err.code === 'quota') return sendError(res, 429, 'quota', err.message);
      if (err.code === 'not_found') return sendError(res, 404, 'not_found', err.message);
      if (err.code === 'invalid') return invalid(res, Object.entries(fields).map(([path, message]) => ({ path: path.startsWith('plan') ? 'plan' : path, message: path === 'region' && region.local ? 'The Local network has no Postgres server yet: the operator sets HERO_LOCAL_POSTGRES_URL.' : message })));
      throw err;
    }
    await audit({ action: restore ? 'datastore.restored' : 'datastore.created', actor: req.person.id, target: ws, detail: { service: name, type, plan: plan.key, region: region.id, ...(restore ? { from: restore.from, backup: restore.backup } : {}) } });
    realtime.publish(ws, 'datastore', { service: name, status: 'creating' });
    return res.status(201).json({ service: await view(await records.services.byName(ws, name)), redirect: `/w/${ws}/services/${name}` });
  }

  router.post(`${W}/datastores`, wrap(async (req, res) => {
    const ws = req.workspace.id;
    const b = req.body ?? {};
    const problems = [];
    if (!DATA_TYPES.includes(b.type)) return invalid(res, [{ path: 'type', message: 'Postgres or Key Value.' }]);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!NAME.test(name)) problems.push({ path: 'name', message: 'Lower-case letters, digits and hyphens, starting with a letter; up to 40 characters.' });
    else if (await records.services.byName(ws, name)) problems.push({ path: 'name', message: `You already have a service called ${name}.` });
    const region = regionOf(b.region ?? 'af-south');
    if (!region) problems.push({ path: 'region', message: 'Choose a region.' });
    else if (!region.platform) problems.push({ path: 'region', message: `${region.name} is not open yet. Choose ${REGIONS.filter((r) => r.platform).map((r) => r.name).join(' or ')}.` });
    const plan = dataPlanOf(b.type, b.plan ?? DATA_DEFAULTS[b.type].plan);
    if (!plan) problems.push({ path: 'plan', message: `Choose one of ${DATA_PLANS[b.type].map((p) => p.name).join(', ')}.` });
    const backupTime = b.type === 'postgres' ? (b.backupTime === undefined || b.backupTime === '' ? DATA_DEFAULTS.postgres.backupTime : b.backupTime) : undefined;
    if (b.type === 'postgres' && backupTime !== null && !TIME.test(String(backupTime))) problems.push({ path: 'backupTime', message: 'A time such as 03:00 (UTC).' });
    const eviction = b.type === 'keyvalue' ? b.eviction ?? DATA_DEFAULTS.keyvalue.eviction : undefined;
    if (b.type === 'keyvalue' && !EVICTIONS.some((e) => e.key === eviction)) problems.push({ path: 'eviction', message: 'Choose what happens when it is full.' });
    if (problems.length) return invalid(res, problems);
    return create(req, res, { type: b.type, name, region, plan, backupTime, eviction });
  }));

  router.get(`${W}/services/:service/datastore`, wrap(async (req, res) => {
    const s = await storeOr404(req, res);
    if (s) res.json(await view(s));
  }));

  router.patch(`${W}/services/:service/datastore`, wrap(async (req, res) => {
    const s = await storeOr404(req, res);
    if (!s) return;
    const b = req.body ?? {};
    const problems = [];
    const plan = b.plan === undefined ? dataPlanOf(s.type, s.plan) : dataPlanOf(s.type, b.plan);
    if (!plan) problems.push({ path: 'plan', message: `Choose one of ${DATA_PLANS[s.type].map((p) => p.name).join(', ')}.` });
    if (s.type === 'postgres' && b.backupTime !== undefined && b.backupTime !== null && !TIME.test(String(b.backupTime))) problems.push({ path: 'backupTime', message: 'A time such as 03:00 (UTC), or none.' });
    if (s.type === 'keyvalue' && b.eviction !== undefined && !EVICTIONS.some((e) => e.key === b.eviction)) problems.push({ path: 'eviction', message: 'Choose what happens when it is full.' });
    if (problems.length) return invalid(res, problems);
    if (plan.key !== s.plan) await billing?.requireCardFor(s.workspaceId, s.type, plan.key);
    const name = s.store ?? s.name;
    try {
      if (s.type === 'postgres') await platform().databases.update(s.workspaceId, name, { plan: platformPlan('postgres', plan.key), ...(b.backupTime !== undefined ? { backupTime: b.backupTime } : {}) }, { actor: actorOf(req.person) });
      else {
        const current = await platform().keyvalue.get(s.workspaceId, name);
        await platform().keyvalue.update(s.workspaceId, name, { plan: platformPlan('keyvalue', plan.key, { eviction: b.eviction ?? current.plan.eviction }) }, { actor: actorOf(req.person) });
      }
    } catch (err) {
      if (err.code === 'conflict') return sendError(res, 409, 'conflict', err.message);
      throw err;
    }
    await records.services.update(s.workspaceId, s.id, { plan: plan.key });
    await audit({ action: 'datastore.changed', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, plan: plan.key, backupTime: b.backupTime, eviction: b.eviction } });
    res.json(await view(await records.services.byName(s.workspaceId, s.name)));
  }));

  /** The connection string; the person types the store's name to confirm (product.md §7). Audited. */
  router.post(`${W}/services/:service/datastore/reveal`, wrap(async (req, res) => {
    const s = await storeOr404(req, res);
    if (!s) return;
    if (req.body?.confirm !== s.name) return invalid(res, [{ path: 'confirm', message: `Type ${s.name} to reveal the connection string.` }]);
    try {
      const c = await apiOf(s.type).connection(s.workspaceId, s.store ?? s.name);
      await audit({ action: 'datastore.revealed', actor: req.person.id, target: s.workspaceId, detail: { service: s.name } });
      res.json({ url: c.url });
    } catch (err) {
      if (err.code === 'conflict') return sendError(res, 409, 'conflict', err.message);
      throw err;
    }
  }));

  router.post(`${W}/services/:service/datastore/backups`, wrap(async (req, res) => {
    const s = await storeOr404(req, res);
    if (!s) return;
    if (s.type !== 'postgres') return sendError(res, 409, 'conflict', 'A Key Value store keeps its keys in memory only: there is nothing to back up.');
    try {
      const { backupId } = await platform().databases.backup(s.workspaceId, s.store ?? s.name, { actor: actorOf(req.person) });
      await audit({ action: 'datastore.backed-up', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, backup: backupId } });
      res.status(202).json({ backup: backupId });
    } catch (err) {
      if (err.code === 'conflict') return sendError(res, 409, 'conflict', err.message);
      throw err;
    }
  }));

  router.post(`${W}/services/:service/datastore/restore`, wrap(async (req, res) => {
    const s = await storeOr404(req, res);
    if (!s) return;
    if (s.type !== 'postgres') return sendError(res, 409, 'conflict', 'Only a Postgres database has backups.');
    const b = req.body ?? {};
    const into = typeof b.into === 'string' ? b.into.trim() : '';
    if (!NAME.test(into)) return invalid(res, [{ path: 'into', message: 'Name the new database: lower-case letters, digits and hyphens.' }]);
    if (await records.services.byName(s.workspaceId, into)) return invalid(res, [{ path: 'into', message: `You already have a service called ${into}.` }]);
    if (typeof b.backup !== 'string' || !b.backup) return invalid(res, [{ path: 'backup', message: 'Choose a backup.' }]);
    return create(req, res, { type: 'postgres', name: into, region: regionOf(s.region), plan: dataPlanOf('postgres', s.plan), restore: { from: s.store ?? s.name, backup: b.backup } });
  }));

  /** Link to service: each link puts a data store's connection string in one variable; the service deploys again. */
  router.put(`${W}/services/:service/links`, wrap(async (req, res) => {
    const ws = req.workspace.id;
    const s = await records.services.byName(ws, req.params.service);
    if (!s) return sendError(res, 404, 'not_found', 'No such service.');
    if (!CREATABLE[s.type] || s.type === 'static') return sendError(res, 409, 'conflict', s.type === 'static' ? 'A Static Site runs nothing after its build: it cannot use a database.' : 'Only a service can link a data store.');
    const list = Array.isArray(req.body?.links) ? req.body.links : null;
    if (!list || list.length > MAX_LINKS) return invalid(res, [{ path: 'links', message: `Up to ${MAX_LINKS} links.` }]);
    const problems = [];
    const seen = new Set();
    const links = [];
    for (const [i, l] of list.entries()) {
      const key = typeof l?.key === 'string' ? l.key.trim() : '';
      const store = typeof l?.store === 'string' ? await records.services.byName(ws, l.store) : null;
      if (!ENV_KEY.test(key)) problems.push({ path: `links.${i}.key`, message: 'A variable name: letters, digits and underscores, not starting with a digit.' });
      else if (seen.has(key)) problems.push({ path: `links.${i}.key`, message: `${key} is linked twice.` });
      else if ((s.env ?? []).some((e) => e.key === key)) problems.push({ path: `links.${i}.key`, message: `${key} is one of the service's own variables. Remove it there, or use another name.` });
      if (!store || !DATA_TYPES.includes(store.type)) problems.push({ path: `links.${i}.store`, message: 'Choose one of the workspace\'s Postgres or Key Value services.' });
      else if (store.region !== s.region) problems.push({ path: `links.${i}.store`, message: `${store.name} is in ${regionOf(store.region)?.name ?? store.region}; ${s.name} is in ${regionOf(s.region)?.name ?? s.region}. A link stays inside one region.` });
      seen.add(key);
      if (store) links.push({ key, store: store.name, type: store.type });
    }
    if (problems.length) return invalid(res, problems);
    const updated = await records.services.update(ws, s.id, { links });
    let operation = null;
    if (s.workload) {
      const groups = (await Promise.all((s.envGroups ?? []).map((id) => records.envGroups.get(ws, id)))).filter(Boolean);
      const spec = toWorkloadSpec(updated, { appDomain: config.appDomain, groups });
      try {
        ({ operation } = await platform().workloads.update(ws, s.workload, { run: spec.run }, { actor: actorOf(req.person) }));
        // A deploy already going takes the change with it; otherwise deploy, so the app gets the new variables.
        if (!operation && updated.status !== 'suspended') {
          ({ operation } = await platform().workloads.deploy(ws, s.workload, { actor: actorOf(req.person), trigger: 'config', message: 'Linked data stores changed' }));
        }
      } catch (err) {
        await records.services.update(ws, s.id, { links: s.links ?? [] });
        if (err.code === 'invalid') return invalid(res, Object.values(err.details?.fields ?? {}).map((message) => ({ path: 'links', message })));
        if (err.code === 'conflict') return sendError(res, 409, 'conflict', err.message);
        throw err;
      }
    }
    await audit({ action: 'service.links-changed', actor: req.person.id, target: ws, detail: { service: s.name, links: links.map((l) => `${l.key}=${l.store}`) } });
    if (operation) realtime.publish(ws, 'deploy', { service: s.name, status: 'deploying' });
    res.json({ links, redeploying: Boolean(operation) });
  }));
}
