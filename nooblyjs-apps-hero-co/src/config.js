import fs from 'node:fs';
// Configuration from the environment (stack.md §6). Read once, by createApp() or app.js; tests pass their own.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 11010;
/** The NODE_ENV values the app knows. Anything else (a typo such as "prod") refuses to start: checkConfig(). */
export const NODE_ENVS = ['development', 'test', 'production'];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ port: number, dataDir: string, production: boolean, publicUrl: string, appDomain: string,
 *   trustProxy: boolean, devSignIn: boolean, cxTrackingSecret: string|undefined, sessionSecret: string|undefined,
 *   github: { clientId: string|undefined, clientSecret: string|undefined }, secretKey: string|undefined }}
 */
function localAgentOf(env, development) {
  if (['fork', 'mock', 'off'].includes(env.HERO_LOCAL_AGENT)) return env.HERO_LOCAL_AGENT;
  if (env.NODE_ENV === 'test') return 'mock';
  if (!development) return 'off';
  return fs.existsSync('/var/run/docker.sock') ? 'fork' : 'off';
}

function authTypeOf(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'google' || v === 'local' ? v : 'open';
}

export function loadConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV ?? '').trim();
  const production = nodeEnv === 'production';
  // Development features (the development sign-in and people, the mock GitHub and Google, sample data, the local
  // agent) need NODE_ENV=development or test said out loud. Unset, they are off (roadmap 8.7.3: fail closed).
  const development = nodeEnv === 'development' || nodeEnv === 'test';
  const port = Number(env.PORT ?? DEFAULT_PORT);
  return {
    port,
    nodeEnv,
    dataDir: path.resolve(ROOT, env.DATA_DIR ?? '.application'),
    production,
    development,
    // Tests: the development people without the development billing seed (test/helpers.js gives their cards).
    test: env.NODE_ENV === 'test',
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    appDomain: env.APP_DOMAIN ?? 'nooblyjs.app',
    // The agent for the Local network region (infra spec 8.9) on this machine: 'fork' runs the real agent with this
    // machine's Docker, 'mock' an in-process one (tests), 'off' none. Default: 'mock' in tests, 'off' in production,
    // in development 'fork' when Docker's socket is here, otherwise 'off'. HERO_LOCAL_AGENT overrides.
    localAgent: localAgentOf(env, development),
    // The Local network's Postgres server (roadmap 6.2): an admin connection string, such as
    // postgres://postgres:<password>@127.0.0.1:5432/postgres. Customer databases are made on it, each with its own role.
    localPostgresUrl: env.HERO_LOCAL_POSTGRES_URL || null,
    // One proxy hop: set TRUST_PROXY=1 behind a load balancer; Codespaces port forwarding is one (TRUST_PROXY=0 turns it off).
    trustProxy: env.TRUST_PROXY !== '0' && (env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true' || env.CODESPACES === 'true'),
    // The development sign-in (/dev/login, X-Dev-Person), the mock GitHub and Google, and the development people:
    // only with NODE_ENV=development or test (DEV_SIGN_IN=0 turns them off there too).
    devSignIn: development && env.DEV_SIGN_IN !== '0',
    // The sample content (the infrastructure accelerator's seed story, the demo customers, `npm run seed`): only in
    // development and tests (roadmap 8.7.2).
    sampleData: development,
    // The customers accelerator's demo customers: in development only, not in tests (on files they take about a second
    // each to write). true, or { customers, organizations } for how many.
    demoCustomers: nodeEnv === 'development',
    // Records (people, workspaces, services, deploys) in MongoDB when MONGODB_URL is set (production, roadmap 8.1);
    // otherwise core's file provider under DATA_DIR/data. MONGODB_DATABASE names the database.
    mongodbUrl: env.MONGODB_URL || null,
    mongodbDatabase: env.MONGODB_DATABASE || 'nooblyjs_cloud',
    // Sessions in Redis when REDIS_URL (or SESSION_REDIS_URL) is set; core's createSessionStore reads it itself.
    redisUrl: env.SESSION_REDIS_URL || env.REDIS_URL || null,
    cxTrackingSecret: env.CX_TRACKING_SECRET,
    sessionSecret: env.SESSION_SECRET,
    // GitHub OAuth app. Without it, in development, GitHub sign-in uses the mock at /dev/github.
    github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    // How people sign in and get an account (AUTH_TYPE; the older AUTHTYPE is read when AUTH_TYPE is not set):
    //   unset   'open': email and password or GitHub; anyone signs up on the form at /.
    //   local   'local': email and password or GitHub, by invitation only: "Create New Account" goes to core's register
    //           screen (accounts need an invitation); the sign-up form takes only a valid invitation for that email.
    //   google  'google': Google only; core's sign-in page goes straight to Google (?local=1 keeps the password form
    //           for operators).
    authType: authTypeOf(env.AUTH_TYPE ?? env.AUTHTYPE),
    // Google OAuth client (GOOGLE_OAUTH_CLIENT / GOOGLE_OAUTH_SECRET, or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Its
    // authorised redirect URI is <PUBLIC_URL>/services/authservice/api/google/callback. Without it, outside
    // production, AUTH_TYPE=google uses the mock at /dev/google.
    // GOOGLE_REDIRECT_BASE: the address Google sends the browser back to, when it is not PUBLIC_URL (a Codespaces
    // forwarded address, say https://<codespace>-11010.app.github.dev); the callback path is added to it.
    google: {
      clientId: env.GOOGLE_OAUTH_CLIENT || env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_SECRET || env.GOOGLE_CLIENT_SECRET,
      redirectBase: /^https?:\/\/[^/\s]+/.test(env.GOOGLE_REDIRECT_BASE ?? '') ? env.GOOGLE_REDIRECT_BASE.trim().replace(/\/+$/, '') : null,
    },
    // Encrypts environment variables and GitHub tokens at rest (required in production; a dev key file otherwise).
    secretKey: env.HERO_SECRET_KEY,
    // The infrastructure accelerator's secret store (cloud credentials) and nooblyjs-core's settings. Both read these
    // from the environment themselves, and fall back to SESSION_SECRET; production refuses that (roadmap 8.7.4).
    infraSecretKey: env.INFRA_SECRET_KEY || null,
    settingsSecret: env.SETTINGS_SECRET || null,
    // The infrastructure accelerator's cloud providers (it reads INFRA_PROVIDERS itself; default the mock cloud).
    // Production refuses the mock unless INFRA_ALLOW_MOCK=1 says so on purpose.
    infraProviders: String(env.INFRA_PROVIDERS || 'mock').split(',').map((s) => s.trim()).filter(Boolean),
    allowMockCloud: env.INFRA_ALLOW_MOCK === '1',
    // Account emails (roadmap 8.7.1): SMTP_URL (smtps://user:password@host:465, or smtp://… on 587 with STARTTLS) and
    // the address they come from. Production refuses to start without SMTP_URL unless EMAIL=off says so on purpose.
    smtpUrl: env.SMTP_URL || null,
    emailFrom: env.EMAIL_FROM || null,
    emailOff: env.EMAIL === 'off',
    // The Content-Security-Policy (src/platform/csp.js): enforce (default) | report-only | off (refused in production),
    // and origins added to script, style, connect and img (CSP_EXTRA_SOURCES, space-separated).
    cspMode: String(env.CSP_MODE || 'enforce').toLowerCase(),
    cspExtraSources: String(env.CSP_EXTRA_SOURCES || '').split(/\s+/).filter(Boolean),
    // The card provider (roadmap 7.3): Stripe when STRIPE_SECRET_KEY is set (with STRIPE_WEBHOOK_SECRET and
    // STRIPE_PUBLISHABLE_KEY; the payments accelerator reads them from the environment), else the mock provider, which
    // the accelerator refuses in production. PAY_SIGNING_SECRET signs invoice and payment links (required in production).
    payProvider: env.STRIPE_SECRET_KEY ? 'stripe' : 'mock',
  };
}

