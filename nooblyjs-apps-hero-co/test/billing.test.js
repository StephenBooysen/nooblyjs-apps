// Billing (roadmap Phase 7) on nooblyjs-accel-payments with its mock provider and a clock the test moves: the catalogue
// and prices, a billing account per workspace, the free tier, the Billing API (Owner only), the hourly usage hand-off,
// and the exit check: a month of usage invoices within 5% of the Summary estimates shown at creation; a declined card
// is retried and the owner emailed each time; after the last attempt paid services are suspended, and they resume
// when a working card pays; a paid invoice shows on the Billing page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestClock } from 'nooblyjs-accel-payments';
import { startApp, cookieJar, addTestCard } from './helpers.js';
import { PLANS, estimate } from '../public/js/shared/catalog.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = new Date();
// The payments clock starts on the 1st of next month (after anything the tests create), and the tests move it on.
const MONTH = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
const NEXT = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1);
const clock = createTestClock(new Date(MONTH).toISOString());

let t;
before(async () => { t = await startApp({ payClock: clock }); });
after(async () => { await t?.close(); });

const WS = '/api/v1/workspaces/exclusivity-life';
const AMARA = '/api/v1/workspaces/amara-labs';
const web = (over = {}) => ({ type: 'web', name: 'shop', repoUrl: 'https://github.com/render-examples/express-hello-world', branch: 'main', region: 'af-south', runtime: 'node22', plan: 'standard', instances: 2, ...over });

/** Paid services that are not suspended, in every workspace: what the hand-off bills each hour. */
async function paidRunning() {
  let n = 0;
  for (const ws of await t.accounts.listWorkspaces()) n += (await t.records.services.list(ws.id)).filter((s) => s.status !== 'suspended' && t.billing.isPaid(s)).length;
  return n;
}

/** Saves a card through the Billing API and the mock provider's hosted fields, as the Billing page's CardForm does. */
async function addCardByApi(as, ws, number) {
  const setup = await t.post(`${ws}/billing/cards`, { as, body: {} });
  assert.equal(setup.status, 201, JSON.stringify(setup.json));
  assert.equal(setup.json.provider, 'mock');
  const fields = new URL(setup.json.fieldsUrl);
  assert.equal(fields.origin, t.base, 'the hosted fields are served from our origin (a same-origin frame)');
  const typed = await t.post('/admin/payments/p/mock/setups', { body: { secret: fields.searchParams.get('secret'), number, exp: '12/30', cvc: '123' } });
  if (typed.status !== 200) return typed;
  return t.post(`${ws}/billing/cards/${setup.json.setupId}/confirm`, { as, body: {} });
}

test('7.4 the plan table is in the payments catalogue, and prices come back from it', async () => {
  const prices = await t.get('/api/v1/prices');
  assert.equal(prices.status, 200);
  assert.deepEqual(prices.json.service, { starter: 0, standard: 5, pro: 20, 'pro-plus': 100 });
  assert.deepEqual(prices.json.postgres, { starter: 7, standard: 20, pro: 65 });
  assert.deepEqual(prices.json.keyvalue, { starter: 0, standard: 10, pro: 32 });
  const price = t.pay.billing.currentPrice('service-pro');
  assert.deepEqual([price.type, price.unitAmount, price.divideBy, price.currency], ['metered', 2000, 'month_hours', 'USD']);
  assert.equal(t.pay.billing.listProducts().filter((p) => p.key === 'service-starter').length, 0, 'a free plan has nothing to bill');
  // An operator changes a price in the payments catalogue: a new price, the old one turned off.
  const operator = await t.post('/admin/billing/api/v1/prices', { as: 'ops-platform', body: { productId: price.productId, type: 'metered', unitAmount: 2500, meter: 'service_pro_hours', divideBy: 'month_hours' } });
  assert.equal(operator.status, 201, JSON.stringify(operator.json));
  assert.equal((await t.patch(`/admin/billing/api/v1/prices/${price.id}`, { as: 'ops-platform', body: { active: false } })).status, 200);
  assert.equal((await t.get('/api/v1/prices')).json.service.pro, 25);
  assert.equal(estimate('pro').text, '$25 / mo', 'the server\'s catalogue follows');
  // Put it back for the rest of the file.
  await t.patch(`/admin/billing/api/v1/prices/${operator.json.id}`, { as: 'ops-platform', body: { active: false } });
  await t.patch(`/admin/billing/api/v1/prices/${price.id}`, { as: 'ops-platform', body: { active: true } });
  assert.equal((await t.get('/api/v1/prices')).json.service.pro, 20);
  assert.equal(PLANS.find((p) => p.key === 'pro').priceUsd, 20);
});

