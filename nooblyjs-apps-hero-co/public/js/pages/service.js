// A service (roadmap 2.7, 3.8, 4.5–4.7; product.md §6.5): the header with its status, URL and plan, the Manual
// deploy, Restart and Suspend (or Resume) buttons, and tabs (?tab=):
//
//   Overview          the latest deploy's steps and its build and rollout log, the recent deploys
//   Metrics and logs  Resources (CPU, memory, requests, bandwidth over 1h, 24h, 7d or 30d), Instances, Logs
//   Deploys           every deploy, and any one's build log
//   Environment       the variables (keys only, with an audited reveal) and the linked groups
//   Scaling           the instance type and count (services.platform.workloads.scale)
//   Settings          where it comes from and how it builds
//
// A Cron Job (roadmap 5.3) has Run now instead of Restart; its Overview starts with its schedule (in words, the next
// runs, a form to change it) and its runs (each with its log); its second tab is its Logs; it scales by type only.
// A Workflow (roadmap 5.4) has no Restart either; its Overview starts with its tasks (each with Run, the meters, a form
// to change them), its task runs (each attempt's log, Cancel while waiting) and how code triggers a task; its second
// tab is its Logs; it scales by type only.
//
// Deploy changes, metrics, runs and log lines arrive over the live channel and redraw the parts they touch.
import { html } from '../html.js';
import { api } from '../api.js';
import { showErrors } from '../forms.js';
import { on } from '../sse.js';
import { applySizes } from '../charts.js';
import { statusPill, emptyState } from '../components/index.js';
import { SLEEP, PLANS, MAX_INSTANCES, CREATABLE, planOf, specText, priceText, estimate } from '../shared/catalog.js';
import { parseCron, describeCron, nextRuns } from '../shared/cron.js';
import { until, utcText } from '../format.js';
import { statusWord, resourceCards, instanceTiles, logsPanel, mountLogs, retentionText, deploysTable, runsTable, segmented, selectSegment, throttle, RANGES, taskMeters } from './watch.js';
import { tasksCard, taskRunsTable, triggerCard, bindTasksEditor } from './tasks.js';

export { statusWord };
const STEPS = ['Clone', 'Build', 'Roll out'];
const TYPE_NAME = { postgres: 'Postgres', keyvalue: 'Key Value', cron: 'Cron Job', workflow: 'Workflow' };
/** Types that run when asked, not all the time: their second tab is their run output, not live resources. */
const RUNS_ONLY = new Set(['cron', 'workflow']);
const TABS = [['overview', 'Overview'], ['metrics', 'Metrics and logs'], ['deploys', 'Deploys'], ['environment', 'Environment'], ['scaling', 'Scaling'], ['settings', 'Settings']];
/** A Cron Job's or Workflow's tabs: the second one is its run output, not live resources (nothing runs between runs). */
const tabsFor = (svc) => (RUNS_ONLY.has(svc.type) ? TABS.map(([k, label]) => [k, k === 'metrics' ? 'Logs' : label]) : TABS);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const short = (sha) => (sha ? sha.slice(0, 7) : '—');
const running = (d) => d && ['queued', 'building', 'deploying'].includes(d.status);

function progress(d) {
  if (!d) return '';
  const of = d.of ?? STEPS.length;
  const step = d.status === 'live' || d.status === 'superseded' ? of : Math.min(d.step ?? 0, of);
  const pct = Math.round((step / of) * 100);
  const label = d.status === 'failed' ? `Failed at step ${Math.max(1, step)} of ${of}` : d.status === 'live' ? `Live · ${of} of ${of} steps` : `Step ${step} of ${of}`;
  return html`<div class="nj-meter-row">
    <div class="nj-meter-head"><span>${label}</span><span class="nj-num">${pct}%</span></div>
    <div class="nj-meter nj-meter-${d.status === 'failed' ? 'failed' : 'requests'}" role="progressbar" aria-label="Deploy progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="${label}">
      <div class="nj-meter-fill" data-pct="${pct}"></div>
    </div>
    <ol class="nj-deploy-steps">${STEPS.map((s, i) => html`<li class="${i < step ? 'is-done' : i === step && d.status !== 'failed' ? 'is-now' : ''}">${s}</li>`)}</ol>
  </div>`;
}

function deployCard(d) {
  if (!d) return emptyState({ icon: 'rocket-takeoff', title: 'No deploys yet' });
  return html`<div class="d-flex flex-wrap justify-content-between gap-2 mb-3">
      <div><strong class="nj-mono">${short(d.commit)}</strong> ${d.message ?? ''}
        <div class="nj-meta">${d.trigger === 'manual' ? 'Started by' : d.trigger === 'config' ? 'Settings changed by' : 'Triggered by'} ${d.by?.name ?? 'a push'} · ${when(d.startedAt)}</div></div>
      ${statusPill(statusWord(d.status))}
    </div>
    ${progress(d)}
    ${d.status === 'failed' && d.reason ? html`<div class="alert alert-danger mt-3 mb-0" role="alert">${d.reason}</div>` : ''}`;
}

function buildLog(lines, live, label = 'Build and rollout', empty = 'Waiting for the build to start…') {
  return html`<section class="nj-logs" aria-label="${label} log">
    <div class="nj-logs-bar"><span class="nj-pill ${live ? 'nj-pill-live' : 'nj-pill-idle'}">${live ? 'Live' : 'Finished'}</span><span class="nj-meta">${label}</span></div>
    <div class="nj-logs-body" role="log" aria-live="polite">${lines.length
      ? lines.map((l) => html`<div class="nj-log-line nj-log-line-build"><span class="nj-log-time">${time(l.at)}</span><span class="nj-log-level nj-log-${(l.level ?? 'info').toLowerCase()}">${(l.level ?? 'info').toUpperCase()}</span><span>${l.text}</span></div>`)
      : html`<div class="nj-logs-empty">${empty}</div>`}</div>
  </section>`;
}

