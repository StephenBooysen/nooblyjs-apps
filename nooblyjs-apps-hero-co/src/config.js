// Configuration from the environment (stack.md §6). Read once, by createApp() or app.js; tests pass their own.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 11010;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ port: number, dataDir: string, production: boolean, publicUrl: string, appDomain: string,
 *   trustProxy: boolean, devSignIn: boolean, cxTrackingSecret: string|undefined, sessionSecret: string|undefined,
 *   github: { clientId: string|undefined, clientSecret: string|undefined } }}
 */
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? DEFAULT_PORT);
  return {
    port,
    dataDir: path.resolve(ROOT, env.DATA_DIR ?? '.application'),
    production,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    appDomain: env.APP_DOMAIN ?? 'nooblyjs.app',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    // The development sign-in (/dev/login, X-Dev-Person) and the development people: never in production.
    devSignIn: !production && env.DEV_SIGN_IN !== '0',
    cxTrackingSecret: env.CX_TRACKING_SECRET,
    sessionSecret: env.SESSION_SECRET,
    // GitHub OAuth app. Without it, outside production, GitHub sign-in uses the mock at /dev/github.
    github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
  };
}
