// The Billing page's API (roadmap 7.6, 7.7), added to the workspace router so it sits behind requireWorkspace (another
// workspace is a 404) and the isolation suite walks it. Billing is the Owner's (product.md §7): a Member gets a 403.
//
//   GET    /workspaces/:ws/billing                       summary, services and their prices, warning, provider
//   POST   /workspaces/:ws/billing/cards                 starts a card setup (the provider's hosted fields)
//   POST   /workspaces/:ws/billing/cards/:setup/confirm  saves the card the hosted fields took; it becomes the default
//   POST   /workspaces/:ws/billing/cards/:card/default
//   DELETE /workspaces/:ws/billing/cards/:card           not the last card while paid services run
//   POST   /workspaces/:ws/billing/invoices/:invoice/pay
//   PATCH  /workspaces/:ws/billing/details               name, email, country, tax id, address on the invoices
//
// Card numbers never reach these routes: the hosted fields send them to the provider (or the mock provider's stand-in).

const sendError = (res, status, code, message, details) => res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
const COUNTRY = /^[A-Z]{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A payments refusal (422, 402, 404, 409) in the shape our client reads; anything else is ours to log. */
function payFailure(res, err) {
  if (err?.status >= 400 && err.status < 500 && err.code) {
    sendError(res, err.status === 403 ? 404 : err.status, err.code, err.message, err.details?.length ? err.details : undefined);
    return true;
  }
  if (err?.status === 503) {
    sendError(res, 503, 'unavailable', 'The card provider did not answer. Try again in a minute.');
    return true;
  }
  return false;
}

export function addBillingRoutes(router, { session, billing, pay, records, audit, W }) {
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => (payFailure(res, err) ? undefined : next(err)));
  const owner = session.requireOwner;
  const accountOf = (req) => billing.accountOf(req.workspace.id);

  router.get(`${W}/billing`, owner, wrap(async (req, res) => {
    res.json(await billing.view(req.workspace.id));
  }));

  router.post(`${W}/billing/cards`, owner, wrap(async (req, res) => {
    const account = await accountOf(req);
    const setup = await pay.payments.setupMethod(account.id, { returnUrl: `/w/${req.workspace.id}/billing` });
    res.status(201).json(setup);
  }));

  router.post(`${W}/billing/cards/:setup/confirm`, owner, wrap(async (req, res) => {
    const account = await accountOf(req);
    const card = await pay.payments.confirmMethod(account.id, req.params.setup);
    await audit({ action: 'billing.card-added', actor: req.person.id, target: req.workspace.id, detail: { brand: card.display.brand, last4: card.display.last4 } });
    res.status(201).json({ card: { id: card.id, ...card.display, isDefault: true } });
  }));

  router.post(`${W}/billing/cards/:card/default`, owner, wrap(async (req, res) => {
    const account = await accountOf(req);
    await pay.payments.makeDefault(account.id, req.params.card);
    await audit({ action: 'billing.card-default', actor: req.person.id, target: req.workspace.id, detail: { card: req.params.card } });
    res.json({ ok: true });
  }));

  router.delete(`${W}/billing/cards/:card`, owner, wrap(async (req, res) => {
    const account = await accountOf(req);
    const cards = pay.payments.listMethods(account.id);
    if (!cards.some((c) => c.id === req.params.card)) return sendError(res, 404, 'not_found', 'No such card.');
    if (cards.length === 1) {
      const paid = (await records.services.list(req.workspace.id)).filter(billing.isPaid);
      if (paid.length) return sendError(res, 409, 'conflict', `Paid services run in this workspace (${paid.map((s) => s.name).join(', ')}): add another card before removing this one, or move them to a free plan.`);
    }
    await pay.payments.removeMethod(account.id, req.params.card);
    await audit({ action: 'billing.card-removed', actor: req.person.id, target: req.workspace.id, detail: { card: req.params.card } });
    res.status(204).end();
  }));

  router.post(`${W}/billing/invoices/:invoice/pay`, owner, wrap(async (req, res) => {
    const account = await accountOf(req);
    let invoice;
    try {
      invoice = pay.billing.getInvoice(req.params.invoice);
    } catch {
      invoice = null;
    }
    if (!invoice || invoice.accountId !== account.id) return sendError(res, 404, 'not_found', 'No such invoice.');
    const out = await pay.payments.payInvoice(invoice.id);
    await pay.idle();
    const after = pay.billing.getInvoice(invoice.id);
    await audit({ action: 'billing.invoice-paid', actor: req.person.id, target: req.workspace.id, detail: { invoice: after.number, status: after.status } });
    if (after.status !== 'paid') {
      const waiting = out?.payment?.status === 'requires_action';
      return sendError(res, 402, waiting ? 'action_required' : 'payment_failed', waiting ? 'Your bank asks you to confirm this payment: open the invoice to confirm it.' : out?.payment?.failure?.message ?? 'The card was not charged.');
    }
    res.json({ invoice: { id: after.id, number: after.number, status: after.status } });
  }));

  router.patch(`${W}/billing/details`, owner, wrap(async (req, res) => {
    const account = await accountOf(req);
    const b = req.body ?? {};
    const problems = [];
    const patch = {};
    const text = (key, max, label) => {
      if (b[key] === undefined) return;
      if (b[key] !== null && (typeof b[key] !== 'string' || b[key].trim().length > max)) problems.push({ path: key, message: `${label}, up to ${max} characters.` });
      else patch[key] = b[key] === null || !b[key].trim() ? null : b[key].trim();
    };
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 200)) problems.push({ path: 'name', message: 'The name on the invoices.' });
    else if (b.name !== undefined) patch.name = b.name.trim();
    if (b.email !== undefined && (typeof b.email !== 'string' || !EMAIL_RE.test(b.email.trim()))) problems.push({ path: 'email', message: 'The address invoices and receipts go to.' });
    else if (b.email !== undefined) patch.email = b.email.trim();
    if (b.country !== undefined && b.country !== null && b.country !== '' && !COUNTRY.test(String(b.country).toUpperCase())) problems.push({ path: 'country', message: 'A two-letter country code, such as ZA.' });
    else if (b.country !== undefined) patch.country = b.country ? String(b.country).toUpperCase() : null;
    text('taxId', 50, 'A VAT or tax number');
    const address = {};
    for (const [key, label] of [['line1', 'The street address'], ['city', 'The city'], ['postalCode', 'The postal code']]) {
      const v = b.address?.[key];
      if (v === undefined) continue;
      if (v !== null && (typeof v !== 'string' || v.length > 200)) problems.push({ path: `address.${key}`, message: `${label}, up to 200 characters.` });
      else address[key] = v ? v.trim() : null;
    }
    if (problems.length) return sendError(res, 422, 'invalid', 'Check the highlighted fields.', problems);
    if (Object.keys(address).length) patch.address = { ...(account.address ?? {}), ...address, country: patch.country ?? account.country ?? null };
    await pay.payments.updateAccount(account.id, patch);
    await audit({ action: 'billing.details-changed', actor: req.person.id, target: req.workspace.id, detail: { fields: Object.keys(patch) } });
    res.json(await billing.view(req.workspace.id));
  }));
}
