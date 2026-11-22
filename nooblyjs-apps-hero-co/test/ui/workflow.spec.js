// Roadmap 5.4, desktop and phone: create a Workflow (task rows, runs at once), run a task with JSON input, read the
// run and its log, change the tasks, make a trigger key, and see the meters on the dashboard. The in-process agent
// (HERO_LOCAL_AGENT=mock) runs the tasks; test/tasks.test.js covers the queue, retries and the key.
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

test('create a workflow, run a task with input, read its run, change the tasks, make a trigger key', async ({ page, context, baseURL }, info) => {
  const res = await context.request.post(`${baseURL}/dev/login`, { form: { person: 'stevie' }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
  const problems = watch(page);

  await page.goto(`${WS}/new/workflow`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'New Workflow' })).toBeVisible();
  await page.locator('label.nj-repo', { hasText: 'software-factory' }).click();
  const summary = page.getByRole('complementary', { name: 'Summary' });

  // Task rows and runs at once; no start command and no count.
  await expect(page.getByLabel('Start command')).toHaveCount(0);
  await expect(page.getByLabel('Instances')).toHaveCount(0);
  await expect(summary.getByText('0.5 CPU · 512 MB per run, up to 2 at once')).toBeVisible();
  const name = `wf-${info.project.name}-${Date.now().toString(36)}`;
  await page.getByLabel('Service name').fill(name);

  // An empty task list is refused under the tasks; a bad name under its field.
  await summary.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page.locator('.invalid-feedback[data-for="tasks"]')).toContainText('From 1 to 20 tasks');
  await page.getByLabel('Task 1 name').fill('Send Email');
  await page.getByLabel('Task 1 command').fill('node tasks/send-email.js');
  await summary.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page.locator('.invalid-feedback[data-for="tasks.0.name"]')).toContainText('Lower-case letters');
  await page.getByLabel('Task 1 name').fill('send-email');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByLabel('Task 2 name').fill('resize');
  await page.getByLabel('Task 2 command').fill('node tasks/resize.js');
  await page.getByLabel('Runs at once').fill('3');
  await expect(summary.locator('[data-sum="tasks"]')).toHaveText('send-email, resize');
  await expect(summary.getByText('up to 3 at once')).toBeVisible();
  await summary.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page).toHaveURL(new RegExp(`${WS}/services/${name}$`));

  // Its page: tasks with Run, the meters, no Restart, Logs as the second tab.
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.locator('[data-status] .nj-pill')).toHaveText('Live', { timeout: 15_000 });
  await expect(page.locator('[data-lead]')).toContainText('up to 3 at once');
  await expect(page.getByRole('button', { name: 'Restart' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible();
  await expect(page.getByRole('meter', { name: 'Tasks running' })).toHaveAttribute('aria-valuetext', '0 of 3 at once');
  await expect(page.getByText('No task runs yet')).toBeVisible();

  // Run a task: input that is not JSON is caught here; good input queues the run, which succeeds.
  await page.locator('[data-tasks-card] tr', { hasText: 'send-email' }).getByRole('button', { name: 'Run' }).click();
  const runForm = page.locator('[data-run-form]');
  await expect(runForm.getByRole('heading', { name: 'Run send-email' })).toBeVisible();
  await runForm.getByLabel(/^Input/).fill('{to: ada}');
  await runForm.getByRole('button', { name: 'Queue run' }).click();
  await expect(runForm.locator('.invalid-feedback[data-for="input"]')).toHaveText('Input is JSON, such as {"orderId": 42}.');
  await runForm.getByLabel(/^Input/).fill('{"to": "ada@example.com"}');
  await runForm.getByRole('button', { name: 'Queue run' }).click();
  await expect(runForm).toBeHidden();
  const runs = page.locator('[data-task-runs] tbody tr');
  await expect(runs).toHaveCount(1, { timeout: 15_000 });
  await expect(runs.first()).toContainText('Succeeded', { timeout: 15_000 });
  await expect(runs.first()).toContainText('1 of 3');
  await expect(runs.first()).toContainText('Stevie');
  await expect(runs.first()).toContainText('of 512 MB');
  await expect(page.locator('[data-task-out]')).toContainText('Exited with code 0', { timeout: 15_000 });
  await expect(page.locator('[data-last-task]')).toContainText('send-email succeeded');

  // Change the tasks and runs at once: a bad value says why under its field; a good one saves.
  await page.getByRole('button', { name: 'Change tasks or runs at once' }).click();
  const form = page.locator('[data-tasks-form]');
  await form.getByLabel('Runs at once').fill('11');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.invalid-feedback[data-for="concurrency"]')).toContainText('From 1 to 10');
  await form.getByLabel('Runs at once').fill('1');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-tasks-note]')).toHaveText('Saved: 2 tasks, up to 1 at once. It applies from the next run.');
  await expect(page.locator('[data-lead]')).toContainText('up to 1 at once');
  // The card is drawn again on Save: Run still works.
  await page.locator('[data-tasks-card] tr', { hasText: 'resize' }).getByRole('button', { name: 'Run' }).click();
  await runForm.getByRole('button', { name: 'Queue run' }).click();
  await expect(runs).toHaveCount(2, { timeout: 15_000 });
  await expect(runs.first()).toContainText('resize');
  await expect(runs.first()).toContainText('Succeeded', { timeout: 15_000 });

  // A trigger key: shown once, then only its last four characters.
  const trigger = page.locator('[data-trigger]');
  await expect(trigger).toContainText(`/api/v1/tasks/exclusivity-life/${name}/send-email/runs`);
  await expect(trigger).toContainText('No key yet');
  await trigger.getByRole('button', { name: 'Create key' }).click();
  const key = await page.locator('[data-fresh-key]').textContent();
  expect(key).toMatch(/^ntk_[A-Za-z0-9_-]{43}$/);
  await expect(page.locator('[data-trigger]')).toContainText(`Key ending ${key.slice(-4)}, made by Stevie`);
  const api = await context.request.post(`${baseURL}/api/v1/tasks/exclusivity-life/${name}/resize/runs`, { headers: { authorization: `Bearer ${key}` }, data: { input: { w: 100 } } });
  expect(api.status()).toBe(202);
  await expect(runs.first()).toContainText('resize', { timeout: 15_000 });
  await expect(runs.first()).toContainText('API');

  // Scaling is the instance type only.
  await page.getByRole('tab', { name: 'Scaling' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Instances' })).toHaveCount(0);
  await expect(page.getByText('How many run at once is set with the tasks')).toBeVisible();

  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(width).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('the dashboard shows a workflow\'s tasks running and queue', async ({ page, context, baseURL }) => {
  const problems = watch(page);
  await context.request.post(`${baseURL}/dev/login`, { form: { person: 'stevie' }, maxRedirects: 0 });
  await page.goto(WS);
  const card = page.locator('[data-card="orders"]');
  await expect(card).toContainText('Workflow · 3 tasks');
  await expect(card.getByRole('meter', { name: 'Tasks running' })).toHaveAttribute('aria-valuetext', /^0 of 4 at once$/);
  await expect(card.getByRole('meter', { name: 'Queue' })).toHaveAttribute('aria-valuetext', /waiting of 1,000$/);
  expect(problems).toEqual([]);
});
