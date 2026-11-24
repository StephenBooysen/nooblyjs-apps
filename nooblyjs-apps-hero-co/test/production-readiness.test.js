// Production readiness (roadmap 8.7.1–8.7.5; .claude/audits/2026-11-23-production-readiness-security-audit.md):
// development features only with NODE_ENV=development or test, no sample data outside them, a key of its own for each
// store of secrets, no mock cloud in production, core's settings under DATA_DIR, and account emails sent over SMTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startApp, cookieJar } from './helpers.js';
import { createApp } from '../src/app.js';
import { loadConfig, configProblem, productionProblem, ROOT } from '../src/config.js';
import { mailProblem, parseFrom } from '../src/platform/mail.js';

const require = createRequire(import.meta.url);
const { context: cxContext } = require('nooblyjs-accel-customers');

/** What an unset NODE_ENV gives (loadConfig({})), over the test config the helper starts from. */
const UNSET = { nodeEnv: '', development: false, devSignIn: false, sampleData: false };

/** Everything production needs, with a fake mail transport standing in for SMTP_URL. */
const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  PUBLIC_URL: 'https://cloud.example',
  SESSION_SECRET: 'session-0123456789abcdef',
  HERO_SECRET_KEY: 'hero-0123456789abcdef',
  INFRA_SECRET_KEY: 'infra-0123456789abcdef',
  SETTINGS_SECRET: 'settings-0123456789abcdef',
  SMTP_URL: 'smtps://mailer:pw@smtp.example:465',
  EMAIL_FROM: 'NooblyJS Cloud <no-reply@cloud.example>',
  INFRA_PROVIDERS: 'gcp',
};

test('8.7.3: development features need NODE_ENV=development or test said out loud', () => {
  for (const nodeEnv of ['development', 'test']) {
    const config = loadConfig({ NODE_ENV: nodeEnv });
    assert.equal(config.devSignIn, true, nodeEnv);
    assert.equal(config.sampleData, true, nodeEnv);
    assert.equal(configProblem(config), null, nodeEnv);
  }
  assert.equal(loadConfig({ NODE_ENV: 'development', DEV_SIGN_IN: '0' }).devSignIn, false);

  // Unset: nothing of development's, and no problem on http (a laptop without .env).
  const unset = loadConfig({});
  assert.deepEqual([unset.devSignIn, unset.sampleData, unset.localAgent], [false, false, 'off']);
  assert.equal(configProblem(unset), null);
  // Unset with an https address is a deployment that forgot NODE_ENV.
  assert.match(configProblem(loadConfig({ PUBLIC_URL: 'https://cloud.example' })), /NODE_ENV is not set but PUBLIC_URL is https/);

  // A typo (the audit's S1 reproduced NODE_ENV=prod opening the development sign-in) refuses to start.
  for (const typo of ['prod', 'Production', 'staging']) {
    const config = loadConfig({ NODE_ENV: typo });
    assert.equal(config.devSignIn, false, typo);
    assert.match(configProblem(config), new RegExp(`NODE_ENV is "${typo}"`), typo);
  }
  const production = loadConfig({ NODE_ENV: 'production' });
  assert.deepEqual([production.devSignIn, production.sampleData], [false, false]);
});

test('8.7.3: createApp refuses an unknown NODE_ENV before it mounts anything', async () => {
  await assert.rejects(createApp({ config: loadConfig({ NODE_ENV: 'prod', DATA_DIR: path.join(ROOT, '.temp', 'never') }) }), /NODE_ENV is "prod"/);
  await assert.rejects(fs.access(path.join(ROOT, '.temp', 'never')), 'nothing was written');
});

