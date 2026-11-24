// createApp(): the NooblyJS Cloud Express app, without listening (app.js listens; the tests use an ephemeral port).
//
// Order: security headers → session cookie, who is signed in, CSRF → core's /services portal gated to platform
// operators → nooblyjs-core → dev sign-in and mock GitHub (not in production) → health → gates → the operator frame
// and /ui kit → the accelerators → sign-in routes → our API → static files → pages → 404 and errors.
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import express from 'express';
import helmet from 'helmet';
import { ROOT, loadConfig, configProblem, productionProblem } from './config.js';
import { createMailTransport, describeTransport, mailProblem, parseFrom } from './platform/mail.js';
import { contentSecurityPolicy } from './platform/csp.js';
import { lockDataDir } from './platform/lock.js';
import { createAccounts } from './platform/accounts.js';
import { createSession } from './platform/session.js';
import { INFRA_MATRIX, DEV_PEOPLE, DEV_PASSWORD, OPERATOR_ROLES } from './platform/people.js';
import { createServiceProxy } from './routes/proxy.js';
import { createHost } from './platform/host.js';
import { createRealtime, OPERATORS } from './platform/realtime.js';
import { mountAccelerators, INFRA_MOUNT, CX_BASE, CX_PUBLIC, BACK_OFFICE } from './platform/accelerators.js';
import { createCustomersLink } from './platform/customers-link.js';
import { createCoreAuth, createAuth, githubMockRoutes, googleMockRoutes } from './platform/auth.js';
import { createApi } from './routes/api.js';
import { createWorkspacesApi } from './routes/workspaces.js';
import { createPages } from './routes/pages.js';
import { createGithubConnect } from './routes/github-connect.js';
import { githubHookRoutes } from './routes/github-hooks.js';
import { createRecords } from './domain/records.js';
import { createSecrets } from './domain/secrets.js';
import { createGithub } from './github/github.js';
import { followDeploys } from './platform/workloads.js';
import { followDataStores } from './routes/datastores.js';
import { createTelemetry } from './telemetry/index.js';
import { createCron } from './scheduling/cron.js';
import { createTasks } from './scheduling/tasks.js';
import { taskTriggerRoutes } from './routes/tasks.js';
import { seedRecords } from './domain/seed.js';
import { createBilling, CardRequired } from './platform/billing.js';