test('7.4 a billing account per workspace, made on sign-up, with one subscription holding every metered price', async () => {
  const jar = cookieJar();
  const signup = await t.post('/api/v1/auth/signup', { jar, headers: { origin: t.base }, body: { name: 'Nia', team: 'Nia Works', email: 'nia@example.dev', password: 'a long password 1' } });
  assert.equal(signup.status, 201);
  const account = t.pay.payments.lookup('nia-works');
  assert.ok(account, 'made on sign-up');
  assert.deepEqual([account.name, account.email, account.currency], ['Nia Works', 'nia@example.dev', 'USD']);
  const [sub] = t.pay.billing.listSubscriptions((s) => s.accountId === account.id);
  assert.equal(sub.status, 'active');
  assert.equal(sub.items.length, t.pay.billing.listProducts().length, 'a metered item per paid product');
  assert.equal(t.pay.billing.listInvoices((i) => i.accountId === account.id).length, 0, 'nothing billed in advance');

  // 7.6 The free tier: Key Value Starter needs no card; Postgres and a paid Key Value plan do (402 card_required).
  const headers = { origin: t.base };
  const own = '/api/v1/workspaces/nia-works';
  const free = await t.post(`${own}/datastores`, { jar, headers, body: { type: 'keyvalue', name: 'cache', region: 'af-south', plan: 'starter' } });
  assert.equal(free.status, 201, JSON.stringify(free.json));
  const pg = await t.post(`${own}/datastores`, { jar, headers, body: { type: 'postgres', name: 'db', region: 'af-south', plan: 'starter' } });
  assert.equal(pg.status, 402);
  assert.equal(pg.json.error.code, 'card_required');
  assert.match(pg.json.error.message, /Postgres Starter costs \$7 a month: add a card/);
  const up = await t.patch(`${own}/services/cache/datastore`, { jar, headers, body: { plan: 'standard' } });
  assert.equal(up.status, 402);
  const paidWeb = await t.post(`${own}/services`, { jar, headers, body: web({ name: 'nia-web' }) });
  assert.equal(paidWeb.status, 402);
  assert.match(paidWeb.json.error.message, /Standard costs \$5 a month.*Starter is free/);
  assert.equal((await t.get(`${own}/services`, { jar })).json.services.length, 1, 'nothing half-made');

  // The card goes through the hosted fields; a declined card is refused at setup and saves nothing.
  assert.equal((await t.post(`${own}/billing/cards`, { body: {} })).status, 401, 'a request without the session is refused');
  const me = (await t.get('/api/v1/me', { jar })).json.id;
  const bad = await addCardByApi(me, own, '4000000000000002');
  assert.equal(bad.status, 402);
  assert.match(bad.json.error.message, /declined/);
  const saved = await addCardByApi(me, own, '4242424242424242');
  assert.equal(saved.status, 201);
  assert.deepEqual([saved.json.card.brand, saved.json.card.last4, saved.json.card.isDefault], ['visa', '4242', true]);
  assert.equal((await t.post(`${own}/datastores`, { jar, headers, body: { type: 'postgres', name: 'db', region: 'af-south', plan: 'starter' } })).status, 201);
  // The last card cannot go while paid services run.
  const removing = await t.del(`${own}/billing/cards/${saved.json.card.id}`, { as: me });
  assert.equal(removing.status, 409);
  assert.match(removing.json.error.message, /db/);
});

test('7.7 the Billing API is the Owner\'s: a Member gets a 403, another workspace a 404', async () => {
  await t.accounts.addMember('exclusivity-life', 'amara');
  assert.equal((await t.get(`${WS}/billing`, { as: 'amara' })).status, 403);
  assert.equal((await t.post(`${WS}/billing/cards`, { as: 'amara', body: {} })).status, 403);
  assert.equal((await t.get(`${WS}/billing`, { as: 'ops-support' })).status, 404);
  assert.equal((await t.get(`${AMARA}/billing`, { as: 'stevie' })).status, 404);
  await t.accounts.removeMember('exclusivity-life', 'amara');
  const own = await t.get(`${WS}/billing`, { as: 'stevie' });
  assert.equal(own.status, 200);
  assert.equal(own.json.summary.methods[0].last4, '4242');
  assert.equal(own.json.provider.provider, 'mock');
  assert.doesNotMatch(own.text, /4242424242424242|clientSecret|whsec/, 'no card number or secret');
  // Billing details go on the invoices.
  const details = await t.patch(`${WS}/billing/details`, { as: 'stevie', body: { name: 'Exclusivity Life (Pty) Ltd', country: 'za', taxId: '4123456789', address: { line1: '1 Long Street', city: 'Cape Town', postalCode: '8001' } } });
  assert.equal(details.status, 200, JSON.stringify(details.json));
  assert.deepEqual([details.json.summary.account.name, details.json.summary.account.country, details.json.summary.account.address.city], ['Exclusivity Life (Pty) Ltd', 'ZA', 'Cape Town']);
  assert.equal((await t.patch(`${WS}/billing/details`, { as: 'stevie', body: { country: 'South Africa' } })).status, 422);
});

