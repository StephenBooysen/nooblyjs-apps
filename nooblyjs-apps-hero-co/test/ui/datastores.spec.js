// Roadmap 6.4, desktop and phone: create a Postgres database on the Local network (the short form, its plan priced in
// the summary), see its page (connection details, Storage and Connections meters, backups, plan), reveal the connection
// string by typing its name, back it up, create a Key Value store, and link the seeded database to the seeded api from
// the api's Environment tab. The in-process agent and the stand-in Postgres engine run them (HERO_LOCAL_AGENT=mock).
import { test, expect } from '@playwright/test';

const WS = '/w/exclusivity-life';

function watch(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to (load|apply|execute)/i.test(text)) problems.push(`csp: ${text}`);
    else if (msg.type() === 'error' && !/Failed to load resource/.test(text)) problems.push(`console: ${text}`);
  });
  return problems;
}

test('create Postgres and Key Value, reveal, back up, and link to a service', async ({ page, context, baseURL }, info) => {
  test.setTimeout(60_000);
  await context.request.post(`${baseURL}/dev/login`, { form: { person: 'stevie' }, maxRedirects: 0 });
  const problems = watch(page);
  const suffix = `${info.project.name}-${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(-14);

  await page.goto(`${WS}/new/postgres`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'New Postgres' })).toBeVisible();
  const summary = page.getByRole('complementary', { name: 'Summary' });
  await expect(summary.locator('[data-sum="price"]')).toHaveText('$7 / mo');
  await page.locator('label.nj-plan', { hasText: 'Standard' }).click();
  await expect(summary.locator('[data-sum="plan"]')).toContainText('50 connections');
  await summary.getByRole('button', { name: 'Create database' }).click();
  await expect(page.locator('.invalid-feedback[data-for="name"]')).toContainText('Lower-case letters');
  const name = `db-${suffix}`;
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Region').selectOption('local');
  await summary.getByRole('button', { name: 'Create database' }).click();
  await expect(page).toHaveURL(new RegExp(`${WS}/services/${name}$`));

  // Its page: Live, its own user, meters, the connection string after typing the name.
  await expect(page.locator('[data-status] .nj-pill')).toHaveText('Live', { timeout: 15_000 });
  await expect(page.getByRole('meter', { name: 'Storage' })).toHaveAttribute('aria-valuetext', /of 10 GB/, { timeout: 15_000 });
  await expect(page.getByRole('meter', { name: 'Connections' })).toHaveAttribute('aria-valuetext', /of 50/);
  await expect(page.locator('[data-connection]')).toContainText('relay on the workspace');
  await page.getByLabel(`Type ${name} to see the connection string`).fill('wrong');
  await page.getByRole('button', { name: 'Reveal' }).click();
  await expect(page.locator('.invalid-feedback[data-for="confirm"]')).toContainText(`Type ${name}`);
  await page.getByLabel(`Type ${name} to see the connection string`).fill(name);
  await page.getByRole('button', { name: 'Reveal' }).click();
  await expect(page.getByLabel('Connection string', { exact: true })).toHaveValue(/^postgres:\/\/nb_/);

  // Back up now: the table gets the backup, with Restore.
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.locator('[data-backups] tbody tr')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('[data-backups]').getByRole('button', { name: /^Restore the backup/ })).toBeVisible();

  // Key Value: memory and eviction.
  await page.goto(`${WS}/new/keyvalue`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Eviction')).toHaveValue('allkeys-lru');
  await page.getByLabel('Name', { exact: true }).fill(`kv-${suffix}`);
  await page.getByLabel('Region').selectOption('local');
  await page.getByRole('complementary', { name: 'Summary' }).getByRole('button', { name: 'Create Key Value store' }).click();
  await expect(page.locator('[data-status] .nj-pill')).toHaveText('Live', { timeout: 15_000 });
  await expect(page.locator('[data-connection]')).toContainText('private name only the workspace');

  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(width).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('link the seeded database to the seeded api from its Environment tab', async ({ page, context, baseURL }) => {
  test.setTimeout(45_000);
  await context.request.post(`${baseURL}/dev/login`, { form: { person: 'stevie' }, maxRedirects: 0 });
  const problems = watch(page);
  await page.goto(`${WS}/services/api?tab=environment`);
  const card = page.locator('[data-links-card]');
  await expect(card.getByRole('heading', { name: 'Linked data stores' })).toBeVisible();
  // Only stores in the api's region (Johannesburg) are offered.
  const options = await card.getByLabel('Data store').locator('option').allTextContents();
  expect(options.every((o) => /^(database|cache) /.test(o))).toBe(true);
  await card.getByLabel('Data store').selectOption('cache');
  await expect(card.getByLabel('As')).toHaveValue('REDIS_URL');
  await card.getByLabel('Data store').selectOption('database');
  await expect(card.getByLabel('As')).toHaveValue('DATABASE_URL');
  await card.getByRole('button', { name: 'Link to service' }).click();
  await expect(page.locator('[data-links-card] [data-links-note]')).toContainText('deploying again');
  await expect(page.locator('[data-links-card]')).toContainText('DATABASE_URL');
  // The database's page lists the api.
  await page.goto(`${WS}/services/database`);
  await expect(page.locator('[data-linked]')).toContainText('api');
  // Remove it again (the other project shares the seed).
  await page.goto(`${WS}/services/api?tab=environment`);
  await page.getByRole('button', { name: 'Remove the link DATABASE_URL' }).click();
  await expect(page.locator('[data-links-card]')).toContainText('No data stores linked.');
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(width).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('the dashboard shows the database\'s storage and connections and the cache\'s memory', async ({ page, context, baseURL }) => {
  const problems = watch(page);
  await context.request.post(`${baseURL}/dev/login`, { form: { person: 'stevie' }, maxRedirects: 0 });
  await page.goto(WS);
  await expect(page.locator('[data-card="database"]').getByRole('meter', { name: 'Storage' })).toHaveAttribute('aria-valuetext', /of 10 GB$/);
  await expect(page.locator('[data-card="database"]').getByRole('meter', { name: 'Connections' })).toBeVisible();
  await expect(page.locator('[data-card="cache"]').getByRole('meter', { name: 'Memory' })).toBeVisible();
  expect(problems).toEqual([]);
});