/** The buttons a service has (roadmap 3.8): data stores have none; a static site has nothing running to restart. */
function actions(svc) {
  if (['postgres', 'keyvalue'].includes(svc.type)) return '';
  const suspended = svc.status === 'suspended';
  if (svc.type === 'cron') {
    return html`<div class="nj-actions" role="group" aria-label="Cron job actions">
      ${suspended ? html`<button type="button" class="btn btn-secondary" data-action="resume">Resume</button>` : html`<button type="button" class="btn btn-secondary" data-action="suspend">Suspend</button>`}
      <button type="button" class="btn btn-secondary" data-action="deploys"${suspended ? ' disabled' : ''}><i class="bi bi-arrow-repeat" aria-hidden="true"></i> Manual deploy</button>
      <button type="button" class="btn btn-primary" data-action="runs"${suspended || !svc.current ? ' disabled' : ''}><i class="bi bi-play-fill" aria-hidden="true"></i> Run now</button>
    </div>`;
  }
  if (svc.type === 'workflow') {
    return html`<div class="nj-actions" role="group" aria-label="Workflow actions">
      ${suspended ? html`<button type="button" class="btn btn-secondary" data-action="resume">Resume</button>` : html`<button type="button" class="btn btn-secondary" data-action="suspend">Suspend</button>`}
      <button type="button" class="btn btn-primary" data-action="deploys"${suspended ? ' disabled' : ''}><i class="bi bi-arrow-repeat" aria-hidden="true"></i> Manual deploy</button>
    </div>`;
  }
  return html`<div class="nj-actions" role="group" aria-label="Service actions">
    ${svc.type === 'static' ? '' : html`<button type="button" class="btn btn-secondary" data-action="restart"${suspended ? ' disabled' : ''}>Restart</button>`}
    ${suspended ? html`<button type="button" class="btn btn-secondary" data-action="resume">Resume</button>` : html`<button type="button" class="btn btn-secondary" data-action="suspend">Suspend</button>`}
    <button type="button" class="btn btn-primary" data-action="deploys"${suspended ? ' disabled' : ''}><i class="bi bi-arrow-repeat" aria-hidden="true"></i> Manual deploy</button>
  </div>`;
}

/** What the status means, when it needs saying. */
function statusNote(svc) {
  if (svc.status === 'sleeping') return html`<div class="alert alert-info mb-4" role="status"><strong>Sleeping.</strong> It had no requests for ${SLEEP.afterMinutes} minutes, so it stopped. The next request wakes it: ${SLEEP.wakeText}</div>`;
  if (svc.status === 'suspended' && svc.type === 'workflow') return html`<div class="alert alert-warning mb-4" role="status"><strong>Suspended.</strong> No task starts and nothing deploys, not even on a push, until you resume it. Runs you queue wait; runs going finish.</div>`;
  if (svc.status === 'suspended' && svc.type === 'cron') return html`<div class="alert alert-warning mb-4" role="status"><strong>Suspended.</strong> The schedule fires nothing and nothing deploys, not even on a push, until you resume it.</div>`;
  if (svc.status === 'suspended') return html`<div class="alert alert-warning mb-4" role="status"><strong>Suspended.</strong> Nothing is running and nothing deploys, not even on a push, until you resume it.</div>`;
  return '';
}

/** The next runs: the first with how long until it, then the times (UTC, as the schedule is). */
const nextText = (list) => (list.length ? list.map((iso, i) => (i === 0 ? `${utcText(iso)} (${until(iso)})` : utcText(iso))).join(' · ') : 'None within a year.');

/** The schedule as typed, in words with the next run, or what is wrong with it. */
function schedulePreview(value) {
  const parsed = parseCron(value);
  if (parsed.error) return parsed.error;
  const [next] = nextRuns(parsed, new Date(), 1);
  return `${describeCron(parsed)} · next ${next ? `${utcText(next.toISOString())} (${until(next.toISOString())})` : 'not within a year'}`;
}

/** A Cron Job's schedule (roadmap 5.3): in words, its next runs, its command, and a form to change them. */
function scheduleCard(svc) {
  const suspended = svc.status === 'suspended';
  return html`<section class="nj-card mb-4" aria-labelledby="schedule-title">
    <div class="nj-section-head"><h2 class="nj-card-title mb-0" id="schedule-title">Schedule</h2>
      <button type="button" class="btn btn-link p-0" data-schedule-edit aria-expanded="false" aria-controls="schedule-form">Change schedule or command</button></div>
    <p class="mb-2"><strong data-schedule-text>${svc.scheduleText || 'No schedule'}</strong> <code class="ms-1" data-schedule-expr>${svc.schedule ?? ''}</code></p>
    <dl class="nj-help mb-0">
      <div><dt>Next runs</dt><dd data-schedule-next>${suspended ? 'None while it is suspended.' : nextText(svc.nextRuns ?? [])}</dd></div>
      <div><dt>Command</dt><dd><code data-schedule-command>${svc.command ?? '—'}</code></dd></div>
      <div><dt>Each run gets</dt><dd>${svc.spec ?? '—'} (${svc.planName}) · ${svc.estimate.text}</dd></div>
    </dl>
    <form id="schedule-form" class="nj-stack-gap mt-3" data-schedule-form novalidate hidden>
      <div class="nj-grid-2">
        <div><label class="form-label" for="f-sched">Schedule (UTC)</label>
          <input class="form-control nj-mono" id="f-sched" name="schedule" value="${svc.schedule ?? ''}" autocomplete="off" spellcheck="false" aria-describedby="sched-preview schedule-error">
          <div class="form-text" id="sched-preview" data-sched-preview aria-live="polite"></div>
          <div class="invalid-feedback" id="schedule-error" data-for="schedule"></div></div>
        <div><label class="form-label" for="f-cmd">Command</label>
          <input class="form-control nj-mono" id="f-cmd" name="command" value="${svc.command ?? ''}" autocomplete="off" spellcheck="false" aria-describedby="command-hint command-error">
          <div class="form-text" id="command-hint">What each run starts, in the built image. Changes apply from the next run, with no rebuild.</div>
          <div class="invalid-feedback" id="command-error" data-for="command"></div></div>
      </div>
      <div class="d-flex flex-wrap align-items-center gap-2"><button type="submit" class="btn btn-primary">Save</button><button type="button" class="btn btn-secondary" data-schedule-cancel>Cancel</button></div>
    </form>
    <p class="nj-meta mt-2 mb-0" role="status" aria-live="polite" data-schedule-note></p>
  </section>`;
}

