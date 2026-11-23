// Accessibility (roadmap 8.4): axe-core's WCAG 2.2 A and AA rules on every screen, desktop and phone, after it has
// drawn. A violation fails with the rule, the screen and the first element, so a new screen or a change that breaks
// contrast, names, labels, focus or targets is caught here. (axe finds about half of WCAG problems; keyboard paths and
// screen-reader wording are still checked by hand, see docs/accessibility.md.) Light and dark mode both; the operator
// screens are nooblyjs-core's and the accelerators', which have no dark mode.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const WS = '/w/exclusivity-life';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// Each test opens several screens and runs axe on each: more than the default 30 s on a slow machine.
test.describe.configure({ timeout: 120_000 });

async function signIn(context, baseURL, person) {
  const res = await context.request.post(`${baseURL}/dev/login`, { form: { person }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
}

/** Opens each screen, waits for its heading, runs axe; fails once with every violation found. */
async function audit(page, screens) {
  const found = [];
  for (const url of screens) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1, h2, form').first(), url).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => {});
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    for (const v of violations) found.push(`${url}: ${v.impact} ${v.id} (${v.help}) ×${v.nodes.length}, e.g. ${v.nodes[0]?.target?.join(' ')}`);
  }
  expect(found, found.join('\n')).toEqual([]);
}

for (const mode of ['light', 'dark']) {
  test.describe(`${mode} mode`, () => {
    // The device's setting: the app follows it while Appearance is System (public/js/theme.js).
    test.use({ colorScheme: mode });
    test('signed-out screens', async ({ page }) => {
      await audit(page, ['/', '/forgot-password', '/reset-password?token=x', '/verify-email?token=x', '/invite?token=x', '/services/authservice/views/login.html']);
    });

    test('workspace screens', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL, 'stevie');
      await audit(page, ['', '/new', '/projects', '/deploys', '/metrics', '/logs', '/env-groups', '/github', '/billing', '/settings'].map((p) => `${WS}${p}`));
    });

    test('create forms, one per service type', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL, 'stevie');
      await audit(page, ['static', 'web', 'private', 'worker', 'cron', 'workflow', 'postgres', 'keyvalue', 'sandbox'].map((t) => `${WS}/new/${t}`));
    });

    test('a service page of each type in the workspace', async ({ page, context, baseURL }) => {
      await signIn(context, baseURL, 'stevie');
      const { services } = await (await context.request.get(`${baseURL}/api/v1/workspaces/exclusivity-life/services`)).json();
      const byType = new Map();
      for (const s of services) if (!byType.has(s.type)) byType.set(s.type, s.name);
      expect([...byType.keys()].length, 'the seed has several types').toBeGreaterThanOrEqual(5);
      await audit(page, [...byType.values()].map((name) => `${WS}/services/${name}`));
    });
  });
}

test('operator screens (back office, payments, infrastructure)', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'ops-platform');
  await audit(page, ['/admin', '/admin/payments/', '/infrastructure', '/infrastructure/platform']);
});

test('on a phone every control is at least 44 px (stack.md §5), except a link inside a sentence', async ({ page, context, baseURL }, info) => {
  test.skip(info.project.name !== 'phone', 'touch targets are a phone check');
  await signIn(context, baseURL, 'stevie');
  const small = [];
  for (const url of ['/', ...['', '/new', '/deploys', '/metrics', '/logs', '/env-groups', '/github', '/billing', '/settings', '/new/web', '/new/cron', '/services/api', '/services/etl'].map((p) => `${WS}${p}`)]) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1').first(), url).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => {});
    const found = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], summary')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden' || el.matches('.visually-hidden-focusable:not(:focus)')) continue;
        const parent = el.parentElement;
        const inSentence = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && parent && parent.textContent.trim() !== el.textContent.trim();
        if (inSentence) continue;
        const label = ['checkbox', 'radio'].includes(el.type) ? (el.closest('label') ?? document.querySelector(`label[for="${el.id}"]`)) : null;
        const box = label ? label.getBoundingClientRect() : r;
        if (box.height < 43.5 || box.width < 43.5) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 30)}" ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
      return out;
    });
    for (const f of found) small.push(`${url}: ${f}`);
  }
  expect(small, small.join('\n')).toEqual([]);
});

test('Appearance: System follows the device; Light or Dark stays, after a reload too; the log viewer is dark in both', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'stevie');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${WS}/settings`);
  const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-bs-theme'));
  await expect(page.getByRole('radio', { name: 'System' })).toBeChecked();
  expect(await theme()).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(theme).toBe('light');

  await page.getByText('Dark', { exact: true }).click();
  expect(await theme()).toBe('dark');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
  expect(await theme()).toBe('dark', 'kept, whatever the device says');

  const bg = () => page.locator('.nj-logs').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.goto(`${WS}/services/api`);
  await expect(page.locator('.nj-logs').first()).toBeVisible();
  const darkLogs = await bg();
  await page.goto(`${WS}/settings`);
  await page.getByText('Light', { exact: true }).click();
  await page.goto(`${WS}/services/api`);
  await expect(page.locator('.nj-logs').first()).toBeVisible();
  for (const c of [darkLogs, await bg()]) {
    const [r, g, b] = c.match(/\d+/g).map(Number);
    expect(r + g + b, `log viewer ${c} is dark`).toBeLessThan(150);
  }
  await page.goto(`${WS}/settings`);
  await page.getByText('System', { exact: true }).click();
});
