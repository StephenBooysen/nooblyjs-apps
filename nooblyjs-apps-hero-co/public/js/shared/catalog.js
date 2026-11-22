// The catalogue the create flow offers (product.md §4, §6.3): instance types, regions, runtimes and which service types
// can be created yet. Shared by the server (validation, the workload spec) and the browser (the form and its Summary),
// so it imports nothing.
//
// Prices are flat per service per month, whatever the instance count up to MAX_INSTANCES (decided 2026-11-20; product.md
// §11). Web services sleep when idle and wake on the next request, which is what keeps a flat price affordable (SLEEP
// below; roadmap 3.11). The region's ingress holds that request while the service wakes, so only a service behind it
// sleeps: not a Private Service (nothing in front of it), and not one on the Local network.

/**
 * Instance types: the CPU and memory reserved for each instance, and how many days of a service's logs are kept
 * (product.md §6.5 fixes Standard at 7; the others are provisional, decided 2026-11-21).
 */
export const PLANS = [
  { key: 'starter', name: 'Starter', cpu: 0.5, memoryMb: 512, priceUsd: 0, logDays: 3 },
  { key: 'standard', name: 'Standard', cpu: 1, memoryMb: 2048, priceUsd: 5, logDays: 7 },
  { key: 'pro', name: 'Pro', cpu: 2, memoryMb: 4096, priceUsd: 20, logDays: 14 },
  { key: 'pro-plus', name: 'Pro Plus', cpu: 4, memoryMb: 8192, priceUsd: 100, logDays: 30 },
];

/**
 * Postgres and Key Value plans (roadmap 6.2, 6.3; infra specs 8.6, 8.7). Postgres: connections at once and the storage
 * its meter measures against; Key Value: memory (the store's limit, keys evicted past it) and clients at once.
 * Prices are provisional, as the instance types' are.
 */
export const DATA_PLANS = {
  postgres: [
    { key: 'starter', name: 'Starter', connections: 20, storageMb: 1000, priceUsd: 7 },
    { key: 'standard', name: 'Standard', connections: 50, storageMb: 10_000, priceUsd: 20 },
    { key: 'pro', name: 'Pro', connections: 100, storageMb: 50_000, priceUsd: 65 },
  ],
  keyvalue: [
    { key: 'starter', name: 'Starter', memoryMb: 256, connections: 100, priceUsd: 0 },
    { key: 'standard', name: 'Standard', memoryMb: 1024, connections: 500, priceUsd: 10 },
    { key: 'pro', name: 'Pro', memoryMb: 4096, connections: 2000, priceUsd: 32 },
  ],
};
/** What a data store links as (Link to service), and its starting values. Backups: daily at `backupTime` UTC, 7 kept. */
export const DATA_DEFAULTS = {
  postgres: { plan: 'starter', linkKey: 'DATABASE_URL', backupTime: '03:00', keepBackups: 7 },
  keyvalue: { plan: 'starter', linkKey: 'REDIS_URL', eviction: 'allkeys-lru' },
};
export const EVICTIONS = [
  { key: 'allkeys-lru', name: 'Least recently used (a cache)' },
  { key: 'allkeys-lfu', name: 'Least frequently used' },
  { key: 'volatile-lru', name: 'Least recently used, keys with an expiry only' },
  { key: 'volatile-ttl', name: 'Nearest expiry first' },
  { key: 'noeviction', name: 'None: refuse writes when full (a queue)' },
];
export const DATA_TYPES = ['postgres', 'keyvalue'];
export const dataPlanOf = (type, key) => DATA_PLANS[type]?.find((p) => p.key === key) ?? null;
/** "20 connections · 1 GB storage" / "256 MB memory · 100 clients". */
export function dataPlanText(type, p) {
  if (!p) return '';
  // Storage in decimal GB (as the meters count bytes); memory in binary, as instance types' is.
  return type === 'postgres' ? `${p.connections} connections · ${p.storageMb >= 1000 ? `${p.storageMb / 1000} GB` : `${p.storageMb} MB`} storage` : `${p.memoryMb >= 1024 ? `${p.memoryMb / 1024} GB` : `${p.memoryMb} MB`} memory · ${p.connections.toLocaleString('en')} clients`;
}

/** Bandwidth a workspace may send each month before it pays for more (the dashboard's "48 GB of 100"; provisional). */
export const BANDWIDTH_INCLUDED_GB = 100;
export const DEFAULT_PLAN = 'standard';
export const MAX_INSTANCES = 10;

/** Idle sleep: a service with no requests for `afterMinutes` scales to zero and wakes on the next request. */
export const SLEEP = { afterMinutes: 15, wakeText: 'The first request after a sleep takes a few seconds while it wakes.' };

/**
 * Regions (the mock-up's four). `platform` is the infrastructure accelerator's catalogue region that runs it; a region
 * without one is shown but cannot be chosen yet.
 */
export const REGIONS = [
  // Your own servers on the local network (infra spec 8.9): services run there for real, at <base URL>/<workspace>/<service>.
  { id: 'local', name: 'Local network', platform: 'lan-dev', local: true },
  { id: 'af-south', name: 'Johannesburg', platform: 'af-south-1' },
  { id: 'eu-central', name: 'Frankfurt', platform: null },
  { id: 'us-east', name: 'Virginia', platform: 'us-east-1' },
  { id: 'ap-southeast', name: 'Singapore', platform: null },
];

