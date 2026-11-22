// A Static Site's files and settings (roadmap 5.1, 5.2; infra spec 8.8), behind requireWorkspace
// (src/routes/workspaces.js):
//
//   GET   /workspaces/:ws/services/:service/site       what it serves (deploy, commit, since when, files, size), the
//                                                       deploys it can roll back to, its settings and this month's
//                                                       requests, bandwidth and cache hit rate
//   PATCH /workspaces/:ws/services/:service/site       { spa?, publishDir? }: spa applies at once (no rebuild); a new
//                                                       publish directory builds and deploys again
//   POST  /workspaces/:ws/services/:service/rollback   { deploy }: serves that deploy's files again, at once
//
// The files are the platform's (services.platform.staticSites); its deploy events keep our deploy records, as for any
// deploy. Another workspace's service, or a service that is not a Static Site, is a 404.
import { STATIC, isPublishDir } from '../../public/js/shared/catalog.js';
import { customerReason } from '../platform/workloads.js';

const sendError = (res, status, code, message, details) => res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
const actorOf = (person) => ({ id: person.id, name: person.name, kind: 'person' });

/**
 * @param {import('express').Router} router
 * @param {object} o
 */
export function addSiteRoutes(router, { records, platform, telemetry, audit, realtime, W }) {
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  async function siteOr404(req, res) {
    const s = await records.services.byName(req.workspace.id, req.params.service);
    if (!s || s.type !== 'static') {
      sendError(res, 404, 'not_found', s ? 'Only a Static Site has files to serve.' : 'No such service.');
      return null;
    }
    return s;
  }

  /** What the site page shows. */
  async function siteView(s) {
    const info = s.workload ? await platform().staticSites.info(s.workspaceId, s.workload).catch((err) => (err.code === 'not_found' ? null : Promise.reject(err))) : null;
    const now = telemetry?.metrics.current(s.workspaceId, s.name);
    const kept = info?.deploys ?? [];
    const current = kept.find((d) => d.deployId === info?.current) ?? null;
    return {
      publishDir: s.build?.publishDir ?? STATIC.publishDir,
      spa: s.spa === true,
      // The deploy whose files are served; a rollback serves an earlier deploy's files.
      serving: current ? { deployId: current.deployId, commit: current.commit ?? null, files: current.files, bytes: current.bytes, since: info.switchedAt ?? current.at } : null,
      kept: kept.map((d) => ({ deployId: d.deployId, commit: d.commit ?? null, at: d.at, files: d.files, bytes: d.bytes })),
      keep: info?.keep ?? STATIC.keep,
      month: now ? { requests: now.monthRequests, bytes: now.monthBytes, hits: now.monthHits, hitRate: now.monthRequests ? now.monthHits / now.monthRequests : null } : null,
    };
  }

  router.get(`${W}/services/:service/site`, wrap(async (req, res) => {
    const s = await siteOr404(req, res);
    if (!s) return;
    res.json({ site: await siteView(s) });
  }));

  router.patch(`${W}/services/:service/site`, wrap(async (req, res) => {
    const s = await siteOr404(req, res);
    if (!s) return;
    const b = req.body ?? {};
    const problems = [];
    if (b.spa === undefined && b.publishDir === undefined) problems.push({ path: 'spa', message: 'Send spa, publishDir or both.' });
    if (b.spa !== undefined && typeof b.spa !== 'boolean') problems.push({ path: 'spa', message: 'Yes or no.' });
    const publishDir = typeof b.publishDir === 'string' ? b.publishDir.trim().replace(/^(\.\/)+(?=.)/, '').replace(/(.)\/+$/, '$1') : undefined;
    if (b.publishDir !== undefined && !isPublishDir(publishDir)) problems.push({ path: 'publishDir', message: 'A folder inside the build, such as dist or build/out, or . for all of it.' });
    if (problems.length) return sendError(res, 422, 'invalid', 'Check the highlighted fields.', problems);
    if (s.status === 'suspended') return sendError(res, 409, 'conflict', 'Resume the site before you change it.');

    const spaChanged = b.spa !== undefined && b.spa !== (s.spa === true);
    const dirChanged = publishDir !== undefined && publishDir !== (s.build?.publishDir ?? STATIC.publishDir);
    if (!spaChanged && !dirChanged) return res.json({ site: await siteView(s), operation: null });
    let operation = null;
    if (s.workload) {
      try {
        ({ operation } = await platform().workloads.update(s.workspaceId, s.workload, {
          ...(spaChanged ? { site: { spa: b.spa } } : {}),
          ...(dirChanged ? { build: { publishDir } } : {}),
        }, { actor: actorOf(req.person) }));
      } catch (err) {
        if (err.code === 'conflict') return sendError(res, 409, 'conflict', 'A deploy is going. Change it when that one ends.');
        throw err;
      }
    }
    const updated = await records.services.update(s.workspaceId, s.id, {
      ...(spaChanged ? { spa: b.spa } : {}),
      ...(dirChanged ? { build: { ...s.build, publishDir } } : {}),
      ...(operation ? { status: 'deploying' } : {}),
    });
    await audit({ action: 'service.site-changed', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, ...(spaChanged ? { spa: b.spa } : {}), ...(dirChanged ? { publishDir } : {}) } });
    realtime.publish(s.workspaceId, 'site', { service: s.name });
    res.json({ site: await siteView(updated), operation: operation ? { id: operation.id, status: operation.status } : null });
  }));

  router.post(`${W}/services/:service/rollback`, wrap(async (req, res) => {
    const s = await siteOr404(req, res);
    if (!s) return;
    const id = typeof req.body?.deploy === 'string' ? req.body.deploy : '';
    if (!id) return sendError(res, 422, 'invalid', 'Choose a deploy.', [{ path: 'deploy', message: 'Choose a deploy.' }]);
    if (!s.workload || !s.current) return sendError(res, 409, 'conflict', 'The first deploy has not finished yet.');
    let result;
    try {
      result = await platform().staticSites.rollback(s.workspaceId, s.workload, id, { actor: actorOf(req.person) });
    } catch (err) {
      if (err.code === 'not_found') return sendError(res, 404, 'not_found', 'No such deploy.');
      if (err.code === 'conflict' || err.code === 'invalid') return sendError(res, 409, 'conflict', customerReason(err.message, s));
      throw err;
    }
    await audit({ action: 'service.rolled-back', actor: req.person.id, target: s.workspaceId, detail: { service: s.name, to: id, deploy: result.deploy.id } });
    res.json({ deploy: { id: result.deploy.id, status: result.deploy.result, commit: result.deploy.commit ?? null } });
  }));
}