const require = createRequire(import.meta.url);
const { createShell, UI_DIR } = require('nooblyjs-core/src/shell');
const { context: cxContext } = require('nooblyjs-accel-customers');
const { version: VERSION } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * @param {object} [o]
 * @param {ReturnType<typeof loadConfig>} [o.config]
 * @param {object} [o.serviceRegistry]   nooblyjs-core (the real one unless a test passes another)
 * @param {boolean} [o.seed]             write the infrastructure seed story when its folder is empty
 * @param {number} [o.mockStepMs]
 * @param {number} [o.jobCheckMs]
 * @param {(host: object) => object} [o.changeInfraHost]   tests: alter the infrastructure host before mounting
 * @param {boolean} [o.telemetryTimers]  false in tests: they flush and sweep telemetry themselves
 * @param {boolean} [o.cronTimers]       false in tests: they call cron.tick() themselves
 * @param {boolean} [o.taskTimers]       false in tests: they call tasks.tick() themselves
 * @param {boolean} [o.billingTimers]    false in tests: they call billing.handOff() and payments.tick() themselves
 * @param {{ now(): number }} [o.payClock]   tests: the payments accelerator's and billing's clock
 * @param {number} [o.eventsRecheckMs]   tests: how often an event stream re-reads who it is for
 * @param {{ sendMail(m: object): Promise<object> }} [o.mailTransport]   tests: the SMTP transport (else SMTP_URL's)
 * @param {{ staleMs?: number, heartbeatMs?: number, waitMs?: number }} [o.lock]   DATA_DIR's lock (src/platform/lock.js)
 * @param {(holder: object|null) => void} [o.onLockLost]   another process took DATA_DIR's lock: app.js stops this one
 */
export async function createApp({ config = loadConfig(), serviceRegistry = require('nooblyjs-core'), seed = false, mockStepMs, jobCheckMs, changeInfraHost = (h) => h, telemetryTimers = true, cronTimers = true, taskTimers = true, billingTimers = true, payClock, eventsRecheckMs, mailTransport, lock = {}, onLockLost } = {}) {
  const problem = configProblem(config);
  if (problem) throw new Error(problem);
  if (config.production && !config.sessionSecret) throw new Error('SESSION_SECRET is required in production.');
  // Outside development there is no mock Google to stand in for a missing client.
  if ((config.production || !config.development) && config.authType === 'google' && !(config.google?.clientId && config.google?.clientSecret)) throw new Error('AUTH_TYPE=google needs GOOGLE_OAUTH_CLIENT and GOOGLE_OAUTH_SECRET outside development.');
  const unsafe = productionProblem({ ...config, mailTransport });
  if (unsafe) throw new Error(unsafe);
  const badMail = mailProblem(config);
  if (badMail) throw new Error(badMail);
  // Before roadmap 8.7.8 the payments records were files under DATA_DIR/payments even with MongoDB. Now they are read
  // from MongoDB, so starting would show none of them: refuse rather than lose the ledger from view.
  if (config.mongodbUrl) {
    const legacy = (await fs.readdir(path.join(config.dataDir, 'payments')).catch(() => [])).filter((f) => f.endsWith('.json'));
    if (legacy.length) {
      throw new Error(`${path.join(config.dataDir, 'payments')} holds payments records in files (${legacy.length}), but with MONGODB_URL they are read from MongoDB now (roadmap 8.7.8). Start without MONGODB_URL, or move them into the pay_* collections, then move the folder away.`);
    }
  }
  await fs.mkdir(config.dataDir, { recursive: true });
  // One process per DATA_DIR (roadmap 8.7.7): taken before anything writes there, released last by shutdown().
  const dataLock = await lockDataDir(config.dataDir, {
    ...lock,
    log: { warn: (line) => console.warn(line) },
    onLost: onLockLost ?? ((holder) => console.error(`[hero-co] DATA_DIR's lock is now held by pid ${holder?.pid ?? '?'} on ${holder?.hostname ?? '?'}: this process must stop.`)),
  });

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  // Each page's CSP (src/platform/csp.js; roadmap 8.7.6): no 'unsafe-inline', and third-party files by exact URL only.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(contentSecurityPolicy(config));
  // Local network services at /<workspace>/<service>/… (routes/proxy.js), before sessions: they are other people's
  // apps, so they never see our session. Set once the accelerators are mounted.
  let serviceProxy = null;
  app.use((req, res, next) => (serviceProxy ? serviceProxy.middleware(req, res, next) : next()));
  // A Workflow's tasks triggered from code (roadmap 5.4), also before sessions: the Workflow's key is the only proof,
  // so a browser's cookie neither helps nor gets in the way (no CSRF check, no session). Set once the records exist.
  let taskTrigger = null;
  app.use('/api/v1/tasks', (req, res, next) => (taskTrigger ? taskTrigger(req, res, next) : next()));

  // Sessions run before nooblyjs-core so its /services portal (and its own login API) can be closed to customers.
  // The handlers are bound below, once core (and the accounts store on its dataService) exists.
  let session = null;
  app.use((req, res, next) => session.cookie(req, res, next));
  app.use((req, res, next) => session.identify(req, res, next));
  app.use((req, res, next) => session.csrf(req, res, next));
  // nooblyjs-core's login page is the only sign-in screen; this app answers its API (auth.js), ahead of core.
  let coreLogin = null;
  app.use((req, res, next) => (coreLogin ? coreLogin(req, res, next) : next()));
  app.use('/services', (req, res, next) => session.requirePlatform(req, res, next));

  // nooblyjs-core: one shared emitter for core and every accelerator.
  const eventEmitter = new EventEmitter().setMaxListeners(100);
  // core's settings (feature flags among them) live under DATA_DIR with everything else, not in ./.application beside
  // the code, which in the image is neither writable nor on the volume (roadmap 8.7.5). Declared before anything
  // creates the settings service, and created at once, so every part of core shares this one.
  const settingsFile = path.join(config.dataDir, 'settings', 'settings.enc.json');
  serviceRegistry.setDefaultProvider?.('settings', 'file', { filepath: settingsFile });
  serviceRegistry.initialize(app, eventEmitter, {
    security: { apiKeyAuth: { requireApiKey: false, apiKeys: [] }, servicesAuth: { requireLogin: true } },
  });
  serviceRegistry.settings?.('file', { filepath: settingsFile });
  const log = serviceRegistry.logger('console', { instanceName: 'hero-co' });
  // Records: MongoDB in production (MONGODB_URL), core's file provider otherwise (stack.md §3.1, roadmap 8.1).
  const data = config.mongodbUrl
    ? serviceRegistry.dataService('mongodb', { instanceName: 'nooblyjs-cloud', connectionString: config.mongodbUrl, database: config.mongodbDatabase })
    : serviceRegistry.dataService('file', { instanceName: 'nooblyjs-cloud', dataDir: path.join(config.dataDir, 'data') });
  for (const line of productionWarnings(config)) log.warn?.(`[hero-co] ${line}`);
  if (!config.nodeEnv) {
    log.warn?.('[hero-co] NODE_ENV is not set: the development sign-in, the development people and sample data are off. For development, run npm start (it assumes NODE_ENV=development); for production, set NODE_ENV=production.');
  }
  const accounts = createAccounts({ data });
  await accounts.init();
  const records = createRecords({ data });
  await records.init();
  const secrets = await createSecrets({ dataDir: config.dataDir, keyMaterial: config.secretKey, production: config.production });
  const github = createGithub({ records, secrets, config });
  const core = await createCoreAuth({ serviceRegistry, dataDir: config.dataDir });
  session = createSession({ accounts, config, log });

  if (config.devSignIn) {
    app.use(session.devRoutes(express));
    app.use('/dev/github', githubMockRoutes(express));
    app.use('/dev/google', googleMockRoutes(express));
  }

  app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
  // Ready: the records store answers (a load balancer or Docker's HEALTHCHECK stops sending traffic when it does not).
  app.get('/health/ready', async (req, res) => {
    try {
      await withTimeout(data.count('hero_people'), 3000);
      res.json({ status: 'ok', records: config.mongodbUrl ? 'mongodb' : 'file' });
    } catch {
      res.status(503).json({ status: 'unavailable', records: config.mongodbUrl ? 'mongodb' : 'file' });
    }
  });

  // The back office: operators only, except the customers accelerator's public marketing routes.
  // The exceptions under /infrastructure: the agent's install script and files (infra spec 8.9 R2), which a server
  // being set up fetches without a sign-in (the agent's own source, with no secret), and the operators' apps' push
  // webhooks (infra roadmap 6.9), which GitHub and GitLab send signed: the accelerator checks the signature. Both lists
  // are the accelerator's.
  let infraPublic = new Set();
  let infraPublicPosts = [];
  const infraOpen = (req) => (req.method === 'GET' && infraPublic.has(req.path)) || (req.method === 'POST' && infraPublicPosts.some((p) => req.path.startsWith(p)));
  app.use(INFRA_MOUNT, (req, res, next) => (infraOpen(req) ? next() : session.requireOperator(req, res, next)));
  // The payments accelerator's public paths (provider webhooks, hosted invoices, the 3-D Secure hand-off, the card
  // form's components) are its own list, set once it is mounted.
  let cxPublic = [CX_PUBLIC];
  app.use(CX_BASE, (req, res, next) => (cxPublic.some((p) => req.originalUrl.startsWith(`${p}/`) || req.originalUrl === p) ? next() : session.requireOperator(req, res, next)));

  const realtime = createRealtime();
  let shell = null;
  const host = createHost({ express, session, accounts, dataDir: config.dataDir, frame: () => shell.frame });
  const audit = (entry) => host.record(entry).catch((err) => log.warn?.(`[hero-co] audit write failed: ${err.message}`));
  host.events.on((event) => realtime.publish(OPERATORS, 'infrastructure', event));
  shell = createShell({
    express,
    auth: session.requireOperator,
    can: host.can,
    permissionsFor: async (role) => Object.keys(INFRA_MATRIX).filter((p) => INFRA_MATRIX[p].includes(role)),
    log,
  });
  // The back office (/admin) is the frame's first page; mountAccelerators adds the rail's buttons.
  shell.builtIn(BACK_OFFICE);
  app.use(shell.router);
  app.use('/ui', express.static(UI_DIR, { index: false, redirect: false }));

  /** Opens our secretRefs for the platform when a container starts (infra 8.9 R9); never logged, never kept there. */
  async function resolveSecrets(tenantId, refs) {
    const out = {};
    for (const ref of refs) {
      const m = /^hero:(svc|grp):([^:]+):([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
      if (!m) continue;
      const [, kind, id, key] = m;
      const owner = kind === 'svc'
        ? (await records.services.list(tenantId)).find((s) => s.id === id)
        : await records.envGroups.get(tenantId, id);
      const v = (kind === 'svc' ? owner?.env : owner?.vars)?.find((e) => e.key === key);
      if (v?.sealed) out[ref] = secrets.open(v.sealed, `${kind}:${id}:${key}`);
    }
    return out;
  }

  const accelerators = await mountAccelerators({
    app, eventEmitter, serviceRegistry, shell, config, log, mockStepMs, jobCheckMs, resolveSecrets, payClock, payJobs: billingTimers,
    dataDir: config.dataDir,
    infraHost: { ...changeInfraHost(host.hostFor(path.join(config.dataDir, 'infrastructure'))), sampleData: config.sampleData === true },
    mail: {
      transport: mailTransport ?? createMailTransport(config),
      from: parseFrom(config.emailFrom) ?? (mailTransport ? { address: 'no-reply@localhost' } : null),
    },
  });
  infraPublic = new Set(accelerators.mounted.infrastructure.publicPaths ?? []);
  infraPublicPosts = accelerators.mounted.infrastructure.publicPostPrefixes ?? [];
  cxPublic = [CX_PUBLIC, ...(accelerators.mounted.payments?.publicPaths ?? [])];

  const platform = () => accelerators.mounted.infrastructure.services.platform;
  const deploysFollower = followDeploys({ eventEmitter, records, realtime, platform, log });
  const dataFollower = followDataStores({ eventEmitter, records, realtime, log });
  // Metrics and logs of services (roadmap 4.1–4.3): kept, and passed to the workspace's live channel.
  const telemetry = createTelemetry({
    serviceRegistry, eventEmitter, platform, records, realtime, log, dataDir: config.dataDir,
    workspaceIds: async () => (await accounts.listWorkspaces()).map((w) => w.id),
    timers: telemetryTimers,
  });
  // Cron Jobs (roadmap 5.3): their schedules, and their runs into the logs and the live channel.
  const cron = createCron({
    records, platform, eventEmitter, realtime, telemetry, log,
    workspaceIds: async () => (await accounts.listWorkspaces()).map((w) => w.id),
    timers: cronTimers,
  });
  // Workflows (roadmap 5.4): their queues, retries, and their runs into the logs and the live channel.
  const tasks = createTasks({
    records, platform, eventEmitter, realtime, telemetry, log,
    workspaceIds: async () => (await accounts.listWorkspaces()).map((w) => w.id),
    timers: taskTimers,
  });
  const proxy = createServiceProxy({ records, platform, eventEmitter, log, onRequest: telemetry.request });
  await proxy.load((await accounts.listWorkspaces()).map((w) => w.id));
  serviceProxy = proxy;

  const link = createCustomersLink({ cx: accelerators.mounted.customers, systemContext: cxContext.systemContext, accounts, log, audit });
  await link.ensureTemplates();
  await ensureCoreAdmins({ accounts, core, log });
  // Billing (roadmap 7.4–7.7): the catalogue, a billing account per workspace (and one for each new workspace), the
  // hourly usage hand-off, the free tier, suspension of a delinquent workspace's paid services.
  const billing = createBilling({
    pay: accelerators.mounted.payments, accounts, records, platform, link, eventEmitter, realtime, audit, config, log,
    ...(payClock ? { clock: payClock } : {}), timers: billingTimers,
  });
  if (config.devSignIn) {
    // Development: Stevie's workspace has a test card and three closed months of invoices (made before its billing
    // account, so before the hook below opens one).
    await billing.init({ ensureAll: false });
    await seedDevPeople({ accounts, core, link });
    if (!config.test) await billing.seedDevelopment('exclusivity-life');
  }
  accounts.onWorkspaceCreated((ws) => billing.ensureWorkspace(ws).then(() => undefined, (err) => log.warn?.(`[hero-co] billing account for ${ws.id} failed: ${err.message}`)));
  await billing.init();
  if (config.smtpUrl) log.info?.(`[hero-co] Account emails are sent through ${describeTransport(config.smtpUrl)} from ${config.emailFrom}.`);
  else if (!mailTransport) log.warn?.(`[hero-co] No SMTP_URL${config.emailOff ? ' (EMAIL=off)' : ''}: account emails go to the customers accelerator's console outbox only.`);

  if (seed) {
    const infraDir = path.join(config.dataDir, 'infrastructure');
    const empty = (await fs.readdir(infraDir).catch(() => [])).filter((f) => !f.startsWith('.') && !['secrets', 'local', 'local-agent', 'config.yaml'].includes(f)).length === 0;
    if (empty && config.sampleData) {
      await accelerators.mounted.infrastructure.seed({ reset: false });
      await seedRecords({ records, secrets, platform, accounts });
      await accelerators.mounted.infrastructure.resume();
    } else if (empty) {
      // Outside development the folder is marked as started without sample content, so nothing seeds it later.
      await accelerators.mounted.infrastructure.seed({ reset: false, content: false });
    }
  }

  const auth = createAuth({ express, session, accounts, core, link, config, audit, log });
  coreLogin = auth.login;
  app.use('/api/v1/auth', auth.api);
  app.use(auth.pages);
  taskTrigger = taskTriggerRoutes({ express, records, tasks: () => tasks, audit });
  // Prices from the payments catalogue (the create form's Summary): not a secret, so no sign-in.
  app.get('/api/v1/prices', (req, res) => res.json(billing.prices()));
  app.use('/api/v1', createWorkspacesApi({ express, session, accounts, link, config, audit, realtime, records, secrets, github, platform, telemetry, cron, tasks, billing, pay: accelerators.mounted.payments }));
  app.use('/api/v1', createApi({ express, session, realtime, accelerators: accelerators.describe, about: { name: 'nooblyjs-cloud', version: VERSION }, ...(eventsRecheckMs ? { recheckMs: eventsRecheckMs } : {}) }));
  app.use(express.static(path.join(ROOT, 'public'), { index: false, redirect: false }));
  app.use(createGithubConnect({ express, session, accounts, github, config, audit, log }));
  // GitHub's push webhook (roadmap 3.8): no sign-in; the HMAC of the body is the proof.
  app.use(githubHookRoutes({ express, records, github, platform, audit, realtime, log }));
  app.use(createPages({ express, session, frame: shell.frame }));

  app.use((req, res) => {
    if (req.originalUrl.includes('/api/')) return res.status(404).json({ error: { code: 'not_found', message: 'No such API route.' } });
    res.status(404).type('text').send('Not found.');
  });
  // Never send a fault's message to the client.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof CardRequired && req.originalUrl.includes('/api/')) return res.status(402).json({ error: { code: err.code, message: err.message } });
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log.error?.(`[hero-co] ${req.method} ${req.originalUrl}: ${err.stack ?? err.message}`);
    const message = status === 500 ? 'Something went wrong on our side.' : (err.expose ? err.message : 'The request was not valid.');
    if (req.originalUrl.includes('/api/')) return res.status(status).json({ error: { code: status === 500 ? 'internal' : 'invalid', message } });
    res.status(status).type('text').send(message);
  });

  /** Grants or removes an operator role (app.js --operator). */
  async function setOperator(email, role) {
    const person = await accounts.findPersonByEmail(email ?? '');
    if (!person) throw new Error(`No person with the email ${email}. They sign up first.`);
    if (role !== 'none' && !OPERATOR_ROLES.includes(role)) throw new Error(`The role is one of ${OPERATOR_ROLES.join(', ')} or none.`);
    const updated = await accounts.updatePerson(person.id, { operator: role === 'none' ? null : role, sessionEpoch: (person.sessionEpoch ?? 0) + 1 });
    await audit({ action: 'person.operator-changed', actor: 'cli', target: person.id, detail: { role } });
    return updated;
  }

  return {
    app,
    config,
    host,
    /** Call with the HTTP server once listening: local servers' agents connect over a WebSocket (infra spec 8.9). */
    attachUpgrades: (server) => host.attachUpgrades(server),
    realtime,
    telemetry,
    cron,
    tasks,
    accelerators,
    billing,
    /** The payments accelerator's mount() result. */
    pay: accelerators.mounted.payments,
    accounts,
    records,
    /** core's dataService behind accounts and records (file or mongodb). */
    data,
    github,
    platform,
    core,
    link,
    /** The seed story's hero-co half (services, deploys, GitHub) on top of the infrastructure seed. */
    seedRecords: ({ reset = false } = {}) => seedRecords({ records, secrets, platform, accounts, reset }),
    /** For the tests: resolves when the platform has no operation under way and every deploy event is written. */
    async idle() {
      await accelerators.mounted.infrastructure.idle();
      await deploysFollower.idle();
      await cron.idle();
      await tasks.idle();
      await telemetry.idle();
      await billing.idle();
    },
    serviceRegistry,
    eventEmitter,
    setOperator,
    async shutdown() {
      cron.stop();
      tasks.stop();
      deploysFollower.stop();
      dataFollower.stop();
      proxy.stop();
      await telemetry.stop();
      billing.shutdown();
      await accelerators.shutdown();
      await session.close?.();
      await serviceRegistry.shutdown?.();
      await dataLock.release();
    },
  };
}

/** Rejects when `promise` takes longer than `ms`. */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * What a production start-up lacks without failing (the missing secrets fail where they are used: SESSION_SECRET
 * above, HERO_SECRET_KEY in secrets.js, PAY_SIGNING_SECRET in the payments accelerator).
 * @returns {string[]}
 */
export function productionWarnings(config) {
  if (!config.production) return [];
  const out = [];
  if (!config.mongodbUrl) out.push('MONGODB_URL is not set: records are files under DATA_DIR, so only one instance can run.');
  if (!config.redisUrl) out.push('REDIS_URL is not set: sessions are kept in memory, so a restart signs everyone out.');
  if (!config.trustProxy) out.push('TRUST_PROXY is not set: behind a load balancer, secure cookies and client addresses need TRUST_PROXY=1.');
  if (!/^https:\/\//.test(config.publicUrl)) out.push(`PUBLIC_URL (${config.publicUrl}) is not https: links in emails and the GitHub callback use it.`);
  return out;
}

/**
 * nooblyjs-core's admins (its start-up admin, admin@localhost unless DEFAULT_ADMIN_EMAIL says otherwise, whose password
 * is in <dataDir>/auth/INITIAL_ADMIN_PASSWORD.txt or DEFAULT_ADMIN_PASSWORD) are this app's platform operators, so
 * they can sign in on core's login page and land on /admin. An existing account with the same email is left alone.
 */
async function ensureCoreAdmins({ accounts, core, log }) {
  for (const admin of await core.getUsersInRole('admin')) {
    if (!admin?.email) continue;
    let person = await accounts.findPersonByEmail(admin.email);
    if (!person) {
      person = await accounts.createPerson({ name: admin.fullName || 'Administrator', email: admin.email, emailVerified: true, operator: 'platform', signedUpWith: 'core-admin' });
      log.info?.(`[hero-co] ${admin.email} (nooblyjs-core admin) is a platform operator.`);
    }
    // The admin deploys like a customer, in a workspace of their own (/w/<id>; services at /<id>/<service>/).
    if (person.signedUpWith === 'core-admin' && !(await accounts.workspacesFor(person.id)).length) {
      const ws = await accounts.createWorkspace({ name: person.name || 'Administrator', ownerId: person.id });
      log.info?.(`[hero-co] ${admin.email} has the workspace ${ws.id}.`);
    }
  }
}

/** The development people (people.js), created once: each with a workspace, verified, linked to a customer. */
async function seedDevPeople({ accounts, core, link }) {
  for (const p of DEV_PEOPLE) {
    if (await accounts.getPerson(p.id)) continue;
    try {
      await core.createUser({ email: p.email, fullName: p.name, password: DEV_PASSWORD, role: 'user' });
    } catch (err) {
      if (!/already exists/i.test(err.message)) throw err;
    }
    const person = await accounts.createPerson({ id: p.id, name: p.name, email: p.email, emailVerified: true, operator: p.operator, signedUpWith: 'seed' });
    const workspace = p.workspace ? await accounts.createWorkspace({ id: p.workspace.id, name: p.workspace.name, ownerId: person.id }) : null;
    if (!p.operator) await link.linkPerson(person, { workspace, source: 'seed' });
  }
}
