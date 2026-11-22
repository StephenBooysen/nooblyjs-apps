// Roadmap 5.3, desktop and phone: create a Cron Job (the schedule previewed in words as it is typed), run it now, see
// the run and its log, change its schedule, and scale it by type only. The in-process agent (HERO_LOCAL_AGENT=mock)
// runs the job; test/jobs.test.js covers the scheduler and the numbers.
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

test('create a cron job, run it now, read its run, change its schedule, scale it by type', async ({ page, context, baseURL }, info) => {
  const res = await context.request.post(`${baseURL}/dev/login`, { form: { person: 'stevie' }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
  const problems = watch(page);

  await page.goto(`${WS}/new/cron`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'New Cron Job' })).toBeVisible();
  await page.locator('label.nj-repo', { hasText: 'software-factory' }).click();
  const summary = page.getByRole('complementary', { name: 'Summary' });

  // A schedule and a command, no start command and no count; the schedule reads back in words as it is typed.
  await expect(page.getByLabel('Start command')).toHaveCount(0);
  await expect(page.getByLabel('Instances')).toHaveCount(0);
  await expect(summary.locator('[data-sum="schedule"]')).toHaveText('Every day at 02:00 UTC');
  await expect(summary.getByText('0.5 CPU · 512 MB per run')).toBeVisible();
  const schedule = page.getByLabel('Schedule (UTC)');
  await schedule.fill('every day');
  await expect(page.locator('[data-schedule-preview]')).toContainText('A schedule has five fields; this has 2.');
  await schedule.fill('*/15 * * * *');
  await expect(page.locator('[data-schedule-preview]')).toContainText(/^Every 15 minutes · next \d\d:\d\d UTC|^Every 15 minutes · next \w{3} \d+ \w{3}, \d\d:\d\d UTC/);
  await expect(summary.locator('[data-sum="schedule"]')).toHaveText('Every 15 minutes');

  // The command is required: the API's message shows under it.
  const name = `cr-${info.project.name}-${Date.now().toString(36)}`;
  await page.getByLabel('Service name').fill(name);
  await summary.getByRole('button', { name: 'Create cron job' }).click();
  await expect(page.locator('.invalid-feedback[data-for="command"]')).not.toBeEmpty();
  await page.getByLabel('Command', { exact: true }).fill('node scripts/nightly.js');
  await summary.getByRole('button', { name: 'Create cron job' }).click();
  await expect(page).toHaveURL(new RegExp(`${WS}/services/${name}$`));

  // Its page: the schedule in words, the next runs, the command; Run now once the first deploy is live.
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.locator('[data-status] .nj-pill')).toHaveText('Live', { timeout: 15_000 });
  await expect(page.locator('[data-schedule-text]')).toHaveText('Every 15 minutes');
  await expect(page.locator('[data-schedule-command]')).toHaveText('node scripts/nightly.js');
  await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart' })).toHaveCount(0);
  await expect(page.getByText('No runs yet')).toBeVisible();
  const runNow = page.getByRole('button', { name: 'Run now' });
  await expect(runNow).toBeEnabled();
  await runNow.click();
  const runs = page.locator('[data-runs] tbody tr');
  await expect(runs).toHaveCount(1, { timeout: 15_000 });
  await expect(runs.first()).toContainText('Succeeded', { timeout: 15_000 });
  await expect(runs.first()).toContainText('Stevie');
  await expect(runs.first()).toContainText('of 512 MB');
  await expect(page.getByLabel(/^Run of .* log$/)).toContainText('Run started by hand.');

  // Change the schedule: a bad one says why under the field; a good one saves and reads back.
  await page.getByRole('button', { name: 'Change schedule or command' }).click();
  const form = page.locator('[data-schedule-form]');
  await form.getByLabel('Schedule (UTC)').fill('61 * * * *');
  await expect(form.locator('[data-sched-preview]')).toHaveText('The minute field goes from 0 to 59.');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.invalid-feedback[data-for="schedule"]')).toContainText('The minute field goes from 0 to 59.');
  await form.getByLabel('Schedule (UTC)').fill('30 9 * * 1-5');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
  await expect(page.locator('[data-schedule-note]')).toHaveText('Saved: Every weekday (Monday to Friday) at 09:30 UTC. It applies from the next run.');
  await expect(page.locator('[data-schedule-text]')).toHaveText('Every weekday (Monday to Friday) at 09:30 UTC');

  // Scaling is the instance type only.
  await page.getByRole('tab', { name: 'Scaling' }).click();
  await expect(page.getByRole('heading', { name: 'Instance type', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Instances' })).toHaveCount(0);
  await page.locator('[data-scale] label.nj-plan', { hasText: 'Standard' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('[data-scale-note]')).toHaveText('Saved: Standard. It applies from the next run.');

  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(width).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('the dashboard shows a cron job\'s last and next run', async ({ page, context, baseURL }) => {
  const problems = watch(page);
  await context.request.post(`${baseURL}/dev/login`, { form: { person: 'stevie' }, maxRedirects: 0 });
  await page.goto(WS);
  const card = page.locator('[data-card="etl"]');
  await expect(card).toContainText('Every day at 02:00 UTC');
  await expect(card).toContainText(/Last run\s+Succeeded/);
  await expect(card.locator('[data-next-run]')).toContainText(/^Next run in .* 02:00 UTC$/);
  expect(problems).toEqual([]);
});
