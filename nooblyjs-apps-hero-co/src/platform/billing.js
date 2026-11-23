// Billing (roadmap 7.4–7.7; stack.md §3.4, D14) on nooblyjs-accel-payments. We keep no money logic of our own: the
// accelerator holds the catalogue, the billing accounts, usage, invoices, cards (through the provider's hosted
// fields), collection and dunning. This file is the hand-off between it and the platform:
//
//   catalogue   seeded from public/js/shared/catalog.js (one metered price per paid plan: its monthly price, billed by
//               the hour, `divideBy: 'month_hours'`); after that the payments catalogue owns prices and they come back
//               to catalog.js through applyPrices(), so the create form's Summary reads them.
//   accounts    one billing account per workspace (externalRef = workspace id, email = the owner), with one
//               subscription holding every metered price; a price with no usage puts no line on the invoice.
//   usage       each hour, one service-hour for every paid service that is not suspended (flat price per service,
//               whatever its instance count: product.md §11), in one batch, idempotent per service and hour.
//   free tier   Starter, a free Key Value store and Static Sites need no card; anything paid does (402 card_required).
//   dunning     the accelerator retries and emails the owner each time; after the final attempt the account is
//               delinquent and we suspend the workspace's paid services, then resume them when it pays.
import { PLANS, DATA_PLANS, CREATABLE, planOf, dataPlanOf, applyPrices } from '../../public/js/shared/catalog.js';

const HOUR = 3600_000;
const ACTOR = { id: 'hero-billing', name: 'Billing', kind: 'system' };
const iso = (ms) => new Date(ms).toISOString();
const floorHour = (ms) => Math.floor(ms / HOUR) * HOUR;

/** The payments product a service bills under: service-<plan>, postgres-<plan>, keyvalue-<plan>; null when it has no plan. */
export function productKeyOf(type, plan) {
  if (type === 'postgres' || type === 'keyvalue') return dataPlanOf(type, plan) ? `${type}-${plan}` : null;
  return CREATABLE[type]?.plan && planOf(plan) ? `service-${plan}` : null;
}
const meterKeyOf = (productKey) => `${productKey.replace(/-/g, '_')}_hours`;
const priceKeyOf = (productKey) => `${productKey}-monthly`;
const UNIT = { service: 'service-hour', postgres: 'database-hour', keyvalue: 'store-hour' };
const LABEL = { service: (p) => `${p.name} instance`, postgres: (p) => `Postgres ${p.name}`, keyvalue: (p) => `Key Value ${p.name}` };

/** Every plan with a price, as (family, plan). */
function pricedPlans() {
  return [
    ...PLANS.map((p) => ({ family: 'service', plan: p })),
    ...Object.entries(DATA_PLANS).flatMap(([family, plans]) => plans.map((plan) => ({ family, plan }))),
  ];
}

/** The catalogue ensureCatalogue() seeds: paid plans only (a free plan has nothing to bill). */
export function billingCatalogue() {
  const paid = pricedPlans().filter(({ plan }) => plan.priceUsd > 0);
  return {
    meters: paid.map(({ family, plan }) => ({ key: meterKeyOf(`${family}-${plan.key}`), name: `${LABEL[family](plan)} hours`, unit: 'hour', aggregate: 'sum' })),
    products: paid.map(({ family, plan }) => ({ key: `${family}-${plan.key}`, name: LABEL[family](plan), unitLabel: UNIT[family] })),
    prices: paid.map(({ family, plan }) => ({
      key: priceKeyOf(`${family}-${plan.key}`), product: `${family}-${plan.key}`, type: 'metered', meter: meterKeyOf(`${family}-${plan.key}`),
      unitAmount: Math.round(plan.priceUsd * 100), divideBy: 'month_hours', nickname: `${plan.priceUsd} USD a month, by the hour`,
    })),
  };
}

export class CardRequired extends Error {
  constructor(message) {
    super(message);
    this.status = 402;
    this.code = 'card_required';
  }
}