/** Runtimes, in the mock-up's order, with the accelerator's names (spec 8.1 build.runtime). */
/**
 * Runtimes, and what each does when the Build or Start command is left empty (the infrastructure agent's templates:
 * nooblyjs-accl-infrastructure agent/docker.js DEFAULTS). The create form shows these as placeholders.
 */
export const RUNTIMES = [
  { key: 'node22', name: 'Node.js 22', defaultBuild: 'npm ci (or npm install), then npm run build if it has one', defaultStart: 'npm start' },
  { key: 'dockerfile', name: 'Docker (Dockerfile in repo)', defaultBuild: 'the Dockerfile builds it', defaultStart: 'the Dockerfile\'s CMD' },
  { key: 'python312', name: 'Python 3.12', defaultBuild: 'pip install -r requirements.txt', defaultStart: 'gunicorn app:app, or python app.py' },
  { key: 'go123', name: 'Go 1.23', defaultBuild: 'go build', defaultStart: 'the built program' },
];

/**
 * The service types this phase can create, and what each becomes on the platform. `plan`: it picks an instance type;
 * `instances`: it picks a count too; `schedule`: it runs on a cron schedule (src/scheduling/cron.js) with a command
 * instead of a start command; `tasks`: it has named tasks, each a command run in a container of its own when asked,
 * up to a number at once, retried when they fail (src/scheduling/tasks.js; stack.md D11). Postgres and Key Value wait
 * for infra 8.6 and 8.7, Sandbox Groups for an isolation decision (product.md §11).
 */
export const CREATABLE = {
  web: { kind: 'service', label: 'Web Service', action: 'Deploy web service', port: true, plan: true, instances: true, publicUrl: true, sleeps: true },
  private: { kind: 'private', label: 'Private Service', action: 'Deploy private service', port: true, plan: true, instances: true, publicUrl: false, sleeps: false },
  worker: { kind: 'worker', label: 'Background Worker', action: 'Deploy worker', port: false, plan: true, instances: true, publicUrl: false, sleeps: false },
  static: { kind: 'static', label: 'Static Site', action: 'Deploy static site', port: false, plan: false, instances: false, publicUrl: true, sleeps: false },
  cron: { kind: 'job', label: 'Cron Job', action: 'Create cron job', port: false, plan: true, instances: false, publicUrl: false, sleeps: false, schedule: true },
  workflow: { kind: 'job', label: 'Workflow', action: 'Create workflow', port: false, plan: true, instances: false, publicUrl: false, sleeps: false, tasks: true },
};
/**
 * A Static Site's starting values (roadmap 5.2; infra spec 8.8). `publishDir`: the folder the build writes the site to.
 * On the Local network a site answers under /<workspace>/<name>/, so its build gets that path as `basePathVar`.
 */
export const STATIC = { publishDir: 'dist', basePathVar: 'BASE_PATH', keep: 5 };
/** Whether a publish directory is one: a folder inside the build (no leading /, no .., no trailing /), or . for all. */
export const isPublishDir = (v) => typeof v === 'string' && v.length <= 200 && (v === '.' || (/^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/.test(v) && !v.endsWith('/') && !v.split('/').some((s) => s === '' || s === '.' || s === '..')));
/** A run's command and schedule as the create form starts them. */
export const CRON_DEFAULTS = { schedule: '0 2 * * *', plan: 'starter' };

/**
 * A Workflow's limits and the create form's starting values. `concurrency`: task runs at once; `retries`: how many more
 * times a failed run is tried; `queue`: runs that may wait at once (the dashboard's "Queue 5 of 1,000"). A retry waits
 * `backoffS` seconds, doubling each time, up to `backoffMaxS`.
 */
export const WORKFLOW = {
  maxTasks: 20, maxConcurrency: 10, maxRetries: 5, queue: 1000, inputKb: 16, backoffS: 10, backoffMaxS: 300,
  defaults: { plan: 'starter', concurrency: 2, retries: 2 },
};
/** A task's name: lower-case letters, digits and hyphens, as in the trigger URL. */
export const TASK_NAME = /^[a-z][a-z0-9-]{0,62}$/;
/** The variables each task run gets, besides the service's own. */
export const TASK_ENV = ['TASK_NAME', 'TASK_INPUT', 'TASK_RUN_ID', 'TASK_ATTEMPT'];

export const planOf = (key) => PLANS.find((p) => p.key === key) ?? null;
export const regionOf = (id) => REGIONS.find((r) => r.id === id) ?? null;
export const runtimeOf = (key) => RUNTIMES.find((r) => r.key === key) ?? null;

/** "1 CPU · 2 GB" */
export function specText(plan) {
  const mem = plan.memoryMb >= 1024 ? `${plan.memoryMb / 1024} GB` : `${plan.memoryMb} MB`;
  return `${plan.cpu} CPU · ${mem}`;
}

/** "$0", "$—" while a price is undecided. */
export const priceText = (usd) => (usd === null || usd === undefined ? '$—' : `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`);

/** The monthly price of a service on a plan: { usd, text }. Flat: the instance count does not change it. */
export function estimate(planKey) {
  const plan = planOf(planKey);
  if (!plan || plan.priceUsd === null) return { usd: null, text: '$— / mo' };
  return { usd: plan.priceUsd, text: `${priceText(plan.priceUsd)} / mo` };
}
