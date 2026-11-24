// Where records live (roadmap 8.7.8; the audit's P5). The customers and payments accelerators keep theirs with
// hero-co's: MongoDB when MONGODB_URL is set, else files under DATA_DIR. Never memory: until 8.7.8 the customers
// accelerator's were, so a restart lost every customer, the consent ledger and the unsubscribe list, and a password
// reset to an existing person failed ("customer … not found"). Runs on files, and on MongoDB when CI sets MONGODB_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startApp, tempDir, signUp } from './helpers.js';
import { ROOT } from '../src/config.js';

const require = createRequire(import.meta.url);
const { context: cxContext } = require('nooblyjs-accel-customers');
const cx = () => cxContext.systemContext('test');
const mongo = (name) => (process.env.MONGODB_URL ? { mongodbDatabase: `hero_test_${name}_${process.pid}` } : {});

test('customers, their consent and payments records survive a restart; a reset email reaches an existing person', async () => {
  const dataDir = await tempDir();
  const config = mongo('restart');
  const a = await startApp({ dataDir, config });
  let b;
  try {
    const ada = await signUp(a, 'ada@restart.dev');
    assert.ok(ada.customerId, 'linked to a customer');
    const account = await a.billing.ensureWorkspace('exclusivity-life');
    await a.close({ keepData: true, keepDatabase: true });

    b = await startApp({ dataDir, config, cards: false });
    const services = b.accelerators.mounted.customers.customer.services;
    const customer = await services.customers.get(ada.customerId, cx());
    assert.equal(customer.id, ada.customerId, 'the customer is still there');
    const consent = await services.consents.history(ada.customerId, cx(), { purpose: 'marketing', channel: 'email' });
    assert.equal((consent.items ?? consent).at(-1)?.status, 'opt_in', 'the sign-up consent is still on the ledger');
    assert.equal((await b.billing.ensureWorkspace('exclusivity-life')).id, account.id, 'the same billing account');

    const before = b.outbox().length;
    assert.equal((await b.post('/api/v1/auth/forgot-password', { body: { email: 'ada@restart.dev' }, headers: { origin: b.base } })).status, 202);
    const mail = b.outbox().slice(before).find((m) => m.to === 'ada@restart.dev');
    assert.match(mail?.subject ?? '', /Reset your NooblyJS Cloud password/);

    // Where they are: files under DATA_DIR without MongoDB, collections beside hero_* with it.
    if (process.env.MONGODB_URL) {
      const names = (await b.data.provider.db_.listCollections().toArray()).map((c) => c.name);
      assert.ok(names.some((n) => n.startsWith('cx_')) && names.some((n) => n.startsWith('pay_')), names.join(', '));
    } else {
      assert.ok((await fs.readdir(path.join(dataDir, 'customers'))).length > 0, 'DATA_DIR/customers');
      assert.ok((await fs.readdir(path.join(dataDir, 'payments'))).length > 0, 'DATA_DIR/payments');
    }
  } finally {
    await b?.close();
  }
});

test('a person whose customer record is gone is linked again, and their email still goes', async () => {
  const t = await startApp({ cards: false, config: mongo('relink') });
  try {
    const ada = await signUp(t, 'ada@relink.dev');
    // What a deployment from before 8.7.8 has after a restart: a customerId the customers accelerator never heard of.
    await t.accounts.updatePerson(ada.id, { customerId: '00000000-0000-4000-8000-000000000000' });
    const before = t.outbox().length;
    assert.equal((await t.post('/api/v1/auth/forgot-password', { body: { email: 'ada@relink.dev' }, headers: { origin: t.base } })).status, 202);
    assert.ok(t.outbox().slice(before).some((m) => m.to === 'ada@relink.dev'), 'the reset email went');
    const relinked = await t.accounts.findPersonByEmail('ada@relink.dev');
    assert.notEqual(relinked.customerId, '00000000-0000-4000-8000-000000000000');
    assert.ok(await t.accelerators.mounted.customers.customer.services.customers.get(relinked.customerId, cx()));
  } finally {
    await t.close();
  }
});

test('production.md names every folder the app writes under DATA_DIR', async () => {
  const t = await startApp({ seed: true });
  try {
    await signUp(t, 'ada@inventory.dev');
    await t.idle();
    const doc = await fs.readFile(path.join(ROOT, '.claude', 'steering', 'production.md'), 'utf8');
    const written = (await fs.readdir(t.dataDir)).filter((f) => !f.startsWith('.'));
    for (const entry of written) assert.ok(doc.includes(`\`${entry}${entry.includes('.') ? '' : '/'}\``), `production.md lists \`${entry}\``);
  } finally {
    await t.close();
  }
});

test('with MONGODB_URL, payments records left in DATA_DIR/payments stop the start rather than vanish from view', async () => {
  const { createApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  const dataDir = await tempDir();
  await fs.mkdir(path.join(dataDir, 'payments'));
  await fs.writeFile(path.join(dataDir, 'payments', 'pay_invoices.json'), '{}');
  const config = { ...loadConfig({ NODE_ENV: 'test' }), dataDir, mongodbUrl: 'mongodb://127.0.0.1:1' };
  await assert.rejects(createApp({ config }), /holds payments records in files \(1\), but with MONGODB_URL they are read from MongoDB now/);
  await assert.rejects(fs.access(path.join(dataDir, 'hero-co.lock')), 'refused before taking the lock');
  await fs.rm(dataDir, { recursive: true, force: true });
});