function envSection(svc) {
  return html`<section class="nj-card" aria-labelledby="env-title">
    <h2 class="nj-card-title" id="env-title">Environment variables</h2>
    ${svc.env.length ? html`<ul class="list-unstyled nj-env-keys mb-0">${svc.env.map((e) => html`<li><code>${e.key}</code> <span class="nj-meta" data-value-for="${e.key}">••••••••</span>
      <button type="button" class="btn btn-link btn-sm" data-reveal="${e.key}">Reveal</button></li>`)}</ul>` : html`<p class="nj-meta mb-0">No variables of its own.</p>`}
    ${svc.envGroups.length ? html`<p class="nj-meta mt-3 mb-0">Linked groups: ${svc.envGroups.map((g) => g.name).join(', ')}</p>` : ''}
    <p class="nj-meta mt-3 mb-0">Values are encrypted and never shown in lists. Revealing one asks you to type the service name, and is recorded.</p>
  </section>`;
}

/** Scaling (roadmap 4.7): the instance type and how many instances. */
function scalingSection(svc) {
  const type = CREATABLE[svc.type];
  if (!type?.plan) {
    return emptyState({ icon: 'globe2', title: 'Nothing to scale', text: 'A static site is served from the CDN: there are no instances to size or count.' });
  }
  const suspended = svc.status === 'suspended';
  const countField = type.instances ? html`<div class="nj-instances mb-3">
      <label class="form-label mb-0" for="scale-instances">Instances</label>
      <input class="form-control nj-num" id="scale-instances" name="instances" type="number" value="${svc.instances}" min="1" max="${MAX_INSTANCES}" aria-describedby="scale-hint scale-error"${suspended ? ' disabled' : ''}>
      <span class="form-text mt-0" id="scale-hint">1 to ${MAX_INSTANCES}. Traffic is balanced across them; the price is the same for any count.</span>
    </div>` : '';
  return html`<form class="nj-card" data-scale novalidate aria-labelledby="scale-title">
    <h2 class="nj-card-title" id="scale-title">${type.instances ? 'Instance type and count' : 'Instance type'}</h2>
    <p class="nj-meta">${type.instances ? 'A new count adds or removes instances; the others keep running. A new type starts every instance again at the new size and stops the old ones once the new ones answer. Requests are answered throughout.' : type.tasks ? 'The CPU and memory each task run gets, from the next run. How many run at once is set with the tasks, on the Overview.' : 'The CPU and memory each run gets, from the next run. One run at a time, so there is no count.'}</p>
    <fieldset class="mb-4"><legend class="form-label">Instance type</legend>
      <div role="radiogroup" aria-label="Instance type" class="nj-plans">${PLANS.map((p) => html`<label class="nj-plan">
        <input class="visually-hidden" type="radio" name="plan" value="${p.key}"${p.key === svc.plan ? ' checked' : ''}${suspended ? ' disabled' : ''}>
        <span class="nj-plan-name">${p.name}</span>
        <span class="nj-plan-price nj-num">${priceText(p.priceUsd)}</span>
        <span class="nj-plan-spec nj-num">${specText(p)} · logs ${p.logDays} days</span>
      </label>`)}</div>
    </fieldset>
    ${countField}
    <div class="invalid-feedback d-block" id="scale-error" data-scale-error></div>
    <p class="nj-meta" data-scale-summary></p>
    <div class="d-flex align-items-center gap-3">
      <button class="btn btn-primary" type="submit"${suspended ? ' disabled' : ''}>${type.instances ? 'Save and roll out' : 'Save'}</button>
      <span class="nj-meta" data-scale-note role="status" aria-live="polite">${suspended ? 'Resume the service to scale it.' : ''}</span>
    </div>
  </form>`;
}

function settingsSection(svc) {
  const rows = [
    ['Type', svc.typeLabel ?? svc.type],
    ['Region', `${svc.regionName} (${svc.region})`],
    ...(svc.source ? [['Repository', svc.source.repo], ['Branch', svc.source.branch], ['Root directory', svc.source.rootDir || 'the repository root'], ['Auto-deploy', svc.autoDeploy ? 'On every push to the branch' : 'Off: manual deploys only']] : []),
    ...(svc.build ? [['Runtime', svc.runtimeName ?? svc.build.runtime ?? '—'], ['Build command', svc.build.buildCommand || 'the runtime\'s default'], ...(RUNS_ONLY.has(svc.type) ? [] : [['Start command', svc.build.startCommand || 'the runtime\'s default']])] : []),
    ...(svc.type === 'cron' ? [['Schedule', `${svc.scheduleText || '—'} (${svc.schedule ?? 'none'})`], ['Command', svc.command ?? '—']] : []),
    ...(svc.type === 'workflow' ? [['Tasks', (svc.tasks ?? []).map((t) => t.name).join(', ') || 'none'], ['Runs at once', `Up to ${svc.concurrency}`]] : []),
    ['Address', svc.path ? `${window.location.origin}${svc.path}` : svc.url ?? (svc.internalHost ? `${svc.internalHost} (private network)` : '—')],
    ['Created', when(svc.createdAt)],
  ];
  return html`<section class="nj-card" aria-labelledby="settings-title">
    <h2 class="nj-card-title" id="settings-title">Settings</h2>
    <dl class="nj-help mb-0">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
    <p class="nj-meta mt-3 mb-0">Changing the repository, branch or commands, and deleting a service, come later. Environment variables change on the Environment tab; size and count on Scaling.</p>
  </section>`;
}