/**
 * @param {object} o
 * @param {object} o.pay              what the payments accelerator's mount() returned
 * @param {object} o.accounts
 * @param {object} o.records
 * @param {() => object} o.platform   services.platform
 * @param {object} o.link             customers-link (the suspension email)
 * @param {import('node:events').EventEmitter} o.eventEmitter
 * @param {object} o.realtime
 * @param {(entry: object) => Promise<void>} o.audit
 * @param {{ publicUrl: string }} o.config
 * @param {{ now(): number }} [o.clock]   the payments clock (tests move it)
 * @param {boolean} [o.timers]       the hourly hand-off; false in tests
 */
export function createBilling({ pay, accounts, records, platform, link, eventEmitter, realtime, audit, config, log = console, clock = { now: () => Date.now() }, timers = true }) {
  const B = pay.billing;
  const P = pay.payments;

  /** Monthly USD of a product from the payments catalogue (0 when it has no price: a free plan). */
  function usdOf(productKey) {
    if (!productKey) return 0;
    try {
      const price = B.currentPrice(productKey);
      return price ? price.unitAmount / 100 : 0;
    } catch {
      return 0;
    }
  }

  /** { service: { starter: 0, standard: 5, … }, postgres: { … }, keyvalue: { … } } from the payments catalogue. */
  function prices() {
    const out = { service: {}, postgres: {}, keyvalue: {} };
    for (const { family, plan } of pricedPlans()) out[family][plan.key] = usdOf(`${family}-${plan.key}`);
    // The server's catalog.js (service pages' estimates) follows the payments catalogue too.
    applyPrices(out);
    return out;
  }

  /** Current prices of every paid product, for the subscription's items. */
  function itemPrices() {
    return billingCatalogue().products.map((p) => {
      try {
        return B.currentPrice(p.key);
      } catch {
        return null;
      }
    }).filter((x) => x?.active !== false && x);
  }

  async function ownerOf(workspaceId) {
    return (await accounts.membersOf(workspaceId)).find((m) => m.role === 'Owner') ?? null;
  }

  const ensuring = new Map();
  /**
   * The workspace's billing account and its subscription (created once; the items follow the catalogue's current
   * prices, so a new price an operator adds replaces the old one from then on).
   * @param {{ id: string, name: string }|string} workspace
   * @param {{ startAt?: string }} [o]   development seed only: a subscription that began in the past
   */
  function ensureWorkspace(workspace, o = {}) {
    const id = typeof workspace === 'string' ? workspace : workspace.id;
    if (!ensuring.has(id)) {
      ensuring.set(id, (async () => {
        const ws = typeof workspace === 'string' ? await accounts.getWorkspace(id) : workspace;
        if (!ws) return null;
        let account = P.lookup(ws.id);
        if (!account) {
          const owner = await ownerOf(ws.id);
          if (!owner) return null;
          account = await P.ensureAccount({ externalRef: ws.id, name: ws.name, email: owner.email, metadata: { workspaceId: ws.id } });
        }
        const items = itemPrices().map((p) => ({ priceId: p.id }));
        const sub = B.listSubscriptions((s) => s.accountId === account.id && s.status !== 'cancelled')[0];
        if (!sub) {
          await B.subscribe({ accountId: account.id, items, externalKey: `hero:${ws.id}`, ...(o.startAt ? { startAt: o.startAt } : {}) });
        } else {
          const want = items.map((i) => i.priceId).sort().join(',');
          if (sub.items.map((i) => i.priceId).sort().join(',') !== want) await B.updateItems(sub.id, { items, prorate: 'none' });
        }
        return P.getAccount(account.id);
      })().finally(() => ensuring.delete(id)));
    }
    return ensuring.get(id);
  }

  const accountOf = async (workspaceId) => P.lookup(workspaceId) ?? ensureWorkspace(workspaceId);

  /**
   * The free tier (roadmap 7.6): throws CardRequired when a paid plan is asked for and the workspace has no card.
   * @param {string} workspaceId
   * @param {string} type   service type (web, worker, postgres, …)
   * @param {string} plan
   */
  async function requireCardFor(workspaceId, type, plan) {
    const productKey = productKeyOf(type, plan);
    const usd = usdOf(productKey);
    if (!usd) return;
    const account = await accountOf(workspaceId);
    if (account?.defaultMethodId) return;
    const name = type === 'postgres' || type === 'keyvalue' ? LABEL[type](dataPlanOf(type, plan)) : planOf(plan).name;
    const free = type === 'postgres' ? 'Postgres has no free plan.' : type === 'keyvalue' ? 'Key Value Starter is free.' : 'Starter is free.';
    throw new CardRequired(`${name} costs $${usd} a month: add a card to the workspace first. ${free}`);
  }

  /**
   * The hourly hand-off (roadmap 7.5): a service-hour for each paid service that is not suspended, for the `hours`
   * hours ending at `at` (an hour boundary). Idempotent per service and hour, so running it twice records nothing new.
   * @returns {Promise<{ recorded: number, duplicates: number }>}
   */
  async function handOff({ at = floorHour(clock.now()), hours = 1 } = {}) {
    const end = floorHour(at);
    const events = [];
    for (const ws of await accounts.listWorkspaces()) {
      const services = await records.services.list(ws.id);
      const billable = services.filter((s) => s.status !== 'suspended' && usdOf(productKeyOf(s.type, s.plan)) > 0);
      if (!billable.length) continue;
      const account = await accountOf(ws.id);
      if (!account) continue;
      for (const s of billable) {
        const meter = meterKeyOf(productKeyOf(s.type, s.plan));
        const created = Date.parse(s.createdAt) || 0;
        for (let h = hours; h >= 1; h -= 1) {
          const start = end - h * HOUR;
          if (start + HOUR <= created) continue;
          events.push({ accountId: account.id, meter, quantity: 1, at: iso(start), idempotencyKey: `hero:${s.id}:${start}`, metadata: { service: s.name } });
        }
      }
    }
    let recorded = 0;
    let duplicates = 0;
    for (let i = 0; i < events.length; i += 1000) {
      const out = await B.recordUsage(events.slice(i, i + 1000));
      recorded += out.recorded;
      duplicates += out.duplicates;
    }
    return { recorded, duplicates };
  }

  // ---- delinquent: suspend paid services; reinstated: resume them ---------------------------------------------

  async function suspendPaid(workspaceId) {
    const services = await records.services.list(workspaceId);
    const paid = services.filter((s) => s.workload && !['postgres', 'keyvalue'].includes(s.type) && s.status !== 'suspended' && usdOf(productKeyOf(s.type, s.plan)) > 0);
    const done = [];
    for (const s of paid) {
      try {
        await platform().workloads.suspend(workspaceId, s.workload, { actor: ACTOR });
        await records.services.update(workspaceId, s.id, { suspendedBy: 'billing' });
        done.push(s.name);
      } catch (err) {
        log.warn?.(`[hero-co] billing could not suspend ${workspaceId}/${s.name}: ${err.message}`);
      }
    }
    await audit({ action: 'billing.suspended', actor: 'system', target: workspaceId, detail: { services: done } });
    realtime?.publish(workspaceId, 'billing', { status: 'delinquent', suspended: done });
    const owner = await ownerOf(workspaceId);
    const ws = await accounts.getWorkspace(workspaceId);
    if (owner && done.length) {
      const person = await accounts.getPerson(owner.personId);
      await link.send('cloud-services-suspended', {
        person,
        data: { person: { name: person.name }, workspace: { name: ws?.name ?? workspaceId }, services: done.join(', '), billingUrl: `${config.publicUrl}/w/${workspaceId}/billing` },
        idempotencyKey: `suspended:${workspaceId}:${Math.floor(clock.now() / HOUR)}`,
      });
    }
    return done;
  }

  async function resumeHeld(workspaceId) {
    const held = (await records.services.list(workspaceId)).filter((s) => s.suspendedBy === 'billing');
    const done = [];
    for (const s of held) {
      try {
        await platform().workloads.resume(workspaceId, s.workload, { actor: ACTOR });
        done.push(s.name);
      } catch (err) {
        if (err.code !== 'conflict') log.warn?.(`[hero-co] billing could not resume ${workspaceId}/${s.name}: ${err.message}`);
      }
      await records.services.update(workspaceId, s.id, { suspendedBy: null });
    }
    await audit({ action: 'billing.resumed', actor: 'system', target: workspaceId, detail: { services: done } });
    realtime?.publish(workspaceId, 'billing', { status: 'active', resumed: done });
    return done;
  }

  const workspaceOfAccount = (accountId) => {
    try {
      return P.getAccount(accountId)?.externalRef ?? null;
    } catch {
      return null;
    }
  };
  const pending = new Set();
  const track = (p) => {
    pending.add(p);
    p.catch((err) => log.error?.(`[hero-co] billing: ${err.stack ?? err.message}`)).finally(() => pending.delete(p));
  };
  const onDelinquent = (e) => {
    const ws = e?.data?.externalRef ?? workspaceOfAccount(e?.data?.accountId);
    if (ws) track(suspendPaid(ws));
  };
  const onReinstated = (e) => {
    const ws = e?.data?.externalRef ?? workspaceOfAccount(e?.data?.accountId);
    if (ws) track(resumeHeld(ws));
  };
  const onBillingEvent = (e) => {
    const ws = e?.data?.externalRef ?? workspaceOfAccount(e?.data?.accountId);
    if (ws) realtime?.publish(ws, 'billing', { type: e.type });
  };
  eventEmitter.on('pay.account.delinquent', onDelinquent);
  eventEmitter.on('pay.account.reinstated', onReinstated);
  for (const type of ['pay.invoice.finalized', 'pay.invoice.paid', 'pay.payment.failed', 'pay.payment.succeeded']) eventEmitter.on(type, onBillingEvent);

  // ---- the Billing page -----------------------------------------------------------------------------------

  /** What the Billing page shows: the payments summary, the workspace's services with their monthly prices, a warning. */
  async function view(workspaceId) {
    const account = await accountOf(workspaceId);
    const summary = await B.summary(account.id);
    const services = (await records.services.list(workspaceId)).map((s) => {
      const productKey = productKeyOf(s.type, s.plan);
      const data = s.type === 'postgres' || s.type === 'keyvalue';
      const plan = data ? dataPlanOf(s.type, s.plan) : planOf(s.plan);
      return {
        name: s.name, type: s.type, label: data ? (s.type === 'postgres' ? 'Postgres' : 'Key Value') : CREATABLE[s.type]?.label ?? s.type,
        planName: productKey ? plan?.name ?? s.plan : null, usd: usdOf(productKey), status: s.status, suspendedByBilling: s.suspendedBy === 'billing',
      };
    }).sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name));
    const overdue = summary.invoices.filter((i) => i.status === 'open' && i.attempts > 0).sort((a, b) => (a.finalizedAt < b.finalizedAt ? -1 : 1))[0] ?? null;
    const written = summary.invoices.filter((i) => i.status === 'uncollectible');
    return {
      summary: { ...summary, invoices: summary.invoices.map((i) => ({ ...i, pdfUrl: i.url ? `${i.url}/pdf` : null })) },
      services,
      estimateUsd: services.filter((s) => !s.suspendedByBilling).reduce((sum, s) => sum + s.usd, 0),
      warning: account.status === 'delinquent'
        ? { kind: 'delinquent', invoices: written.map((i) => i.number), message: `Paid services are suspended: ${written.length === 1 ? `invoice ${written[0].number} was` : `${written.length} invoices were`} not paid. Add a working card and they are paid and the services resume.` }
        : overdue
          ? { kind: 'overdue', invoice: overdue.number, nextAttemptAt: overdue.nextAttemptAt, message: `The payment for invoice ${overdue.number} failed${overdue.nextAttemptAt ? `; we try the card again on ${overdue.nextAttemptAt.slice(0, 10)}` : ''}. If the last attempt fails, paid services are suspended. Add another card to pay it now.` }
          : null,
      provider: pay.client(),
      freeTier: 'Starter services, Key Value Starter and Static Sites are free. Paid instance types need a card on file.',
    };
  }

  // ---- the hourly timer -----------------------------------------------------------------------------------

  let timer = null;
  let last = null;
  async function hourly() {
    const at = floorHour(clock.now());
    const hours = last === null ? 1 : Math.min(24, Math.max(0, (at - last) / HOUR));
    if (hours > 0) {
      try {
        await handOff({ at, hours });
        last = at;
      } catch (err) {
        log.error?.(`[hero-co] billing usage hand-off failed: ${err.stack ?? err.message}`);
      }
    }
    schedule();
  }
  function schedule() {
    if (!timers) return;
    const wait = floorHour(clock.now()) + HOUR + 30_000 - clock.now();
    timer = setTimeout(hourly, Math.max(1000, wait));
    timer.unref?.();
  }

  /**
   * Seeds the catalogue, brings prices back into catalog.js and (unless ensureAll is false) makes sure every workspace
   * has its account, then starts the hourly hand-off.
   */
  let started = false;
  async function init({ ensureAll = true } = {}) {
    await B.ensureCatalogue(billingCatalogue());
    applyPrices(prices());
    if (!ensureAll) return;
    for (const ws of await accounts.listWorkspaces()) await ensureWorkspace(ws);
    if (timers && !started) {
      started = true;
      hourly();
    }
  }

  /**
   * Development only: a workspace with a test card and three closed months of usage for two Standard services, so
   * the Billing page has paid invoices to show. Runs once (when the workspace has no billing account yet).
   */
  async function seedDevelopment(workspaceId) {
    if (P.lookup(workspaceId)) return false;
    const now = clock.now();
    const d = new Date(now);
    const startAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1);
    const account = await ensureWorkspace(workspaceId, { startAt: iso(startAt) });
    if (!account) return false;
    if (pay.mock) {
      const setup = await P.setupMethod(account.id);
      pay.mock.hostedFields.attach(setup.clientSecret, { number: '4242424242424242', expMonth: 12, expYear: d.getUTCFullYear() + 3, cvc: '123' });
      await P.confirmMethod(account.id, setup.setupId);
    }
    const events = [];
    for (let t = startAt; t + HOUR <= floorHour(now); t += HOUR) {
      for (const service of ['web', 'api']) events.push({ accountId: account.id, meter: meterKeyOf('service-standard'), quantity: 1, at: iso(t), idempotencyKey: `hero-seed:${workspaceId}:${service}:${t}` });
    }
    for (let i = 0; i < events.length; i += 1000) await B.recordUsage(events.slice(i, i + 1000));
    await B.closeDue();
    await pay.idle();
    return true;
  }

  return {
    init, prices, productKeyOf, isPaid: (s) => usdOf(productKeyOf(s.type, s.plan)) > 0, ensureWorkspace, accountOf, requireCardFor, handOff, view, suspendPaid, resumeHeld, seedDevelopment,
    idle: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      await pay.idle();
    },
    shutdown() {
      if (timer) clearTimeout(timer);
      timer = null;
      timers = false;
      eventEmitter.off('pay.account.delinquent', onDelinquent);
      eventEmitter.off('pay.account.reinstated', onReinstated);
      for (const type of ['pay.invoice.finalized', 'pay.invoice.paid', 'pay.payment.failed', 'pay.payment.succeeded']) eventEmitter.off(type, onBillingEvent);
    },
  };
}
