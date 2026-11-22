// A Workflow's pieces (roadmap 5.4), shared by the create form and the service page: the task rows (name, command,
// retries) and the runs-at-once field, the tasks table with Run, the task runs table, and how code triggers a task.
import { html } from '../html.js';
import { statusPill, emptyState } from '../components/index.js';
import { WORKFLOW, TASK_ENV } from '../shared/catalog.js';
import { memoryText, msText, ago, until } from '../format.js';
import { statusWord, taskMeters } from './watch.js';

const feedback = (name) => html`<div class="invalid-feedback" id="${name}-error" data-for="${name}"></div>`;
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const thousands = (n) => n.toLocaleString('en');

/** One task's row: name, command, retries, and a button that removes it. */
export function taskRow(i, { name = '', command = '', retries = WORKFLOW.defaults.retries } = {}) {
  return html`<div class="nj-task-row" data-task-row>
    <label class="visually-hidden" for="task-${i}-name">Task ${i + 1} name</label>
    <input class="form-control nj-mono" id="task-${i}-name" name="tasks.${i}.name" value="${name}" placeholder="send-receipt" maxlength="63" autocomplete="off" spellcheck="false" aria-describedby="tasks.${i}.name-error">
    <label class="visually-hidden" for="task-${i}-command">Task ${i + 1} command</label>
    <input class="form-control nj-mono" id="task-${i}-command" name="tasks.${i}.command" value="${command}" placeholder="node tasks/send-receipt.js" autocomplete="off" spellcheck="false" aria-describedby="tasks.${i}.command-error">
    <label class="visually-hidden" for="task-${i}-retries">Task ${i + 1} retries</label>
    <input class="form-control nj-num" id="task-${i}-retries" name="tasks.${i}.retries" type="number" min="0" max="${WORKFLOW.maxRetries}" value="${retries}" aria-describedby="tasks.${i}.retries-error">
    <button type="button" class="btn btn-secondary nj-task-remove" data-task-remove aria-label="Remove task ${i + 1}"><i class="bi bi-trash3" aria-hidden="true"></i></button>
    ${feedback(`tasks.${i}.name`)}${feedback(`tasks.${i}.command`)}${feedback(`tasks.${i}.retries`)}
  </div>`;
}

/** The tasks and how many run at once, as fields (the create form's Build and run; the service page's editor). */
export function tasksEditor({ tasks, concurrency, id = 'f' }) {
  return html`<div class="nj-stack-gap" data-tasks-editor>
    <div class="nj-task-head" aria-hidden="true"><span>Task name</span><span>Command</span><span>Retries</span><span></span></div>
    <div class="nj-tasks" data-tasks>${tasks.map((t, i) => taskRow(i, t))}</div>${feedback('tasks')}
    <div><button type="button" class="btn btn-secondary btn-sm" data-task-add><i class="bi bi-plus-lg" aria-hidden="true"></i> Add task</button></div>
    <p class="form-text mt-0 mb-0">Each task is a command in the built image. A run that exits with 0 succeeded; one that fails is tried again up to its retries, waiting ${WORKFLOW.backoffS} s, then twice as long each time.</p>
    <div class="nj-instances">
      <label class="form-label mb-0" for="${id}-concurrency">Runs at once</label>
      <input class="form-control nj-num" id="${id}-concurrency" name="concurrency" type="number" value="${concurrency}" min="1" max="${WORKFLOW.maxConcurrency}" aria-describedby="${id}-concurrency-hint concurrency-error">
      <span class="form-text mt-0" id="${id}-concurrency-hint">1 to ${WORKFLOW.maxConcurrency}. More runs wait in the queue (up to ${thousands(WORKFLOW.queue)}) and start as others end.</span>
    </div>${feedback('concurrency')}
  </div>`;
}

/**
 * Add and remove task rows. → read(): the rows as the API takes them, each row's fields renamed in order first so an
 * error's path (tasks.N.name) finds its field.
 */
