// Roadmap 7.6 and 7.7, desktop and phone, on the payments accelerator's mock provider. The Billing page: the paid
// invoices of the development seed (three closed months on Stevie's workspace), their PDFs, the plan, and a card added
// through the hosted fields (a same-origin frame: the card number never reaches our page). The free tier: a new
// workspace asks for a paid Postgres, gets the *Add a card* prompt, saves a card in it, and the form goes through.
import { test, expect } from '@playwright/test';

const WS = '/w/exclusivity-life';
/** A stat tile by its label. */
const tile = (page, label) => page.locator('.nj-stat').filter({ has: page.locator('.nj-stat-label', { hasText: new RegExp(`^${label}$`) }) });

function watch(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to (load|apply|execute|frame)/i.test(text)) problems.push(`csp: ${text}`);
    else if (msg.type() === 'error' && !/Failed to load resource/.test(text)) problems.push(`console: ${text}`);
  });
  return problems;
}

/** Types a test card into the mock provider's hosted fields. */
async function typeCard(page, number) {
  const fields = page.frameLocator('iframe[title="Card details"]');
  await fields.getByLabel('Card number').fill(number);
  await fields.getByLabel('Expiry (MM/YY)').fill('12/30');
  await fields.getByLabel('Security code').fill('123');
}

