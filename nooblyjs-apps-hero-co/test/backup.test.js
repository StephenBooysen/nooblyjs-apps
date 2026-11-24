// Backup and restore (roadmap 8.7.8; the audit's P5): a backup of a stopped app, restored into a new DATA_DIR (and a
// new database), starts with every person, customer, consent and billing account it had. On files, and on MongoDB
// when CI sets MONGODB_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { startApp, tempDir, cookieJar, signUp } from './helpers.js';
import { backup, restore } from '../src/platform/backup.js';
import { LOCK_FILE } from '../src/platform/lock.js';
import { ROOT } from '../src/config.js';

const require = createRequire(import.meta.url);
const { context: cxContext } = require('nooblyjs-accel-customers');
const MONGO = process.env.MONGODB_URL ?? null;
const db = (name) => `hero_test_${name}_${process.pid}`;

/** Drops a test database (MongoDB runs only). */
async function dropDatabase(name) {
  if (!MONGO) return;
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(MONGO);
  try {
    await client.connect();
    await client.db(name).dropDatabase();
  } finally {
    await client.close();
  }
}

test('a backup restored into a new DATA_DIR and database starts with everything it had', async () => {
  const source = await tempDir();
  const target = await tempDir();
  const out = await tempDir();
  const from = MONGO ? { mongodbDatabase: db('backup_a') } : {};
  const to = MONGO ? { mongodbDatabase: db('backup_b') } : {};
  let a = await startApp({ dataDir: source, config: from });
  let b;
  try {
    const ada = await signUp(a, 'ada@backup.dev');
    const account = await a.billing.ensureWorkspace('exclusivity-life');

    // While the app runs, a backup refuses (it takes DATA_DIR's lock).
    await assert.rejects(backup({ dataDir: source, mongodbUrl: MONGO, mongodbDatabase: from.mongodbDatabase, out }), /Another NooblyJS Cloud is using/);
    await a.close({ keepData: true, keepDatabase: true });
    a = null;

    const { dir, manifest } = await backup({ dataDir: source, mongodbUrl: MONGO, mongodbDatabase: from.mongodbDatabase, out, version: 'test' });
    assert.match(path.basename(dir), /^nooblyjs-cloud-\d{4}-\d\d-\d\dT/);
    assert.ok(manifest.files > 0);
    await assert.rejects(fs.access(path.join(dir, 'data', LOCK_FILE)), 'the lock is never copied');
    if (MONGO) {
      for (const prefix of ['hero_people', 'cx_customers', 'pay_']) assert.ok(Object.keys(manifest.mongodb.collections).some((n) => n.startsWith(prefix)), prefix);
    } else {
      assert.equal(manifest.mongodb, null);
      await fs.access(path.join(dir, 'data', 'customers'));
    }

    await restore({ dataDir: target, mongodbUrl: MONGO, mongodbDatabase: to.mongodbDatabase, from: dir });
    b = await startApp({ dataDir: target, config: to, cards: false });
    // The person signs in with their password (core's sign-in records came back too).
    const jar = cookieJar();
    const signIn = await b.post('/services/authservice/api/login', { jar, body: { email: 'ada@backup.dev', password: 'a long enough password 1' }, headers: { origin: b.base } });
    assert.equal(signIn.status, 200, signIn.text);
    // Their customer and consent, and the billing account, are the same records.
    const services = b.accelerators.mounted.customers.customer.services;
    assert.equal((await services.customers.get(ada.customerId, cxContext.systemContext('test'))).id, ada.customerId);
    assert.equal((await b.billing.ensureWorkspace('exclusivity-life')).id, account.id);
    // And email still reaches them.
    const before = b.outbox().length;
    await b.post('/api/v1/auth/forgot-password', { body: { email: 'ada@backup.dev' }, headers: { origin: b.base } });
    assert.ok(b.outbox().slice(before).some((m) => m.to === 'ada@backup.dev'));
  } finally {
    await a?.close();
    await b?.close();
    await dropDatabase(from.mongodbDatabase);
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('a restore refuses to overwrite, unless --force, which moves the current files aside', async () => {
  const source = await tempDir();
  const target = await tempDir();
  const out = await tempDir();
  await fs.mkdir(path.join(source, 'audit'), { recursive: true });
  await fs.writeFile(path.join(source, 'audit', 'kept.yaml'), 'from: backup\n');
  const { dir } = await backup({ dataDir: source, out });
  await fs.writeFile(path.join(target, 'current.txt'), 'already here');

  await assert.rejects(restore({ dataDir: target, from: dir }), /is not empty: restore into an empty DATA_DIR .* or pass --force/);
  assert.equal(await fs.readFile(path.join(target, 'current.txt'), 'utf8'), 'already here', 'nothing changed');

  const { aside } = await restore({ dataDir: target, from: dir, force: true });
  assert.equal(await fs.readFile(path.join(aside, 'current.txt'), 'utf8'), 'already here', 'moved aside, not deleted');
  assert.equal(await fs.readFile(path.join(target, 'audit', 'kept.yaml'), 'utf8'), 'from: backup\n');
  await assert.rejects(fs.access(path.join(target, 'current.txt')));
  await fs.rm(aside, { recursive: true, force: true });

  // A backup made with MongoDB needs MONGODB_URL to restore, and the other way round.
  await assert.rejects(restore({ dataDir: await tempDir(), from: dir, mongodbUrl: 'mongodb://127.0.0.1:1' }), /made without MONGODB_URL/);
  await assert.rejects(restore({ dataDir: await tempDir(), from: out }), /is not a backup/);
  await assert.rejects(backup({ dataDir: source, out: path.join(source, 'inside') }), /outside DATA_DIR/);
});

test('node app.js --backup and --restore, as an operator runs them', async () => {
  const dataDir = await tempDir();
  const out = await tempDir();
  const restored = await tempDir();
  await fs.mkdir(path.join(dataDir, 'settings'));
  await fs.writeFile(path.join(dataDir, 'settings', 'x.json'), '{}');
  const env = { ...process.env, NODE_ENV: 'test', DATA_DIR: dataDir, MONGODB_URL: '' };
  const run = promisify(execFile);
  const made = await run(process.execPath, ['app.js', '--backup', out], { cwd: ROOT, env });
  assert.match(made.stdout, /Backed up .* \(1 files\) to .*nooblyjs-cloud-/);
  const [name] = await fs.readdir(out);
  const back = await run(process.execPath, ['app.js', '--restore', path.join(out, name)], { cwd: ROOT, env: { ...env, DATA_DIR: restored } });
  assert.match(back.stdout, /Restored the backup of .* Start the app with the same keys it had\./);
  assert.equal(await fs.readFile(path.join(restored, 'settings', 'x.json'), 'utf8'), '{}');
  await assert.rejects(run(process.execPath, ['app.js', '--restore', path.join(out, name)], { cwd: ROOT, env: { ...env, DATA_DIR: restored } }), /Restore failed: .* is not empty/);
});