export function bindTasksEditor(root) {
  const box = root.querySelector('[data-tasks]');
  let count = box.querySelectorAll('[data-task-row]').length;
  root.querySelector('[data-task-add]').addEventListener('click', () => {
    if (box.querySelectorAll('[data-task-row]').length >= WORKFLOW.maxTasks) return;
    box.insertAdjacentHTML('beforeend', String(taskRow(count)));
    count += 1;
    box.lastElementChild.querySelector('input').focus();
  });
  box.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-task-remove]');
    if (remove && box.querySelectorAll('[data-task-row]').length > 1) remove.closest('[data-task-row]').remove();
  });
  return {
    read() {
      return [...box.querySelectorAll('[data-task-row]')].map((row, i) => {
        const inputs = row.querySelectorAll('input');
        const feedbacks = row.querySelectorAll('.invalid-feedback');
        ['name', 'command', 'retries'].forEach((k, j) => {
          inputs[j].name = `tasks.${i}.${k}`;
          inputs[j].setAttribute('aria-describedby', `tasks.${i}.${k}-error`);
          feedbacks[j].dataset.for = `tasks.${i}.${k}`;
          feedbacks[j].id = `tasks.${i}.${k}-error`;
        });
        const [name, command, retries] = [...inputs].map((el) => el.value.trim());
        return { name, command, retries: retries === '' ? undefined : Number(retries) };
      }).filter((t) => t.name || t.command);
    },
    concurrency: () => Number(root.querySelector('input[name="concurrency"]').value),
  };
}

/** The tasks, each with Run, and the meters: running against the concurrency, waiting against the queue. */
export function tasksCard(svc, facts) {
  const tasks = svc.tasks ?? [];
  return html`<section class="nj-card mb-4" aria-labelledby="tasks-title">
    <div class="nj-section-head"><h2 class="nj-card-title mb-0" id="tasks-title">Tasks</h2>
      <button type="button" class="btn btn-link p-0" data-tasks-edit aria-expanded="false" aria-controls="tasks-form">Change tasks or runs at once</button></div>
    <div class="nj-task-meters" data-task-meters>${taskMeters(facts)}</div>
    ${tasks.length ? html`<div class="table-responsive"><table class="table mb-0">
      <caption class="visually-hidden">Tasks</caption>
      <thead><tr><th scope="col">Task</th><th scope="col">Command</th><th scope="col">Retries</th><th scope="col"><span class="visually-hidden">Run</span></th></tr></thead>
      <tbody>${tasks.map((t) => html`<tr>
        <td class="nj-mono">${t.name}</td><td><code>${t.command}</code></td><td class="nj-num">${t.retries}</td>
        <td class="text-end"><button type="button" class="btn btn-secondary btn-sm" data-task-run="${t.name}"${svc.status === 'suspended' ? ' aria-describedby="tasks-suspended"' : ''}><i class="bi bi-play-fill" aria-hidden="true"></i> Run</button></td>
      </tr>`)}</tbody></table></div>` : html`<p class="nj-meta mb-0">No tasks. Add one with Change tasks.</p>`}
    ${svc.status === 'suspended' ? html`<p class="nj-meta mt-2 mb-0" id="tasks-suspended">Suspended: runs you queue wait until you resume it.</p>` : ''}
    <form class="nj-stack-gap mt-3" data-run-form novalidate hidden aria-labelledby="run-form-title">
      <h3 class="nj-card-title mb-0" id="run-form-title">Run <span class="nj-mono" data-run-task></span></h3>
      <div><label class="form-label" for="run-input">Input <span class="nj-meta">· optional JSON, up to ${WORKFLOW.inputKb} KB</span></label>
        <textarea class="form-control nj-mono" id="run-input" name="input" rows="4" spellcheck="false" placeholder='{"orderId": 42}' aria-describedby="run-input-hint input-error"></textarea>
        <div class="form-text" id="run-input-hint">The run reads it from TASK_INPUT, as JSON text.</div>${feedback('input')}</div>
      <div class="d-flex flex-wrap gap-2"><button type="submit" class="btn btn-primary">Queue run</button><button type="button" class="btn btn-secondary" data-run-cancel>Cancel</button></div>
    </form>
    <form id="tasks-form" class="nj-stack-gap mt-3" data-tasks-form novalidate hidden>
      ${tasksEditor({ tasks: tasks.length ? tasks : [{}], concurrency: svc.concurrency, id: 'edit' })}
      <div class="alert alert-danger mb-0" role="alert" tabindex="-1" data-form-alert hidden></div>
      <div class="d-flex flex-wrap gap-2"><button type="submit" class="btn btn-primary">Save</button><button type="button" class="btn btn-secondary" data-tasks-cancel>Cancel</button></div>
      <p class="nj-meta mb-0">Changes apply from the next run, with no rebuild. A waiting run of a task you remove fails when its turn comes.</p>
    </form>
    <p class="nj-meta mt-2 mb-0" role="status" aria-live="polite" data-tasks-note></p>
  </section>`;
}

/** "Attempt 2 of 3" */
const attemptText = (r) => (r.attempt ? `${r.attempt} of ${r.maxAttempts}` : `0 of ${r.maxAttempts}`);