/**
 * What stops the app starting, as one message, or null. createApp() throws it; app.js prints it.
 * @param {ReturnType<typeof loadConfig>} config
 */
export function configProblem(config) {
  if (config.nodeEnv && !NODE_ENVS.includes(config.nodeEnv)) {
    return `NODE_ENV is "${config.nodeEnv}": set it to production (or development or test). Anything else would run without production's protections.`;
  }
  if (!config.nodeEnv && /^https:\/\//.test(config.publicUrl ?? '')) {
    return 'NODE_ENV is not set but PUBLIC_URL is https: set NODE_ENV=production (or NODE_ENV=development on a development server).';
  }
  if (config.production && config.devSignIn) return 'The development sign-in cannot run with NODE_ENV=production.';
  return null;
}

/**
 * What production lacks that would make it unsafe, as one message, or null (roadmap 8.7.4): a key of its own for each
 * store of secrets, and no mock cloud standing in for a real one.
 * @param {ReturnType<typeof loadConfig>} config
 */
export function productionProblem(config) {
  if (!config.production) return null;
  const keys = [
    ['SESSION_SECRET', config.sessionSecret],
    ['HERO_SECRET_KEY', config.secretKey],
    ['INFRA_SECRET_KEY', config.infraSecretKey],
    ['SETTINGS_SECRET', config.settingsSecret],
  ];
  const missing = keys.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return `Production needs ${missing.join(', ')}: a long random string each (openssl rand -hex 32), all different.`;
  if (new Set(keys.map(([, v]) => v)).size !== keys.length) {
    return 'SESSION_SECRET, HERO_SECRET_KEY, INFRA_SECRET_KEY and SETTINGS_SECRET must all differ: rotating one must not open, or lock, the others.';
  }
  if (config.cspMode === 'off') return 'CSP_MODE=off sends no Content-Security-Policy: production keeps it (CSP_MODE=report-only to find what it blocks).';
  if (!config.smtpUrl && !config.emailOff && !config.mailTransport) {
    return 'Production needs SMTP_URL and EMAIL_FROM: without them nobody gets their verification, reset or invitation emails. Set EMAIL=off to start without email on purpose.';
  }
  if ((config.infraProviders ?? ['mock']).includes('mock') && !config.allowMockCloud) {
    return 'INFRA_PROVIDERS includes the mock cloud (its default): set INFRA_PROVIDERS to the clouds you connect (gcp, aws), or INFRA_ALLOW_MOCK=1 to keep the mock on purpose.';
  }
  return null;
}