export async function servicePage({ workspace, params }) {
  const ws = encodeURIComponent(workspace.id);
  const base = `/api/v1/workspaces/${ws}/services/${encodeURIComponent(params.service)}`;
  let svc;
  try {
    svc = await api(base);
  } catch (err) {
    if (err.status !== 404) throw err;
    return {
      title: `${params.service} · ${workspace.name}`,
      content: emptyState({ icon: 'signpost-split', title: `There is no service called ${params.service}`, action: html`<a class="btn btn-secondary" href="/w/${workspace.id}">Back to Production</a>` }),
    };
  }
  const latest = svc.deploys[0] ?? null;
  const detail = latest ? await api(`${base}/deploys/${encodeURIComponent(latest.id)}`) : null;
  const tabs = tabsFor(svc);
  const cron = svc.type === 'cron';
  const workflow = svc.type === 'workflow';
  const runsOnly = RUNS_ONLY.has(svc.type);
  let tab = new URLSearchParams(window.location.search).get('tab');
  if (!tabs.some(([k]) => k === tab)) tab = 'overview';
  const panel = (key, body) => html`<div class="nj-tabpanel" role="tabpanel" id="panel-${key}" aria-labelledby="tab-${key}" data-panel="${key}"${key === tab ? '' : ' hidden'}>${body}</div>`;
  /** A deploy as the tables draw it: older records have only createdAt. */
  const row = (d) => ({ ...d, service: svc.name, startedAt: d.startedAt ?? d.createdAt });
  const repoLine = svc.source ? `${svc.source.repo} · ${svc.source.branch}${svc.current?.commit ? ` · ${short(svc.current.commit)}` : ''}` : '';

  return {
    title: `${svc.name} · ${workspace.name}`,
    content: html`<div class="nj-page-head"><div>
        <p class="nj-breadcrumb"><a href="/w/${workspace.id}">Production</a> / ${svc.name}</p>
        <div class="nj-title-row"><h1 class="nj-title">${svc.name}</h1><span data-status role="status" aria-label="Status">${statusPill(statusWord(svc.status))}</span></div>
        <p class="nj-lead mb-1" data-lead>${TYPE_NAME[svc.type] ?? svc.typeLabel}${svc.runtimeName ? ` · ${svc.runtimeName}` : ''}${['static', 'postgres', 'keyvalue'].includes(svc.type) ? '' : svc.type === 'cron' ? ` · ${svc.planName}` : workflow ? ` · ${svc.planName} · up to ${svc.concurrency} at once` : ` · ${svc.instances} × ${svc.planName}`} · ${svc.regionName}</p>
        <p class="nj-meta mb-0">
          ${svc.path ? html`<a href="${svc.path}" data-reload rel="noopener" target="_blank">${window.location.origin}${svc.path}</a> · ` : svc.url ? html`<a href="${svc.url}" data-reload rel="noopener" target="_blank">${svc.url.replace('https://', '')}</a> · ` : svc.internalHost ? html`Private: <code>${svc.internalHost}</code> · ` : ''}
          ${repoLine ? html`<i class="bi bi-github" aria-hidden="true"></i> ${repoLine}` : ''}
        </p>
      </div>
      <div class="d-flex flex-column align-items-end gap-2">
        ${actions(svc)}
        <p class="nj-meta mb-0" data-action-note role="status" aria-live="polite"></p>
      </div>
      </div>
      <div data-status-note>${statusNote(svc)}</div>
      ${svc.webhook && !svc.webhook.ok ? html`<div class="alert alert-warning mb-4" role="alert"><strong>Auto-deploy is not set up.</strong> GitHub did not take the webhook: ${svc.webhook.message} Pushes deploy nothing until it is; Manual deploy still works.</div>` : ''}

      <div class="nj-pagetabs" role="tablist" aria-label="${svc.name}">${tabs.map(([key, label]) => html`<button type="button" class="nj-pagetab" role="tab" id="tab-${key}" aria-controls="panel-${key}" aria-selected="${key === tab}" tabindex="${key === tab ? '0' : '-1'}" data-tab="${key}">${label}</button>`)}</div>

      ${panel('overview', html`
        ${cron ? html`${scheduleCard(svc)}
          <section class="nj-card mb-4" aria-labelledby="runs-title">
            <div class="nj-section-head"><h2 class="nj-card-title mb-0" id="runs-title">Runs</h2><button type="button" class="btn btn-link p-0" data-tab="metrics">All its logs</button></div>
            <div data-runs><p class="nj-meta mb-0">Loading…</p></div>
          </section>
          <div class="mb-4" data-run-out></div>` : ''}
        ${workflow ? html`<div data-tasks-card>${tasksCard(svc, { running: 0, queued: 0, concurrency: svc.concurrency, queueLimit: 1000, last: null })}</div>
          <section class="nj-card mb-4" aria-labelledby="task-runs-title">
            <div class="nj-section-head"><h2 class="nj-card-title mb-0" id="task-runs-title">Task runs</h2><button type="button" class="btn btn-link p-0" data-tab="metrics">All its logs</button></div>
            <div data-task-runs><p class="nj-meta mb-0">Loading…</p></div>
          </section>
          <div class="mb-4" data-task-out></div>
          <div data-trigger-box></div>` : ''}
        <section class="nj-card mb-4" aria-labelledby="deploy-title">
          <h2 class="nj-card-title" id="deploy-title">Latest deploy</h2>
          <p class="nj-meta">${svc.estimate.text}${svc.sleepsWhenIdle ? ` · sleeps after ${SLEEP.afterMinutes} minutes without requests` : ''}${svc.spec ? ` · ${svc.planName} is ${svc.spec} per instance` : ''}</p>
          <div data-deploy>${deployCard(latest)}</div>
        </section>
        <div class="mb-4" data-log>${buildLog(detail?.log ?? [], running(latest))}</div>
        <section class="nj-card" aria-labelledby="recent-title">
          <div class="nj-section-head"><h2 class="nj-card-title mb-0" id="recent-title">Recent deploys</h2><button type="button" class="btn btn-link p-0" data-tab="deploys">All deploys</button></div>
          <div data-recent>${deploysTable(svc.deploys.slice(0, 5).map(row), workspace.id, { withService: false })}</div>
        </section>`)}

      ${panel('metrics', runsOnly ? logsPanel({ download: true, foot: retentionText(svc.plan) }) : html`
        <div class="nj-section-head"><h2 class="nj-section-title mb-0">Resources</h2>${segmented('Range', RANGES.map((r) => [r, r]), '1h', 'range')}</div>
        <div class="mb-4" data-resources><div class="nj-res-empty">Loading…</div></div>
        <section class="nj-card mb-4" aria-labelledby="instances-title">
          <div class="nj-section-head"><h2 class="nj-card-title mb-0" id="instances-title">Instances</h2>${CREATABLE[svc.type]?.instances ? html`<button type="button" class="btn btn-link p-0" data-tab="scaling">Change instance type or count</button>` : ''}</div>
          <div data-instances><p class="nj-meta mb-0">Loading…</p></div>
        </section>
        ${logsPanel({ download: true, foot: retentionText(svc.plan) })}`)}

      ${panel('deploys', html`
        <section class="nj-card mb-4" aria-labelledby="deploys-title">
          <h2 class="nj-card-title" id="deploys-title">Deploys</h2>
          <div data-deploys>${deploysTable(svc.deploys.map(row), workspace.id, { withService: false })}</div>
          ${svc.deploys.length ? html`<div class="mt-3"><label class="form-label" for="deploy-pick">Build and rollout log of</label>
            <select class="form-select" id="deploy-pick">${svc.deploys.map((d) => html`<option value="${d.id}">${short(d.commit)} · ${statusWord(d.status)} · ${when(d.startedAt)}</option>`)}</select></div>` : ''}
        </section>
        <div data-deploy-log></div>`)}

      ${panel('environment', envSection(svc))}
      ${panel('scaling', scalingSection(svc))}
      ${panel('settings', settingsSection(svc))}`,

    mount(root) {
      let current = latest;
      let range = '1h';
      const box = root.querySelector('[data-deploy]');
      const logBox = root.querySelector('[data-log]');
      const loaded = new Set();
      const stops = [];

      // ----- Tabs -----
      async function show(key, { focus = false } = {}) {
        tab = key;
        for (const b of root.querySelectorAll('.nj-pagetab')) {
          const selected = b.dataset.tab === key;
          b.setAttribute('aria-selected', String(selected));
          b.tabIndex = selected ? 0 : -1;
          if (selected && focus) b.focus();
        }
        for (const p of root.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== key;
        const url = new URL(window.location.href);
        if (key === 'overview') url.searchParams.delete('tab');
        else url.searchParams.set('tab', key);
        window.history.replaceState({}, '', `${url.pathname}${url.search}`);
        if (loaded.has(key)) return;
        loaded.add(key);
        if (key === 'metrics') {
          if (!runsOnly) refreshMetrics();
          stops.push(mountLogs(root.querySelector('#panel-metrics'), { url: `${base}/logs`, service: svc.name, downloadUrl: () => `${base}/logs/download` }));
        }
        if (key === 'deploys') showDeployLog(root.querySelector('#deploy-pick')?.value);
        if (key === 'scaling') bindScaling();
      }
      root.addEventListener('click', (event) => {
        const t = event.target.closest('[data-tab]');
        if (t) show(t.dataset.tab, { focus: t.classList.contains('nj-pagetab') });
      });
      root.querySelector('.nj-pagetabs').addEventListener('keydown', (event) => {
        const keys = tabs.map(([k]) => k);
        const i = keys.indexOf(tab);
        const next = { ArrowRight: keys[(i + 1) % keys.length], ArrowLeft: keys[(i - 1 + keys.length) % keys.length], Home: keys[0], End: keys.at(-1) }[event.key];
        if (!next) return;
        event.preventDefault();
        show(next, { focus: true });
      });

      // ----- Metrics and logs -----
      async function refreshMetrics() {
        const resBox = root.querySelector('[data-resources]');
        const instBox = root.querySelector('[data-instances]');
        try {
          const [m, { instances }] = await Promise.all([api(`${base}/metrics?range=${range}`), api(`${base}/instances`)]);
          resBox.innerHTML = String(resourceCards(m, svc));
          instBox.innerHTML = String(instanceTiles(instances, svc));
          applySizes(instBox);
        } catch (err) {
          resBox.innerHTML = String(html`<div class="nj-res-empty">${err.message}</div>`);
        }
      }
      root.querySelector('#panel-metrics').addEventListener('click', (event) => {
        if (runsOnly) return;
        const b = event.target.closest('[data-range]');
        if (!b) return;
        range = b.dataset.range;
        selectSegment(root.querySelector('#panel-metrics'), 'range', range);
        refreshMetrics();
      });
      const liveMetrics = throttle(() => { if (!runsOnly && tab === 'metrics' && range === '1h') refreshMetrics(); });
      stops.push(on('metrics', (e) => { if (e.service === svc.name) liveMetrics(); }), liveMetrics.cancel);

      // ----- Deploys -----
      async function showDeployLog(id) {
        const out = root.querySelector('[data-deploy-log]');
        if (!id || !out) return;
        try {
          const d = await api(`${base}/deploys/${encodeURIComponent(id)}`);
          out.innerHTML = String(buildLog(d.log, running(d), `Build and rollout of ${short(d.commit)}`));
        } catch (err) {
          out.textContent = err.message;
        }
      }
      root.querySelector('#deploy-pick')?.addEventListener('change', (e) => showDeployLog(e.target.value));

      async function refreshLog(d) {
        try {
          const full = await api(`${base}/deploys/${encodeURIComponent(d.id)}`);
          logBox.innerHTML = String(buildLog(full.log, running(d)));
          const body = logBox.querySelector('.nj-logs-body');
          body.scrollTop = body.scrollHeight;
        } catch { /* the next event tries again */ }
      }
      // The build log grows line by line while a deploy runs: read it again every 2 seconds until it ends.
      const poll = setInterval(() => {
        if (running(current) && tab === 'overview') refreshLog(current);
        if (cron && tab === 'overview' && runs.some((r) => r.id === shownRun && ['queued', 'running'].includes(r.status))) showRunLog(shownRun);
        if (workflow && tab === 'overview' && taskRuns.some((r) => r.id === shownTask && r.status === 'running')) showTaskRun(shownTask);
      }, 2000);

      // ----- A Workflow's tasks, runs and trigger -----
      let taskRuns = [];
      let shownTask = null;
      let triggerFacts = null;
      let freshKey = null;
      async function showTaskRun(id) {
        shownTask = id;
        const out = root.querySelector('[data-task-out]');
        try {
          const r = await api(`${base}/task-runs/${encodeURIComponent(id)}`);
          out.innerHTML = String(html`${r.attempts.length ? r.attempts.map((a) => html`<div class="mb-3">${buildLog(a.log, a.status === 'running' || a.status === 'queued', `${r.task} · attempt ${a.attempt} of ${r.maxAttempts} · queued ${when(r.createdAt)}`, 'Waiting for the run to start…')}</div>`) : ''}`);
        } catch (err) {
          out.textContent = err.message;
        }
      }
      function drawTrigger() {
        if (!triggerFacts) return;
        root.querySelector('[data-trigger-box]').innerHTML = String(triggerCard(triggerFacts, { task: svc.tasks?.[0]?.name ?? 'send-receipt', fresh: freshKey }));
      }
      async function refreshTasks() {
        const box = root.querySelector('[data-task-runs]');
        try {
          const r = await api(`${base}/tasks`);
          taskRuns = r.runs;
          Object.assign(svc, { tasks: r.tasks, concurrency: r.concurrency });
          const meters = root.querySelector('[data-task-meters]');
          const last = r.runs.find((x) => ['succeeded', 'failed'].includes(x.status));
          meters.innerHTML = String(html`${taskMeters({ ...r.counts, last: last ? { task: last.task, status: last.status, at: last.finishedAt ?? last.createdAt, durationMs: last.durationMs, attempts: last.attempt } : null })}`);
          applySizes(meters);
          box.innerHTML = String(taskRunsTable(r.runs, r.limitMb));
          triggerFacts = r.trigger;
          drawTrigger();
          if (shownTask) await showTaskRun(shownTask);
        } catch (err) {
          box.textContent = err.message;
        }
      }
      if (workflow) {
        refreshTasks();
        const liveTasks = throttle(refreshTasks, 1000);
        stops.push(on('task', (e) => { if (e.service === svc.name) liveTasks(); }), liveTasks.cancel);
        const card = root.querySelector('[data-tasks-card]');
        const note = () => card.querySelector('[data-tasks-note]');
        // Run: the input form under the table, for the task asked.
        card.addEventListener('click', (event) => {
          const runButton = event.target.closest('[data-task-run]');
          const runForm = card.querySelector('[data-run-form]');
          if (runButton) {
            runForm.hidden = false;
            runForm.dataset.task = runButton.dataset.taskRun;
            runForm.querySelector('[data-run-task]').textContent = runButton.dataset.taskRun;
            runForm.input.focus();
          }
          if (event.target.closest('[data-run-cancel]')) runForm.hidden = true;
          const edit = event.target.closest('[data-tasks-edit]');
          const tForm = card.querySelector('[data-tasks-form]');
          if (edit) {
            tForm.hidden = !tForm.hidden;
            edit.setAttribute('aria-expanded', String(!tForm.hidden));
            if (!tForm.hidden) tForm.querySelector('input').focus();
          }
          if (event.target.closest('[data-tasks-cancel]')) {
            tForm.hidden = true;
            card.querySelector('[data-tasks-edit]').setAttribute('aria-expanded', 'false');
          }
        });
        // Submits are caught on the card: Save draws the card again, with new forms.
        let editor = bindTasksEditor(card.querySelector('[data-tasks-form]'));
        card.addEventListener('submit', (event) => {
          if (event.target.matches('[data-run-form]')) queueRun(event);
          else if (event.target.matches('[data-tasks-form]')) saveTasks(event);
        });
        async function queueRun(event) {
          event.preventDefault();
          const form = event.target;
          const field = form.input;
          field.classList.remove('is-invalid');
          form.querySelector('[data-for="input"]').textContent = '';
          let input;
          try {
            input = field.value.trim() ? JSON.parse(field.value) : undefined;
          } catch {
            field.classList.add('is-invalid');
            field.setAttribute('aria-invalid', 'true');
            form.querySelector('[data-for="input"]').textContent = 'Input is JSON, such as {"orderId": 42}.';
            field.focus();
            return;
          }
          try {
            const { run } = await api(`${base}/tasks/${encodeURIComponent(form.dataset.task)}/runs`, { method: 'POST', body: input === undefined ? {} : { input } });
            note().textContent = run.status === 'running' ? `${run.task} is running. Its output shows below.` : `${run.task} is queued: it starts when a place is free${svc.status === 'suspended' ? ' and the workflow is resumed' : ''}.`;
            form.hidden = true;
            field.value = '';
            shownTask = run.id;
            await refreshTasks();
          } catch (err) {
            showErrors(form, err);
            if (!err.details?.length) note().textContent = err.message;
          }
        }
        async function saveTasks(event) {
          event.preventDefault();
          const form = event.target;
          for (const el of form.querySelectorAll('.is-invalid')) el.classList.remove('is-invalid');
          for (const el of form.querySelectorAll('.invalid-feedback')) el.textContent = '';
          form.querySelector('[data-form-alert]').hidden = true;
          try {
            const r = await api(`${base}/tasks`, { method: 'PUT', body: { tasks: editor.read(), concurrency: editor.concurrency() } });
            Object.assign(svc, { tasks: r.tasks, concurrency: r.concurrency });
            card.innerHTML = String(tasksCard(svc, { running: 0, queued: 0, concurrency: svc.concurrency, queueLimit: 1000, last: null }));
            note().textContent = r.changed ? `Saved: ${r.tasks.length} task${r.tasks.length === 1 ? '' : 's'}, up to ${r.concurrency} at once. It applies from the next run.` : 'Nothing changed.';
            const lead = root.querySelector('[data-lead]');
            lead.textContent = lead.textContent.replace(/up to \d+ at once/, `up to ${r.concurrency} at once`);
            editor = bindTasksEditor(card.querySelector('[data-tasks-form]'));
            await refreshTasks();
          } catch (err) {
            showErrors(form, err);
          }
        }
        root.querySelector('[data-task-runs]').addEventListener('click', async (event) => {
          const log = event.target.closest('[data-task-log]');
          if (log) showTaskRun(log.dataset.taskLog).then(() => root.querySelector('[data-task-out]').scrollIntoView({ block: 'nearest' }));
          const cancel = event.target.closest('[data-task-cancel]');
          if (cancel) {
            cancel.disabled = true;
            try {
              await api(`${base}/task-runs/${encodeURIComponent(cancel.dataset.taskCancel)}/cancel`, { method: 'POST', body: {} });
              await refreshTasks();
            } catch (err) {
              note().textContent = err.message;
              cancel.disabled = false;
            }
          }
        });
        root.querySelector('[data-trigger-box]').addEventListener('click', async (event) => {
          const create = event.target.closest('[data-key-create]');
          const remove = event.target.closest('[data-key-remove]');
          if (!create && !remove) return;
          if (create && triggerFacts?.key && !window.confirm('Replace the key? The old one stops working at once.')) return;
          if (remove && !window.confirm('Remove the key? Nothing can start a task from code until you create another.')) return;
          try {
            if (create) {
              const r = await api(`${base}/trigger-key`, { method: 'POST', body: {} });
              freshKey = r.key;
            } else {
              await api(`${base}/trigger-key`, { method: 'DELETE' });
              freshKey = null;
            }
            await refreshTasks();
            root.querySelector('[data-key-note]').textContent = create ? 'Key made. Copy it now.' : 'Key removed.';
          } catch (err) {
            root.querySelector('[data-key-note]').textContent = err.message;
          }
        });
      }

      // ----- A Cron Job's runs and schedule -----
      let runs = [];
      let shownRun = null;
      async function showRunLog(id) {
        shownRun = id;
        const out = root.querySelector('[data-run-out]');
        try {
          const r = await api(`${base}/runs/${encodeURIComponent(id)}`);
          out.innerHTML = String(buildLog(r.log, ['queued', 'running'].includes(r.status), `Run of ${when(r.startedAt)}`, 'Waiting for the run to start…'));
        } catch (err) {
          out.textContent = err.message;
        }
      }
      function drawSchedule(s) {
        Object.assign(svc, { schedule: s.expression, scheduleText: s.text, command: s.command, nextRuns: s.next });
        root.querySelector('[data-schedule-text]').textContent = s.text || 'No schedule';
        root.querySelector('[data-schedule-expr]').textContent = s.expression ?? '';
        root.querySelector('[data-schedule-next]').textContent = svc.status === 'suspended' ? 'None while it is suspended.' : nextText(s.next);
        root.querySelector('[data-schedule-command]').textContent = s.command ?? '—';
      }
      async function refreshRuns() {
        const box = root.querySelector('[data-runs]');
        try {
          const r = await api(`${base}/runs`);
          runs = r.runs;
          box.innerHTML = String(runsTable(runs, r.schedule.limitMb));
          drawSchedule(r.schedule);
          if (shownRun || runs[0]) await showRunLog(shownRun ?? runs[0].id);
        } catch (err) {
          box.textContent = err.message;
        }
      }
      if (cron) {
        refreshRuns();
        stops.push(on('run', (e) => { if (e.service === svc.name) refreshRuns(); }));
        root.querySelector('[data-runs]').addEventListener('click', (event) => {
          const b = event.target.closest('[data-run-log]');
          if (!b) return;
          showRunLog(b.dataset.runLog).then(() => root.querySelector('[data-run-out]').scrollIntoView({ block: 'nearest' }));
        });
        const sForm = root.querySelector('[data-schedule-form]');
        const edit = root.querySelector('[data-schedule-edit]');
        const note = root.querySelector('[data-schedule-note]');
        const preview = () => { sForm.querySelector('[data-sched-preview]').textContent = schedulePreview(sForm.schedule.value); };
        const close = () => {
          sForm.hidden = true;
          edit.setAttribute('aria-expanded', 'false');
          edit.focus();
        };
        edit.addEventListener('click', () => {
          sForm.hidden = !sForm.hidden;
          edit.setAttribute('aria-expanded', String(!sForm.hidden));
          if (!sForm.hidden) {
            sForm.schedule.value = svc.schedule ?? '';
            sForm.command.value = svc.command ?? '';
            note.textContent = '';
            preview();
            sForm.schedule.focus();
          }
        });
        sForm.querySelector('[data-schedule-cancel]').addEventListener('click', close);
        sForm.addEventListener('input', preview);
        sForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          for (const el of sForm.querySelectorAll('.is-invalid')) el.classList.remove('is-invalid');
          for (const el of sForm.querySelectorAll('.invalid-feedback')) el.textContent = '';
          try {
            const r = await api(`${base}/schedule`, { method: 'PATCH', body: { schedule: sForm.schedule.value, command: sForm.command.value } });
            drawSchedule(r.schedule);
            note.textContent = r.changed ? `Saved: ${r.schedule.text}. It applies from the next run.` : 'Nothing changed.';
            close();
          } catch (err) {
            showErrors(sForm, err);
          }
        });
      }

      const showStatus = (status) => {
        svc.status = status;
        root.querySelector('[data-status]').innerHTML = String(statusPill(statusWord(status)));
        root.querySelector('[data-status-note]').innerHTML = String(statusNote(svc));
        root.querySelector('.nj-actions')?.replaceWith(...new DOMParser().parseFromString(String(actions(svc)), 'text/html').body.childNodes);
      };
      stops.push(on('deploy', async (e) => {
        if (e.service !== svc.name) return;
        if (e.status) showStatus(e.status);
        if (!e.deploy) return;
        if (current && e.deploy.id !== current.id && Date.parse(e.deploy.startedAt ?? 0) < Date.parse(current.startedAt ?? 0)) return;
        current = e.deploy;
        box.innerHTML = String(deployCard(current));
        applySizes(box);
        if (current.status === 'live') {
          svc.current ??= { deployId: current.id, commit: current.commit ?? null };
          showStatus('live');
        }
        await refreshLog(current);
        const { deploys } = await api(`${base}/deploys`);
        const rows = deploys.map(row);
        root.querySelector('[data-recent]').innerHTML = String(deploysTable(rows.slice(0, 5), workspace.id, { withService: false }));
        root.querySelector('[data-deploys]').innerHTML = String(deploysTable(rows, workspace.id, { withService: false }));
      }));

      // ----- Scaling -----
      function bindScaling() {
        const form = root.querySelector('[data-scale]');
        if (!form) return;
        const summary = form.querySelector('[data-scale-summary]');
        const say = () => {
          const plan = planOf(form.plan.value);
          if (!form.instances) {
            summary.textContent = `${plan.name} (${specText(plan)}) for each run · ${estimate(plan.key).text}. Now: ${svc.planName}.`;
            return;
          }
          const n = Number(form.instances.value) || 0;
          summary.textContent = `${n} × ${plan.name} (${specText(plan)} each) · ${estimate(plan.key).text}. Now: ${svc.instances} × ${svc.planName}.`;
        };
        form.addEventListener('change', say);
        form.addEventListener('input', say);
        say();
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const errorBox = form.querySelector('[data-scale-error]');
          const note = form.querySelector('[data-scale-note]');
          const input = form.instances;
          errorBox.textContent = '';
          input?.classList.remove('is-invalid');
          const instances = input ? Number(input.value) : null;
          if (input && (!Number.isInteger(instances) || instances < 1 || instances > MAX_INSTANCES)) {
            errorBox.textContent = `Choose 1 to ${MAX_INSTANCES} instances.`;
            input.classList.add('is-invalid');
            input.focus();
            return;
          }
          const button = form.querySelector('[type=submit]');
          button.disabled = true;
          try {
            const r = await api(`${base}/scale`, { method: 'POST', body: { plan: form.plan.value, ...(input ? { instances } : {}) } });
            if (!r.changed) note.textContent = 'Nothing changed.';
            else {
              const was = { plan: svc.plan, instances: svc.instances, planName: svc.planName };
              Object.assign(svc, { plan: r.service.plan, instances: r.service.instances, planName: planOf(r.service.plan).name });
              const diff = svc.instances - was.instances;
              const how = !input ? 'It applies from the next run.' : svc.plan !== was.plan ? 'Instances of the new size are starting; the old ones stop once they answer.'
                : diff > 0 ? `${diff} new instance${diff === 1 ? ' is' : 's are'} starting; the others keep running.`
                  : `${-diff} instance${diff === -1 ? ' is' : 's are'} stopping; the others keep running.`;
              note.textContent = input ? `Saved: ${svc.instances} × ${svc.planName}. ${how}` : `Saved: ${svc.planName}. ${how}`;
              const lead = root.querySelector('[data-lead]');
              lead.textContent = input ? lead.textContent.replace(/\d+ × [A-Za-z ]+? ·/, `${svc.instances} × ${svc.planName} ·`) : lead.textContent.replace(` · ${was.planName} · `, ` · ${svc.planName} · `);
              say();
            }
          } catch (err) {
            errorBox.textContent = err.details?.map((d) => d.message).join(' ') || err.message;
          } finally {
            button.disabled = false;
          }
        });
      }

      // A scale the platform could not finish: back to what runs, and why.
      stops.push(on('scale', (e) => {
        if (e.service !== svc.name || !e.failed) return;
        Object.assign(svc, { plan: e.plan, instances: e.instances, planName: planOf(e.plan)?.name ?? svc.planName });
        root.querySelector('[data-lead]').textContent = root.querySelector('[data-lead]').textContent.replace(/\d+ × [A-Za-z ]+? ·/, `${svc.instances} × ${svc.planName} ·`);
        const form = root.querySelector('[data-scale]');
        if (!form) return;
        if (form.instances) form.instances.value = String(svc.instances);
        const radio = form.querySelector(`input[name=plan][value="${svc.plan}"]`);
        if (radio) radio.checked = true;
        form.querySelector('[data-scale-note]').textContent = '';
        form.querySelector('[data-scale-error]').textContent = `Could not scale: ${e.reason ?? 'something went wrong'}. Still ${svc.instances} × ${svc.planName}.`;
        form.dispatchEvent(new Event('change'));
      }));

      // Manual deploy, Restart, Suspend, Resume (roadmap 3.8). The status comes back over the live channel.
      const SAY = { deploys: 'Deploy started.', restart: 'Restarting the instances one at a time.', suspend: cron ? 'Suspending: the schedule stops firing.' : workflow ? 'Suspending: no task starts until you resume it.' : 'Suspending: the instances stop.', resume: cron ? 'Resuming: the schedule fires again.' : workflow ? 'Resuming: waiting runs start.' : 'Resuming: the instances start.', runs: 'Run started. Its output shows below as it runs.' };
      root.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const verb = button.dataset.action;
        if (verb === 'suspend' && !window.confirm(cron ? `Suspend ${svc.name}? Its schedule fires nothing until you resume it.` : workflow ? `Suspend ${svc.name}? No task starts until you resume it; runs you queue wait.` : `Suspend ${svc.name}? Its instances stop and it answers no requests until you resume it.`)) return;
        const note = root.querySelector('[data-action-note]');
        button.disabled = true;
        try {
          await api(`${base}/${verb}`, { method: 'POST', body: {} });
          note.textContent = SAY[verb];
        } catch (err) {
          note.textContent = err.message;
        } finally {
          button.disabled = false;
        }
      });

      root.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-reveal]');
        if (!button) return;
        const key = button.dataset.reveal;
        const confirm = window.prompt(`Type ${svc.name} to reveal ${key}. This is recorded.`);
        if (confirm === null) return;
        try {
          const { value } = await api(`${base}/env/${encodeURIComponent(key)}/reveal`, { method: 'POST', body: { confirm } });
          const out = root.querySelector(`[data-value-for="${CSS.escape(key)}"]`);
          out.textContent = value;
          out.classList.add('nj-mono');
          button.remove();
        } catch (err) {
          window.alert(err.details?.[0]?.message ?? err.message);
        }
      });

      loaded.add(tab);
      if (tab !== 'overview') {
        loaded.delete(tab);
        show(tab);
      }
      return () => {
        clearInterval(poll);
        for (const s of stops) s();
      };
    },
  };
}