test('the Billing page: paid invoices with PDFs, the plan, and a card added through the hosted fields', async ({ page, context, baseURL }, info) => {
  await context.request.post(`${baseURL}/dev/login`, { form: { person: 'stevie' }, maxRedirects: 0 });
  const problems = watch(page);
  await page.goto(`${WS}/billing`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'Billing' })).toBeVisible();
  await expect(tile(page, 'Card')).toContainText('Visa 4242');

  // The seed's three closed months, paid by the test card, each with a PDF.
  const invoices = page.locator('.pay-summary-invoices tbody tr');
  await expect(invoices).toHaveCount(3);
  await expect(invoices.first().locator('.pay-pill')).toHaveText('Paid');
  const pdf = invoices.first().getByRole('link', { name: /^PDF of invoice INV-/ });
  const res = await context.request.get(new URL(await pdf.getAttribute('href'), baseURL).toString());
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');
  await expect(page.getByRole('heading', { name: 'Next invoice' })).toBeVisible();

  // Another card: the hosted fields in a frame; it becomes the default. Both projects share Stevie's workspace, so
  // only one of them changes the cards; the phone checks the form opens and closes.
  await page.getByRole('button', { name: 'Add a card' }).click();
  if (info.project.name === 'phone') {
    await expect(page.frameLocator('iframe[title="Card details"]').getByLabel('Card number')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Add a card' })).toBeVisible();
    expect(problems).toEqual([]);
    return;
  }
  await typeCard(page, '5555 5555 5555 4444');
  await page.getByRole('button', { name: 'Save card' }).click();
  await expect(page.locator('.pay-summary-cards li', { hasText: 'Mastercard ending 4444' })).toBeVisible();
  await expect(tile(page, 'Card')).toContainText('Mastercard 4444');
  // Back to the Visa, and the Mastercard goes.
  await page.locator('.pay-summary-cards li', { hasText: 'Visa ending 4242' }).getByRole('button', { name: 'Make default' }).click();
  await expect(tile(page, 'Card')).toContainText('Visa 4242');
  await page.getByRole('button', { name: 'Remove the card ending 4444' }).click();
  await expect(page.locator('.pay-summary-cards li', { hasText: 'ending 4444' })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('the free tier: a paid Postgres asks for a card, the prompt saves one, and the form goes through', async ({ page, context, baseURL }, info) => {
  test.setTimeout(60_000);
  const suffix = `${info.project.name}${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-12);
  const signup = await context.request.post(`${baseURL}/api/v1/auth/signup`, {
    headers: { origin: baseURL },
    data: { name: 'Card Tester', team: `Cards ${suffix}`, email: `cards-${suffix}@example.dev`, password: 'a long password 1' },
  });
  expect(signup.status()).toBe(201);
  const home = (await signup.json()).redirect;
  const problems = watch(page);

  await page.goto(`${home}/new/postgres`, { waitUntil: 'domcontentloaded' });
  const summary = page.getByRole('complementary', { name: 'Summary' });
  await expect(summary.locator('[data-sum="price"]')).toHaveText('$7 / mo');
  await page.getByLabel('Name', { exact: true }).fill(`db-${suffix}`);
  await page.getByLabel('Region').selectOption('local');
  await summary.getByRole('button', { name: 'Create database' }).click();
  const alert = page.locator('[data-form-alert]');
  await expect(alert).toContainText('Postgres Starter costs $7 a month: add a card');
  await alert.getByRole('button', { name: 'Add a card' }).click();

  const dialog = page.getByRole('dialog', { name: 'Add a card' });
  await expect(dialog).toBeVisible();
  await typeCard(page, '4000 0000 0000 0002');
  await dialog.getByRole('button', { name: 'Save card and continue' }).click();
  await expect(dialog.locator('.pay-card-error')).toContainText('declined');
  await typeCard(page, '4242 4242 4242 4242');
  await dialog.getByRole('button', { name: 'Save card and continue' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`${home}/services/db-${suffix}$`), { timeout: 15_000 });
  expect(problems).toEqual([]);
});

test('operators: NooblyJS Pay: orders, an order and its payment details, a partial refund, recurring, setup and plans', async ({ page, context, baseURL }) => {
  test.setTimeout(60_000);
  await context.request.post(`${baseURL}/dev/login`, { form: { person: 'ops-platform' }, maxRedirects: 0 });
  const problems = watch(page);
  await page.goto('/admin/payments/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'Orders & payments' })).toBeVisible();
  await expect(page.locator('#pay-provider')).toContainText('test mode');
  const first = page.getByRole('table', { name: 'Orders' }).locator('tbody tr').filter({ hasText: 'Paid' }).first().getByRole('link');
  await expect(first).toHaveText(/^INV-\d{4}-\d{6}$/);
  const number = await first.textContent();
  await first.click();

  // The order: stat cards, its payments, and the selected payment's details.
  await expect(page.getByRole('heading', { level: 1, name: 'Order payments' })).toBeVisible();
  await expect(page.getByRole('link', { name: `Orders · ${number}` })).toBeVisible();
  await expect(page.locator('.pay-stat', { hasText: 'Collected · 1 payment' })).toBeVisible();
  const details = page.getByRole('complementary', { name: 'Payment details' });
  await expect(details).toContainText('Visa ·· 4242');
  await expect(details.locator('.pay-timeline li').first()).toContainText('Charge started');
  await expect(details.locator('pre')).toContainText('invoiceId: in_');

  // A partial refund: the summary follows the amount; the success banner and the earlier refunds list show it.
  await details.getByRole('link', { name: 'Refund' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Refund a payment' })).toBeVisible();
  await page.getByText('A partial amount').click();
  await page.getByLabel('Refund amount (USD)').fill('1.00');
  await expect(page.locator('[data-sum="this"]')).toHaveText('−$1.00');
  await page.getByLabel('Reason').selectOption({ label: 'Duplicate payment' });
  await page.getByLabel(/Note for your team/).fill('Charged twice in the test');
  await page.getByRole('button', { name: 'Refund $1.00' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Refund of $1.00 sent to' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Summary' }).locator('.pay-list li').first()).toContainText('Duplicate payment');

  await page.getByRole('link', { name: 'Recurring' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Recurring payments' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Schedules' }).locator('tbody tr').first()).toBeVisible();
  await expect(page.locator('[data-schedule-preview] li').first()).toHaveText('Today');
  await page.getByRole('link', { name: 'Stripe connection' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Stripe connection' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Not connected: test cards only' })).toBeVisible();
  await page.getByRole('link', { name: 'Webhooks' }).click();
  await expect(page.locator('pre.pay-code')).toContainText('/admin/payments/p/webhooks/mock');
  await page.goto('/admin/payments/#/plans');
  await expect(page.locator('td', { hasText: 'Standard instance' }).first()).toBeVisible();
  await expect(page.locator('td.pay-mono', { hasText: 'service-standard-monthly' })).toBeVisible();
  await page.goto('/admin/payments/#/overview');
  await expect(page.locator('.pay-stat', { hasText: 'Ledger' })).toContainText('Balanced');
  expect(problems).toEqual([]);
});

test('the hosted checkout: an operator emails a payment link, the customer pays it with a new card, and the receipt goes back', async ({ page, context, baseURL }) => {
  test.setTimeout(60_000);
  await context.request.post(`${baseURL}/dev/login`, { form: { person: 'ops-platform' }, maxRedirects: 0 });
  const problems = watch(page);
  // Take a payment by link for Amara's workspace.
  await page.goto('/admin/payments/#/orders?take=1', { waitUntil: 'domcontentloaded' });
  const customer = page.getByLabel('Customer', { exact: true });
  const amara = await customer.locator('option').filter({ hasText: /amara/i }).first().getAttribute('value');
  await customer.selectOption(amara);
  await page.getByLabel('What it is for').fill('Migration help');
  await page.getByLabel('Amount (USD)').fill('12.34');
  await page.getByText('Email a payment link').click();
  await page.getByRole('button', { name: 'Create the order' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Order payments' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy payment link' })).toBeVisible();
  await expect(page.locator('.pay-stat', { hasText: 'Order total' })).toContainText('Open');
  const number = (await page.getByRole('link', { name: /^Orders · INV-/ }).textContent()).replace('Orders · ', '').trim();

  // The link, from the Checkout page.
  await page.getByRole('link', { name: 'Checkout page' }).click();
  const row = page.getByRole('table', { name: 'Open payment links' }).locator('tr', { hasText: number });
  const href = await row.getByRole('link', { name: /Open/ }).getAttribute('href');
  await page.goto(`${href}?return=${encodeURIComponent('/w/amara-labs/billing')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Payment' })).toBeVisible();
  await expect(page.locator('#pay-co-amount')).toHaveText('$12.34');
  await expect(page.getByRole('link', { name: /Back to NooblyJS Cloud/ })).toBeVisible();
  await typeCard(page, '4242 4242 4242 4242');
  await page.getByRole('button', { name: 'Pay $12.34' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Payment received' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Visa ·· 4242')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to NooblyJS Cloud now' })).toHaveAttribute('href', new RegExp(`/w/amara-labs/billing\\?payment=succeeded&invoice=${number}$`));
  expect(problems).toEqual([]);
});