test('8.7.2, 8.7.3: with NODE_ENV unset there is no development sign-in, no mock GitHub and no sample data', async () => {
  const t = await startApp({ cards: false, seed: true, config: UNSET });
  try {
    assert.equal((await t.get('/dev/login')).status, 404);
    assert.equal((await t.get('/dev/github/login/oauth/authorize')).status, 404);
    // The X-Dev-Person header is ignored: no one is signed in.
    assert.equal((await t.get('/api/v1/me', { as: 'stevie' })).status, 401);
    assert.equal((await t.get('/api/v1/auth/config')).json.githubMock, false);
    // No development people (sign-in with their password fails), no demo customers.
    const jar = cookieJar();
    const signIn = await t.post('/services/authservice/api/login', { jar, body: { email: 'stevie@exclusivity.life', password: 'development-only-1' }, headers: { origin: t.base } });
    assert.notEqual(signIn.status, 200);
    const customers = await t.accelerators.mounted.customers.customer.services.customers.list({}, cxContext.systemContext('test'));
    assert.equal((customers.items ?? customers.data ?? customers).length, 0, 'no demo customers');
    // The infrastructure accelerator is marked started without sample content, and holds none.
    const marker = await fs.readFile(path.join(t.dataDir, 'infrastructure', 'seed.yaml'), 'utf8');
    assert.match(marker, /content: false/);
    const written = await fs.readdir(path.join(t.dataDir, 'infrastructure'));
    assert.deepEqual(written.filter((f) => !['seed.yaml', 'secrets', 'local', 'local-agent', 'config.yaml', 'audit', 'events'].includes(f)), [], 'no seed story');
  } finally {
    await t.close();
  }
});

test('8.7.2: in development the seed story and the demo customers are still written', async () => {
  // demoCustomers: development's (true) writes 25 on files, a second each; two show the same.
  const t = await startApp({ cards: false, seed: true, config: { demoCustomers: { customers: 2, organizations: 1 } } });
  try {
    const marker = await fs.readFile(path.join(t.dataDir, 'infrastructure', 'seed.yaml'), 'utf8');
    assert.match(marker, /sampleData: true/);
    const customers = await t.accelerators.mounted.customers.customer.services.customers.list({}, cxContext.systemContext('test'));
    assert.ok((customers.items ?? customers.data ?? customers).length > 0, 'demo customers');
  } finally {
    await t.close();
  }
});

test('8.7.4: production needs its own key for each store of secrets, email, and a real cloud', () => {
  const ok = loadConfig(PRODUCTION_ENV);
  assert.equal(productionProblem(ok), null);
  assert.equal(productionProblem(loadConfig({ NODE_ENV: 'development' })), null, 'only production is checked');

  for (const key of ['SESSION_SECRET', 'HERO_SECRET_KEY', 'INFRA_SECRET_KEY', 'SETTINGS_SECRET']) {
    assert.match(productionProblem(loadConfig({ ...PRODUCTION_ENV, [key]: '' })), new RegExp(`Production needs ${key}`), key);
  }
  // No fallback to SESSION_SECRET: a shared key is refused.
  assert.match(productionProblem(loadConfig({ ...PRODUCTION_ENV, INFRA_SECRET_KEY: PRODUCTION_ENV.SESSION_SECRET })), /must all differ/);
  assert.match(productionProblem(loadConfig({ ...PRODUCTION_ENV, SETTINGS_SECRET: PRODUCTION_ENV.HERO_SECRET_KEY })), /must all differ/);

  // The mock cloud is INFRA_PROVIDERS' default; production takes it only on purpose.
  assert.match(productionProblem(loadConfig({ ...PRODUCTION_ENV, INFRA_PROVIDERS: '' })), /mock cloud/);
  assert.match(productionProblem(loadConfig({ ...PRODUCTION_ENV, INFRA_PROVIDERS: 'gcp, mock' })), /mock cloud/);
  assert.equal(productionProblem(loadConfig({ ...PRODUCTION_ENV, INFRA_PROVIDERS: 'mock', INFRA_ALLOW_MOCK: '1' })), null);

  // 8.7.1: no SMTP_URL refuses to start, unless EMAIL=off says so on purpose.
  assert.match(productionProblem(loadConfig({ ...PRODUCTION_ENV, SMTP_URL: '' })), /SMTP_URL and EMAIL_FROM/);
  assert.equal(productionProblem(loadConfig({ ...PRODUCTION_ENV, SMTP_URL: '', EMAIL: 'off' })), null);
});

