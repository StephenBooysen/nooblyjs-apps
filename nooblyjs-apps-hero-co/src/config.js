import fs from 'node:fs';
// Configuration from the environment (stack.md §6). Read once, by createApp() or app.js; tests pass their own.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 11010;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ port: number, dataDir: string, production: boolean, publicUrl: string, appDomain: string,
 *   trustProxy: boolean, devSignIn: boolean, cxTrackingSecret: string|undefined, sessionSecret: string|undefined,
 *   github: { clientId: string|undefined, clientSecret: string|undefined }, secretKey: string|undefined }}
 */
function localAgentOf(env, production) {
  if (['fork', 'mock', 'off'].includes(env.HERO_LOCAL_AGENT)) return env.HERO_LOCAL_AGENT;
  if (env.NODE_ENV === 'test') return 'mock';
  if (production) return 'off';
  return fs.existsSync('/var/run/docker.sock') ? 'fork' : 'off';
}

function authTypeOf(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'google' || v === 'local' ? v : 'open';
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? DEFAULT_PORT);
  return {
    port,
    dataDir: path.resolve(ROOT, env.DATA_DIR ?? '.application'),
    production,
    // Tests: the development people without the development billing seed (test/helpers.js gives their cards).
    test: env.NODE_ENV === 'test',
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    appDomain: env.APP_DOMAIN ?? 'nooblyjs.app',
    // The agent for the Local network region (infra spec 8.9) on this machine: 'fork' runs the real agent with this
    // machine's Docker, 'mock' an in-process one (tests), 'off' none. Default: 'mock' in tests, 'off' in production,
    // otherwise 'fork' when Docker's socket is here. HERO_LOCAL_AGENT overrides.
    localAgent: localAgentOf(env, production),
    // The Local network's Postgres server (roadmap 6.2): an admin connection string, such as
    // postgres://postgres:<password>@127.0.0.1:5432/postgres. Customer databases are made on it, each with its own role.
    localPostgresUrl: env.HERO_LOCAL_POSTGRES_URL || null,
    // One proxy hop: set TRUST_PROXY=1 behind a load balancer; Codespaces port forwarding is one (TRUST_PROXY=0 turns it off).
    trustProxy: env.TRUST_PROXY !== '0' && (env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true' || env.CODESPACES === 'true'),
    // The development sign-in (/dev/login, X-Dev-Person) and the development people: never in production.
    devSignIn: !production && env.DEV_SIGN_IN !== '0',
    // Records (people, workspaces, services, deploys) in MongoDB when MONGODB_URL is set (production, roadmap 8.1);
    // otherwise core's file provider under DATA_DIR/data. MONGODB_DATABASE names the database.
    mongodbUrl: env.MONGODB_URL || null,
    mongodbDatabase: env.MONGODB_DATABASE || 'nooblyjs_cloud',
    // Sessions in Redis when REDIS_URL (or SESSION_REDIS_URL) is set; core's createSessionStore reads it itself.
    redisUrl: env.SESSION_REDIS_URL || env.REDIS_URL || null,
    cxTrackingSecret: env.CX_TRACKING_SECRET,
    sessionSecret: env.SESSION_SECRET,
    // GitHub OAuth app. Without it, outside production, GitHub sign-in uses the mock at /dev/github.
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
    // The card provider (roadmap 7.3): Stripe when STRIPE_SECRET_KEY is set (with STRIPE_WEBHOOK_SECRET and
    // STRIPE_PUBLISHABLE_KEY; the payments accelerator reads them from the environment), else the mock provider, which
    // the accelerator refuses in production. PAY_SIGNING_SECRET signs invoice and payment links (required in production).
    payProvider: env.STRIPE_SECRET_KEY ? 'stripe' : 'mock',
  };
}
