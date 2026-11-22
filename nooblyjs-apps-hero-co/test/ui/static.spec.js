// Roadmap 5.2, desktop and phone: create a Static Site on the Local network (publish directory, single-page app, no
// start command, no instances, free), see what it serves with the Bandwidth and Cache hit rate meters, open it under
// its path, deploy again, roll back at once, change single-page app without a rebuild, and see the meters on the
// dashboard. The in-process agent (HERO_LOCAL_AGENT=mock) builds it; test/static.test.js covers the serving rules.
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

test('create a static site, open it, deploy again, roll back, change single-page app', async ({ page, context, baseURL }, info) => {
  test.setTimeout(60_000);
  const res = await context.request.post(`${baseURL}/dev/login`, { form: { person: 'stevie' }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
  const problems = watch(page);

  await page.goto(`${WS}/new/static`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'New Static Site' })).toBeVisible();
  await page.locator('label.nj-repo', { hasText: 'software-factory' }).click();
  const summary = page.getByRole('complementary', { name: 'Summary' });

  // A publish directory and single-page app; no start command, no instance type, free.
  await expect(page.getByLabel('Start command')).toHaveCount(0);
  await expect(page.getByLabel('Instances')).toHaveCount(0);
  await expect(page.getByLabel('Publish directory')).toHaveValue('dist');
  await expect(summary.locator('[data-sum="price"]')).toHaveText('$0 / mo');
  await expect(summary.getByText('Static sites are free')).toBeVisible();
  const name = `site-${info.project.name}-${Date.now().toString(36)}`;
  await page.getByLabel('Service name').fill(name);
  await page.getByLabel('Region').selectOption('local');
  await expect(page.locator('[data-url-full]')).toHaveText(`${baseURL}/exclusivity-life/${name}/`);

  await page.getByLabel('Publish directory').fill('../dist');
  await summary.getByRole('button', { name: 'Deploy static site' }).click();
  await expect(page.locator('.invalid-feedback[data-for="publishDir"]')).toContainText('A folder inside the build');
  await page.getByLabel('Publish directory').fill('dist');
  await page.getByLabel('Single-page app').check();
  await summary.getByRole('button', { name: 'Deploy static site' }).click();
  await expect(page).toHaveURL(new RegExp(`${WS}/services/${name}$`));

  // Its page: no Restart; what it serves, the meters, the deploys kept for rollback.
  await expect(page.locator('[data-status] .nj-pill')).toHaveText('Live', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Restart' })).toHaveCount(0);
  const card = page.locator('[data-site-card]');
  await expect(card.locator('[data-serving]')).toContainText('Serving', { timeout: 10_000 });
  await expect(card.locator('[data-serving]')).toContainText('3 files');
  await expect(card.getByRole('meter', { name: 'Bandwidth this month' })).toHaveAttribute('aria-valuetext', /of 100 GB/);
  await expect(card.getByRole('meter', { name: 'Cache hit rate' })).toBeVisible();
  await expect(card.getByLabel('Single-page app')).toBeChecked();

  // The site answers under its path, sandboxed; with single-page app, any path without a file gets index.html.
  const home = await context.request.get(`${baseURL}/exclusivity-life/${name}/`);
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain('Built from');
  expect(home.headers()['content-security-policy']).toMatch(/^sandbox /);
  expect((await context.request.get(`${baseURL}/exclusivity-life/${name}/app/route`)).status()).toBe(200);

  // Deploy again: two deploys kept, the new one serving; roll back to the first, at once.
  await page.getByRole('button', { name: 'Manual deploy' }).click();
  await expect(card.locator('tbody tr')).toHaveCount(2, { timeout: 20_000 });
  const rollback = card.getByRole('button', { name: /^Roll back to / });
  await expect(rollback).toHaveCount(1);
  await rollback.click();
  await expect(card.locator('[data-site-note]')).toContainText('Rolled back', { timeout: 10_000 });
  await expect(page.locator('[data-recent] tbody tr').first()).toContainText('rollback', { timeout: 10_000 });

  // Single-page app off: saved at once, no deploy.
  await card.getByLabel('Single-page app').uncheck();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.locator('[data-site-note]')).toContainText('applies to the next request');
  expect((await context.request.get(`${baseURL}/exclusivity-life/${name}/app/route`)).status()).toBe(404);

  // Metrics are requests and bandwidth only; Scaling has nothing to scale; Settings name the publish directory.
  await page.getByRole('tab', { name: 'Metrics and logs' }).click();
  await expect(page.getByText('HTTP requests')).toBeVisible();
  await expect(page.locator('#panel-metrics').getByText('Instances', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#panel-settings')).toContainText('Publish directory');

  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(width).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('the dashboard shows a static site\'s bandwidth and cache hit rate', async ({ page, context, baseURL }) => {
  const problems = watch(page);
  await context.request.post(`${baseURL}/dev/login`, { form: { person: 'stevie' }, maxRedirects: 0 });
  await page.goto(WS);
  const card = page.locator('[data-card="storefront"]');
  await expect(card).toContainText('Static Site');
  await expect(card.getByRole('meter', { name: 'Bandwidth this month' })).toHaveAttribute('aria-valuetext', /of 100 GB$/);
  await expect(card.getByRole('meter', { name: 'Cache hit rate' })).toBeVisible();
  expect(problems).toEqual([]);
});