test('8.7.4: createApp refuses production without INFRA_SECRET_KEY, before it mounts anything', async () => {
  const dataDir = path.join(ROOT, '.temp', `never-${process.pid}`);
  await assert.rejects(createApp({ config: loadConfig({ ...PRODUCTION_ENV, INFRA_SECRET_KEY: '', DATA_DIR: dataDir }) }), /Production needs INFRA_SECRET_KEY/);
  await assert.rejects(fs.access(dataDir), 'nothing was written');
});

test('8.7.1: SMTP_URL and EMAIL_FROM are checked, and the sender is parsed', () => {
  assert.equal(mailProblem({}), null);
  assert.equal(mailProblem({ smtpUrl: 'smtps://u:p@smtp.example:465', emailFrom: 'no-reply@cloud.example' }), null);
  assert.match(mailProblem({ smtpUrl: 'not a url', emailFrom: 'a@b.c' }), /not a URL/);
  assert.match(mailProblem({ smtpUrl: 'http://smtp.example', emailFrom: 'a@b.c' }), /smtps:\/\/ or smtp:\/\//);
  assert.match(mailProblem({ smtpUrl: 'smtp://smtp.example:587' }), /EMAIL_FROM is required/);
  assert.match(mailProblem({ smtpUrl: 'smtp://smtp.example:587', emailFrom: 'nobody' }), /not an email address/);
  assert.deepEqual(parseFrom('NooblyJS Cloud <no-reply@cloud.example>'), { name: 'NooblyJS Cloud', address: 'no-reply@cloud.example' });
  assert.deepEqual(parseFrom('"NooblyJS Cloud" <no-reply@cloud.example>'), { name: 'NooblyJS Cloud', address: 'no-reply@cloud.example' });
  assert.deepEqual(parseFrom('no-reply@cloud.example'), { address: 'no-reply@cloud.example' });
  assert.equal(parseFrom('<script>'), null);
});

test('8.7.1: account emails leave through the SMTP transport, from EMAIL_FROM', async () => {
  const sent = [];
  const mailTransport = { sendMail: async (m) => { sent.push(m); return { messageId: `<m${sent.length}@smtp.example>` }; } };
  const t = await startApp({ cards: false, mailTransport, config: { emailFrom: 'NooblyJS Cloud <no-reply@cloud.example>' } });
  try {
    const res = await t.post('/api/v1/auth/forgot-password', { body: { email: 'stevie@exclusivity.life' }, headers: { origin: t.base } });
    assert.equal(res.status, 202, res.text);
    await t.accelerators.mounted.customers.marketing.drain?.();
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1, 'one email through the transport');
    assert.equal(sent[0].to, 'stevie@exclusivity.life');
    assert.equal(sent[0].from, '"NooblyJS Cloud" <no-reply@cloud.example>');
    assert.match(sent[0].subject, /reset/i);
    assert.match(sent[0].text, /https?:\/\//, 'the reset link');
  } finally {
    await t.close();
  }
});

test('8.7.5: core\'s settings are written under DATA_DIR, not beside the code', async () => {
  const outside = path.join(process.cwd(), '.application', 'settings', 'settings.enc.json');
  const before = await fs.stat(outside).then((s) => s.mtimeMs, () => null);
  const t = await startApp({ cards: false });
  try {
    const settings = require('nooblyjs-core').settings('file');
    assert.equal(settings.settings.filepath, path.join(t.dataDir, 'settings', 'settings.enc.json'));
    await settings.set('hero.test', 'kept');
    await settings.save();
    await fs.access(path.join(t.dataDir, 'settings', 'settings.enc.json'));
    assert.equal(await fs.stat(outside).then((s) => s.mtimeMs, () => null), before, 'nothing written to ./.application/settings');
  } finally {
    await t.close();
  }
});
