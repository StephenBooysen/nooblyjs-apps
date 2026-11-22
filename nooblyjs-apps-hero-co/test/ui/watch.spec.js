// Phase 4, desktop and phone: the watch screens draw and respond with no CSP violation or script error. The seed's
// services are in a cloud region on the mock cloud, so their resource charts say why they are empty; the API tests
// (test/watch.test.js) cover the numbers of a Local network service.
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

async function signIn(context, baseURL, person = 'stevie') {
  const res = await context.request.post(`${baseURL}/dev/login`, { form: { person }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
}

test('the dashboard: stat tiles, CPU allocated, service cards that filter, recent deploys', async ({ page, context, baseURL }) => {
  const problems = watch(page);
  await signIn(context, baseURL);
  await page.goto(WS);
  await expect(page.getByText('Services running')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'CPU allocated by service' })).toBeVisible();
  await expect(page.locator('.nj-stack .nj-stack-seg').first()).toBeVisible();
  await expect(page.locator('[data-card]')).not.toHaveCount(0);
  await page.getByLabel('Filter services').fill('storefront');
  await expect(page.locator('[data-card]:visible')).toHaveCount(1);
  await expect(page.locator('[data-card="storefront"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent deploys' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('a service\'s tabs: by click, by arrow keys and by deep link; Metrics and logs; Scaling checks the count', async ({ page, context, baseURL }) => {
  const problems = watch(page);
  await signIn(context, baseURL);
  await page.goto(`${WS}/services/api`);
  const tabs = page.getByRole('tablist');
  await expect(tabs.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');

  await tabs.getByRole('tab', { name: 'Metrics and logs' }).click();
  await expect(page).toHaveURL(/\?tab=metrics$/);
  await expect(page.getByRole('heading', { name: 'Resources' })).toBeVisible();
  await expect(page.getByText(/arrive with cloud monitoring/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Instances' })).toBeVisible();
  await expect(page.locator('[data-logs]')).toBeVisible();
  await page.getByRole('button', { name: 'Warnings' }).click();
  await expect(page.getByRole('button', { name: 'Warnings' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '24h' }).click();
  await expect(page.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'true');

  // Arrow keys move along the tabs.
  await tabs.getByRole('tab', { name: 'Metrics and logs' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Deploys' })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab', { name: 'Deploys' })).toBeFocused();
  await expect(page.getByLabel('Build and rollout log of')).toBeVisible();

  // A deep link opens its tab; the Scaling form refuses a count out of range before it asks the server.
  await page.goto(`${WS}/services/api?tab=scaling`);
  await expect(page.getByRole('heading', { name: 'Instance type and count' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Instances' }).fill('11');
  await page.getByRole('button', { name: 'Save and roll out' }).click();
  await expect(page.getByText('Choose 1 to 10 instances.')).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Instances' })).toHaveClass(/is-invalid/);
  expect(problems).toEqual([]);
});

test('the workspace Deploys, Metrics and Logs pages filter', async ({ page, context, baseURL }) => {
  const problems = watch(page);
  await signIn(context, baseURL);
  await page.goto(`${WS}/deploys`);
  await page.getByLabel('Service').selectOption('api');
  await expect(page.locator('[data-deploys] tbody tr').first()).toContainText('api');

  await page.goto(`${WS}/metrics`);
  await page.getByRole('button', { name: '7d' }).click();
  await expect(page).toHaveURL(/\?range=7d$/);
  await expect(page.getByRole('heading', { name: 'api' })).toBeVisible();

  await page.goto(`${WS}/logs`);
  await expect(page.getByRole('heading', { name: 'Logs', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Errors' }).click();
  await expect(page.getByRole('button', { name: 'Errors' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Paused')).toBeVisible();
  expect(problems).toEqual([]);
});