/** A Workflow's task runs, newest first, each with its log (and Cancel while it waits). */
export function taskRunsTable(runs, limitMb) {
  if (!runs.length) return emptyState({ icon: 'diagram-3', title: 'No task runs yet', text: 'Run a task above, or trigger one from your code. Each run shows here with its result, its attempts and its peak memory.' });
  return html`<div class="table-responsive"><table class="table mb-0">
    <caption class="visually-hidden">Task runs, newest first</caption>
    <thead><tr><th scope="col">Queued</th><th scope="col">Task</th><th scope="col">Status</th><th scope="col">Attempt</th><th scope="col">Started by</th><th scope="col">Took</th><th scope="col">Exit code</th><th scope="col">Peak memory</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
    <tbody>${runs.map((r) => {
      const waiting = ['queued', 'retrying'].includes(r.status);
      const note = r.status === 'retrying' && r.nextAttemptAt ? `Tries again ${until(r.nextAttemptAt)}: ${r.reason ?? ''}` : r.status === 'failed' || r.status === 'cancelled' ? r.reason : null;
      return html`<tr>
        <td class="nj-num">${when(r.createdAt)}</td>
        <td class="nj-mono">${r.task}</td>
        <td>${statusPill(statusWord(r.status))}${note ? html`<div class="nj-meta">${note}</div>` : ''}</td>
        <td class="nj-num">${attemptText(r)}</td>
        <td>${r.by ?? '—'}</td>
        <td class="nj-num">${r.status === 'running' ? 'running' : waiting ? 'waiting' : msText(r.durationMs)}</td>
        <td class="nj-num">${r.exitCode ?? '—'}</td>
        <td class="nj-num">${r.peakMemoryMb === null || r.peakMemoryMb === undefined ? '—' : `${memoryText(r.peakMemoryMb)} of ${memoryText(limitMb)}`}</td>
        <td class="text-nowrap">${r.attempt ? html`<button type="button" class="btn btn-link btn-sm p-0" data-task-log="${r.id}" aria-label="Show the log of the ${r.task} run queued ${when(r.createdAt)}">Log</button>` : ''}
          ${waiting ? html`<button type="button" class="btn btn-link btn-sm p-0 ms-2" data-task-cancel="${r.id}" aria-label="Cancel the ${r.task} run queued ${when(r.createdAt)}">Cancel</button>` : ''}</td>
      </tr>`;
    })}</tbody>
  </table></div>`;
}

/** How code starts a task: the URL, the key (made here, shown once), and what each run gets. */
export function triggerCard(trigger, { task = 'send-receipt', fresh = null } = {}) {
  const url = trigger.url.replace(':task', task);
  const key = trigger.key;
  return html`<section class="nj-card mb-4" aria-labelledby="trigger-title" data-trigger>
    <h2 class="nj-card-title" id="trigger-title">Trigger from code</h2>
    <p>Your services start a task with a POST to its URL, with the workflow's key as a bearer token. The input is any JSON up to ${WORKFLOW.inputKb} KB. The answer names the run; a GET of <code>…/runs/&lt;run id&gt;</code> with the same key says how it went.</p>
    <pre class="nj-code" tabindex="0" aria-label="Example request"><code>curl -X POST ${url} \\
  -H "Authorization: Bearer $NOOBLY_TRIGGER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"input": {"orderId": 42}}'</code></pre>
    <p class="nj-meta">Each run gets ${TASK_ENV.map((k, i) => html`${i ? (i === TASK_ENV.length - 1 ? ' and ' : ', ') : ''}<code>${k}</code>`)} besides the service's own variables.</p>
    ${fresh ? html`<div class="alert alert-warning" role="status"><strong>Copy the key now: it is not shown again.</strong> Put it in an environment variable of the services that start tasks.
      <div class="mt-2"><code class="nj-key" data-fresh-key>${fresh}</code></div></div>` : ''}
    <div class="d-flex flex-wrap align-items-center gap-2">
      <span class="nj-meta">${key ? `Key ending ${key.hint}, made by ${key.createdBy?.name ?? 'someone'} ${ago(key.createdAt)}.` : 'No key yet: nothing can start a task from code.'}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-key-create>${key ? 'Replace key' : 'Create key'}</button>
      ${key ? html`<button type="button" class="btn btn-link btn-sm" data-key-remove>Remove key</button>` : ''}
    </div>
    <p class="nj-meta mt-2 mb-0" role="status" aria-live="polite" data-key-note></p>
  </section>`;
}