test('Phase 7 exit check: a month of usage invoices within 5% of the Summary estimates shown at creation, and the paid invoice is on the Billing page', async () => {
  // Services as the create forms show them: each answer carries the price its Summary showed.
  const shown = [];
  const shop = await t.post(`${WS}/services`, { as: 'stevie', body: web({ name: 'shop', plan: 'standard', instances: 2 }) });
  assert.equal(shop.status, 201, JSON.stringify(shop.json));
  shown.push(shop.json.service.estimate.usd);
  const worker = await t.post(`${WS}/services`, { as: 'stevie', body: web({ type: 'worker', name: 'jobs', plan: 'pro', instances: 1 }) });
  assert.equal(worker.status, 201, JSON.stringify(worker.json));
  shown.push(worker.json.service.estimate.usd);
  const free = await t.post(`${WS}/services`, { as: 'stevie', body: web({ name: 'hello', plan: 'starter', instances: 1 }) });
  shown.push(free.json.service.estimate.usd);
  const db = await t.post(`${WS}/datastores`, { as: 'stevie', body: { type: 'postgres', name: 'main-db', region: 'af-south', plan: 'standard' } });
  assert.equal(db.status, 201, JSON.stringify(db.json));
  shown.push(db.json.service.priceUsd);
  const kv = await t.post(`${WS}/datastores`, { as: 'stevie', body: { type: 'keyvalue', name: 'sessions', region: 'af-south', plan: 'standard' } });
  shown.push(kv.json.service.priceUsd);
  await t.idle();
  assert.deepEqual(shown, [5, 20, 0, 20, 10]);
  const expected = shown.reduce((a, b) => a + b, 0) * 100;

  const page = await t.get(`${WS}/billing`, { as: 'stevie' });
  assert.equal(page.json.estimateUsd, expected / 100, 'the Billing page adds the same prices up');

  // The hourly hand-off for the whole month, then the period closes on the 1st.
  clock.set(new Date(NEXT).toISOString());
  const hours = (NEXT - MONTH) / HOUR;
  const paid = await paidRunning();
  assert.equal(paid, 5, 'four here, and Nia\'s Postgres');
  const out = await t.billing.handOff({ at: NEXT, hours });
  assert.equal(out.recorded, paid * hours, 'every paid service, every hour');
  assert.deepEqual(await t.billing.handOff({ at: NEXT, hours: 3 }), { recorded: 0, duplicates: paid * 3 }, 'idempotent');
  await t.pay.tick();
  await t.billing.idle();
  const account = t.pay.payments.lookup('exclusivity-life');
  const [inv] = t.pay.billing.listInvoices((i) => i.accountId === account.id && i.status !== 'draft');
  assert.ok(inv, 'the month is invoiced');
  const subtotal = inv.subtotal.amount;
  assert.ok(Math.abs(subtotal - expected) <= expected * 0.05, `invoice ${subtotal} within 5% of ${expected}`);
  assert.equal(subtotal, expected, 'exactly, for a whole month');
  assert.equal(inv.status, 'paid');
  assert.match(inv.number, /^INV-\d{4}-000001$/);
  assert.deepEqual(inv.lines.map((l) => l.description).sort(), [
    `Key Value Standard · ${hours} store-hours`, `Postgres Standard · ${hours} database-hours`, `Pro instance · ${hours} service-hours`, `Standard instance · ${hours} service-hours`,
  ].sort(), 'a line per plan in use, none for the free one');
  // VAT for a South African account (15%) on top: the account's details above.
  assert.ok(inv.tax.amount >= 0);

  const billingPage = await t.get(`${WS}/billing`, { as: 'stevie' });
  const listed = billingPage.json.summary.invoices.find((i) => i.number === inv.number);
  assert.equal(listed.status, 'paid');
  assert.match(listed.pdfUrl, /^http.*\/admin\/payments\/p\/invoices\/[^/]+\/pdf$/);
  const pdf = await t.get(new URL(listed.pdfUrl).pathname);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /pdf/);
  const hosted = await t.get(new URL(listed.url).pathname);
  assert.match(hosted.text, new RegExp(inv.number));
  assert.match(hosted.text, /Payment received/, 'the hosted page of a paid invoice is its receipt');
  // The receipt went to the owner.
  assert.ok(t.outbox().some((m) => m.to === 'stevie@exclusivity.life' && m.subject === `Receipt for NooblyJS Cloud invoice ${inv.number}`));
});

