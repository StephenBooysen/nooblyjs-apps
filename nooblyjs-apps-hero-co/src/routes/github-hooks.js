// The auto-deploy webhook (roadmap 3.8): POST /hooks/github/<workspace>, sent by GitHub with no sign-in. The body's
// HMAC (X-Hub-Signature-256) must match that workspace's webhook secret; an unknown workspace gets the same 401 as a
// bad signature, so the answer tells nothing about which workspaces exist. Services of that workspace on the pushed
// repository and branch, with auto-deploy on and not suspended, deploy the pushed commit. A redelivered event (the
// same X-GitHub-Delivery) deploys nothing again.
const MAX_SEEN = 500;

/**
 * @param {object} o
 * @param {typeof import('express')} o.express
 * @param {ReturnType<import('../domain/records.js').createRecords>} o.records
 * @param {ReturnType<import('../github/github.js').createGithub>} o.github
 * @param {() => object} o.platform   the infrastructure accelerator's platform services
 */
export function githubHookRoutes({ express, records, github, platform, audit, realtime, log }) {
  const router = express.Router();
  const seen = new Set();
  const reply = (res, status, body) => res.status(status).json(body);

  router.post('/hooks/github/:workspace', express.raw({ type: () => true, limit: '1mb' }), async (req, res, next) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const event = req.get('x-github-event') ?? '';
      const delivery = req.get('x-github-delivery') ?? '';
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply(res, 400, { error: { code: 'invalid', message: 'Send the event as JSON (content type application/json).' } });
      }
      const ws = req.params.workspace;
      if (!(await github.verify(ws, raw, req.get('x-hub-signature-256')))) return reply(res, 401, { error: { code: 'signature', message: 'The signature does not match.' } });
      const repo = String(body?.repository?.full_name ?? '').toLowerCase();
      const services = (await records.services.list(ws)).filter((s) => s.source?.provider === 'github' && String(s.source.repo).toLowerCase() === repo);
      if (event === 'ping') return reply(res, 200, { ok: true });
      if (event !== 'push') return reply(res, 202, { ignored: `GitHub ${event} events start nothing.` });
      const key = `${ws}:${delivery}`;
      if (delivery && seen.has(key)) return reply(res, 200, { duplicate: true, deploys: [] });
      if (delivery) {
        seen.add(key);
        if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
      }
      const ref = String(body.ref ?? '');
      if (!ref.startsWith('refs/heads/') || body.deleted) return reply(res, 202, { ignored: 'Only a push to a branch deploys.', deploys: [] });
      const branch = ref.slice('refs/heads/'.length);
      const commit = /^[0-9a-f]{40}$/.test(body.after ?? '') ? body.after : undefined;
      const message = String(body.head_commit?.message ?? '').split('\n')[0].slice(0, 200) || undefined;
      const pusher = String(body.pusher?.name ?? body.sender?.login ?? 'GitHub').slice(0, 100);

      const deploys = [];
      for (const s of services) {
        if (!s.autoDeploy || s.source.branch !== branch || !s.workload) continue;
        if (s.status === 'suspended') {
          deploys.push({ workspace: s.workspaceId, service: s.name, skipped: 'suspended' });
          continue;
        }
        try {
          const { operation } = await platform().workloads.deploy(s.workspaceId, s.workload, { commit, message, trigger: 'push', actor: { id: `github:${pusher}`, name: pusher, kind: 'github' } });
          deploys.push({ workspace: s.workspaceId, service: s.name, operation: operation.id });
          await audit({ action: 'service.deployed', actor: `github:${pusher}`, target: s.workspaceId, detail: { service: s.name, trigger: 'push', branch, commit: commit ?? null } });
          realtime.publish(s.workspaceId, 'deploy', { service: s.name, status: 'deploying' });
        } catch (err) {
          log?.warn?.(`[hero-co] push deploy of ${s.workspaceId}/${s.name}: ${err.message}`);
          deploys.push({ workspace: s.workspaceId, service: s.name, skipped: err.message });
        }
      }
      return reply(res, 202, { deploys: deploys.map((d) => ({ service: d.service, ...(d.operation ? { started: true } : { skipped: d.skipped }) })) });
    } catch (err) {
      return next(err);
    }
  });
  return router;
}
