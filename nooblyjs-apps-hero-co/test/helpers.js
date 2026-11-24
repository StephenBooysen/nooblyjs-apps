// Test helpers: start the real app (nooblyjs-core + the accelerators on the mock cloud) on an ephemeral port with its
// own data folder under .temp/tests, and call it as a person. nooblyjs-core's registry is one per process, so each
// test file starts the app once (node --test runs every file in its own process).
//
// The server listens before the app is built, so PUBLIC_URL carries the real port: passport-github2 calls the mock
// GitHub at that address.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig, ROOT } from '../src/config.js';

export const TEMP = path.join(ROOT, '.temp', 'tests');

export async function tempDir(prefix = 'data-') {
  await fs.mkdir(TEMP, { recursive: true });
  return fs.mkdtemp(path.join(TEMP, prefix));
}

export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/**
 * fetch as a person: `as` sets the X-Dev-Person header, `cookie` sends raw cookies, `jar` keeps cookies between calls
 * (a browser), `form` sends application/x-www-form-urlencoded.
 */
export function caller(base) {
  return async (method, url, { as, cookie, jar, body, form, headers = {}, redirect = 'manual' } = {}) => {
    const res = await fetch(new URL(url, base), {
      method,
      redirect,
      headers: {
        ...(as ? { 'x-dev-person': as } : {}),
        ...(cookie ? { cookie } : {}),
        ...(jar ? { cookie: jar.header() } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
    });
    jar?.take(res);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, text, json, location: res.headers.get('location') };
  };
}

/** A cookie jar: what a browser would send back. */
export function cookieJar() {
  const cookies = new Map();
  return {
    take(res) {
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (attrs.some((a) => /max-age=0/i.test(a.trim())) || value === '') cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    get: (name) => cookies.get(name),
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

let apps = 0;

/**
 * Starts the app on a free port. `dataDir` reuses a folder (a restart, a restore); close({ keepData }) leaves it.
 */
export async function startApp(options = {}) {
  const dataDir = options.dataDir ?? await tempDir();
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // MONGODB_URL runs the suite on MongoDB (CI does): each app its own database, dropped by close().
  const mongo = process.env.MONGODB_URL ? { mongodbUrl: process.env.MONGODB_URL, mongodbDatabase: `hero_test_${process.pid}_${++apps}` } : {};
  const config = { ...loadConfig({ NODE_ENV: 'test' }), ...mongo, dataDir, publicUrl: base, ...(options.config ?? {}) };
  const { cards = true, dataDir: _dataDir, ...rest } = options;
  const hero = await createApp({ config, mockStepMs: 0, jobCheckMs: 0, telemetryTimers: false, cronTimers: false, taskTimers: false, billingTimers: false, ...rest, ...(options.config ? { config } : {}) });
  server.on('request', hero.app);
  // The development workspaces pay with a test card unless a test says otherwise (paid instance types need one).
  if (cards) for (const ws of ['exclusivity-life', 'amara-labs']) await addTestCard(hero, ws);
  hero.attachUpgrades(server);
  const call = caller(base);
  const outbox = () => hero.accelerators.mounted.customers.marketing.channels.email.outbox;
  return {
    ...hero,
    base,
    dataDir,
    call,
    get: (url, o) => call('GET', url, o),
    post: (url, o) => call('POST', url, o),
    patch: (url, o) => call('PATCH', url, o),
    put: (url, o) => call('PUT', url, o),
    del: (url, o) => call('DELETE', url, o),
    outbox,
    /** The link in the newest email to `to` whose subject matches, resolved through the click tracker. */
    async linkFor(to, subject) {
      const mail = [...outbox()].reverse().find((m) => m.to === to && subject.test(m.subject));
      if (!mail) throw new Error(`No email to ${to} matching ${subject}`);
      const tracked = mail.text.match(/https?:\/\/\S+/)[0];
      const res = await call('GET', tracked.replace(base, ''));
      return new URL(res.location ?? tracked);
    },
    /**
     * Stops the app; `keepDatabase` leaves its MongoDB database and `keepData` its DATA_DIR for another app to start
     * on (a restart, a backup).
     */
    async close({ keepDatabase = false, keepData = false } = {}) {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      if (hero.config.mongodbUrl && !keepDatabase) await hero.data.provider.db_?.dropDatabase().catch(() => {});
      await hero.shutdown();
      if (!keepData) await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Saves a test card for a workspace's billing account through the mock provider's hosted fields (what CardForm does
 * in a browser). 4242 4242 4242 4242 pays; 4000 0000 0000 0341 is saved, then declined.
 */
export async function addTestCard(hero, workspaceId, number = '4242424242424242') {
  const account = await hero.billing.ensureWorkspace(workspaceId);
  const setup = await hero.pay.payments.setupMethod(account.id);
  hero.pay.mock.hostedFields.attach(setup.clientSecret, { number, expMonth: 12, expYear: new Date().getUTCFullYear() + 3, cvc: '123' });
  return hero.pay.payments.confirmMethod(account.id, setup.setupId);
}

/** Connects a workspace to the mock GitHub as `login` ('octo-dev' or 'stevie'), the way a browser would. */
export async function connectGithub(t, as, workspace, login) {
  const jar = cookieJar();
  const start = await t.get(`/w/${workspace}/github/connect`, { as, jar });
  if (start.status !== 302) throw new Error(`connect did not start (${start.status} ${start.location})`);
  const authorize = new URL(start.location);
  const user = { 'octo-dev': '1001', stevie: '1002' }[login];
  const granted = await t.post('/dev/github/login/oauth/authorize', { form: { user, redirect_uri: authorize.searchParams.get('redirect_uri'), state: authorize.searchParams.get('state') } });
  const back = new URL(granted.location);
  return t.get(back.pathname + back.search, { as, jar });
}

/** Signs up a person through the form (marketing consent ticked); their record. Password: a long enough password 1. */
export async function signUp(t, email, name = 'Ada Lovelace') {
  const res = await t.post('/api/v1/auth/signup', { body: { name, email, password: 'a long enough password 1', team: `${name} team`, marketing: true, terms: true }, headers: { origin: t.base } });
  if (res.status !== 201) throw new Error(`sign-up of ${email} failed: ${res.status} ${res.text}`);
  return t.accounts.findPersonByEmail(email);
}