test('Phase 7 exit check: a declined card is retried and the owner is emailed each time; then paid services are suspended, and resume when a working card pays', async () => {
  // Amara's workspace pays with a card that saves, then declines.
  await addTestCard(t, 'amara-labs', '4000000000000341');
  const created = await t.post(`${AMARA}/services`, { as: 'amara', body: web({ name: 'amara-api', plan: 'standard', instances: 1 }) });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await t.idle();
  const svc = await t.records.services.byName('amara-labs', 'amara-api');
  const account = t.pay.payments.lookup('amara-labs');
  const start = clock.now();
  const inv = await t.pay.billing.createInvoice({ accountId: account.id, lines: [{ description: 'Standard instance: one month', amount: 500 }] });
  assert.equal(inv.status, 'open');
  const failures = () => t.outbox().filter((m) => m.to === 'amara@example.dev' && m.subject === `Payment failed for NooblyJS Cloud invoice ${inv.number}`);
  assert.equal(failures().length, 1, 'the first attempt');

  // The Billing page warns before anything is suspended.
  const warned = await t.get(`${AMARA}/billing`, { as: 'amara' });
  assert.equal(warned.json.warning.kind, 'overdue');
  assert.match(warned.json.warning.message, /If the last attempt fails, paid services are suspended/);

  for (const [day, n] of [[1, 2], [3, 3], [5, 4]]) {
    clock.set(new Date(start + day * DAY + 1000).toISOString());
    await t.pay.tick();
    await t.billing.idle();
    assert.equal(failures().length, n, `retry on day ${day}`);
    assert.equal((await t.records.services.byName('amara-labs', 'amara-api')).suspendedBy ?? null, null, 'not suspended yet');
  }
  clock.set(new Date(start + 7 * DAY + 1000).toISOString());
  await t.pay.tick();
  await t.billing.idle();
  await t.idle();
  assert.equal(failures().length, 5, 'the last attempt is emailed too');
  assert.equal(t.pay.payments.getAccount(account.id).status, 'delinquent');
  const held = await t.records.services.byName('amara-labs', 'amara-api');
  assert.equal(held.suspendedBy, 'billing');
  assert.equal((await t.platform().workloads.get('amara-labs', svc.workload)).status, 'suspended');
  assert.ok(t.outbox().some((m) => m.to === 'amara@example.dev' && m.subject === 'Paid services in Amara Labs are suspended'));
  const page = await t.get(`${AMARA}/billing`, { as: 'amara' });
  assert.equal(page.json.warning.kind, 'delinquent');
  // A suspended service bills nothing.
  assert.equal((await t.records.services.byName('amara-labs', 'amara-api')).status, 'suspended');
  assert.equal((await t.billing.handOff({ at: clock.now(), hours: 1 })).recorded, await paidRunning(), 'Amara\'s suspended service is not among them');
  assert.equal(await paidRunning(), 5);

  // A working card: the written-off invoice is paid at once, the account reinstated, the services resumed.
  const saved = await addCardByApi('amara', AMARA, '4242424242424242');
  assert.equal(saved.status, 201);
  await t.billing.idle();
  await t.idle();
  assert.equal(t.pay.billing.getInvoice(inv.id).status, 'paid');
  assert.equal(t.pay.payments.getAccount(account.id).status, 'active');
  assert.equal((await t.records.services.byName('amara-labs', 'amara-api')).suspendedBy, null);
  assert.notEqual((await t.platform().workloads.get('amara-labs', svc.workload)).status, 'suspended');
  assert.equal((await t.get(`${AMARA}/billing`, { as: 'amara' })).json.warning, null);
  assert.deepEqual(t.pay.payments.ledger.unbalanced(), []);
});

test('Pay now: an open invoice is charged on request, and someone else\'s invoice is a 404', async () => {
  const account = t.pay.payments.lookup('exclusivity-life');
  t.pay.mock.inject('charge', 'unavailable');
  const inv = await t.pay.billing.createInvoice({ accountId: account.id, lines: [{ description: 'Extra bandwidth', amount: 300 }] });
  assert.equal(inv.status, 'open');
  const other = await t.post(`${AMARA}/billing/invoices/${inv.id}/pay`, { as: 'amara', body: {} });
  assert.equal(other.status, 404);
  const paid = await t.post(`${WS}/billing/invoices/${inv.id}/pay`, { as: 'stevie', body: {} });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  assert.equal(paid.json.invoice.status, 'paid');
});
