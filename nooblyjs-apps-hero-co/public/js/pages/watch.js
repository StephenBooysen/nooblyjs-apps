// The watch screens (roadmap 4.4–4.6; product.md §6.4, §6.5): the pieces the service page shares (resource cards,
// instance tiles, the log viewer) and the workspace's Dashboard, Deploys, Metrics and Logs pages. Live changes come
// over the workspace channel ('metrics', 'deploy', 'log'); a page re-reads at most every LIVE_MS.
import { html, raw } from '../html.js';
import { api } from '../api.js';
import { on } from '../sse.js';
import { areaChart, stackedBar, applySizes } from '../charts.js';
import { statusPill, emptyState, meter } from '../components/index.js';
import { PLANS, planOf } from '../shared/catalog.js';
import { cpuText, memoryParts, memoryText, bytesParts, bytesText, rateParts, countText, pctOf, ago, uptime, logTime, duration, msText, until, utcText, RANGE_START } from '../format.js';

const LIVE_MS = 10_000;
export const RANGES = ['1h', '24h', '7d', '30d'];
const LOG_PAGE = 500;
const LOG_KEEP = 1000;
const WORD = { queued: 'Queued', building: 'Building', deploying: 'Deploying', live: 'Live', failed: 'Failed', cancelled: 'Cancelled', superseded: 'Succeeded', suspended: 'Suspended', sleeping: 'Sleeping', idle: 'Idle' };
export const statusWord = (s) => WORD[s] ?? (s ? s[0].toUpperCase() + s.slice(1) : 'Idle');
const short = (sha) => (sha ? sha.slice(0, 7) : '—');
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** Calls fn at most once every ms (the last call in a burst is kept, not lost). */
export function throttle(fn, ms = LIVE_MS) {
  let last = 0;
  let timer = null;
  const run = () => {
    timer = null;
    last = Date.now();
    fn();
  };
  const call = () => {
    if (timer) return;
    const wait = last + ms - Date.now();
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  };
  call.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return call;
}

function head({ eyebrow, title, lead, actions = '' }) {
  return html`<div class="nj-page-head">
    <div>${eyebrow ? html`<p class="nj-breadcrumb">${eyebrow}</p>` : ''}<h1 class="nj-title">${title}</h1>${lead ? html`<p class="nj-lead">${lead}</p>` : ''}</div>
    ${actions}
  </div>`;
}

/** A segmented control (ranges, levels): toggle buttons, the chosen one aria-pressed. */
export function segmented(label, options, current, attr) {
  return html`<div class="nj-tabs" role="group" aria-label="${label}">${options.map(([value, text]) => html`<button type="button" class="nj-tab" data-${attr}="${value}" aria-pressed="${value === current}">${text}</button>`)}</div>`;
}
export function selectSegment(group, attr, value) {
  for (const b of group.querySelectorAll(`[data-${attr}]`)) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
}

// ---------- Resources (service page, Metrics and logs) ----------

/** "0.41 vCPU · 82%" as the big value of the CPU card. */
function bigValue(value, unit, pct) {
  return html`<div class="nj-res-value">${value}<span class="nj-stat-unit">${unit}${pct === null ? '' : ` · ${Math.round(pct)}%`}</span></div>`;
}

function resCard({ label, aside, value, chart, range }) {
  return html`<section class="nj-res-card" aria-label="${label}">
    <div class="nj-res-head"><strong>${label}</strong><span>${aside}</span></div>
    ${value}
    ${chart}
    <div class="nj-res-axis" aria-hidden="true"><span>${RANGE_START[range]}</span><span>now</span></div>
  </section>`;
}

/**
 * The four resource cards from GET .../services/:service/metrics.
 * @param {object} m   the metrics response
 * @param {object} svc the service (type, local, regionName)
 */
export function resourceCards(m, svc) {
  const cur = m.current;
  const lim = m.limits;
  const pts = m.points;
  const sampled = pts.filter((p) => p.cpu !== null);
  const range = m.range;
  const nothing = (text) => html`<div class="nj-res-empty">${text}</div>`;
  const noSamples = svc.local
    ? 'No samples yet. They arrive every 10 seconds while an instance runs.'
    : `Resource charts for ${svc.regionName} arrive with cloud monitoring (roadmap Phase 4, cloud). Services in the Local network region show them now.`;
  const series = (key) => sampled.map((p) => ({ t: p.t, value: p[key] }));
  const [memV, memU] = memoryParts(cur.memoryMb);
  const counts = svc.type === 'web' && svc.local;
  const reqNote = svc.type === 'web' ? 'Requests are counted at its public address. Cloud regions count them with the load balancer, later.' : 'Not a web service: it answers no public HTTP requests.';
  const [rateV, rateU] = rateParts(cur.bytesPerSec);
  const cards = [
    resCard({
      label: 'CPU', range, aside: lim.cpu ? `Limit ${cpuText(lim.cpu)} vCPU` : 'No limit',
      value: bigValue(cur.cpu === null ? '—' : cpuText(cur.cpu), 'vCPU', cur.cpu === null || !lim.cpu ? null : pctOf(cur.cpu, lim.cpu)),
      chart: sampled.length ? html`${raw(areaChart(series('cpu'), { metric: 'cpu', limit: lim.cpu || undefined, label: `CPU over the last ${range}, in vCPU, limit ${lim.cpu} vCPU` }))}` : nothing(noSamples),
    }),
    resCard({
      label: 'Memory', range, aside: lim.memoryMb ? `Limit ${memoryText(lim.memoryMb)}` : 'No limit',
      value: bigValue(memV, memU, cur.memoryMb === null || !lim.memoryMb ? null : pctOf(cur.memoryMb, lim.memoryMb)),
      chart: sampled.length ? html`${raw(areaChart(series('mem'), { metric: 'memory', limit: lim.memoryMb || undefined, label: `Memory over the last ${range}, in MB, limit ${lim.memoryMb} MB` }))}` : nothing(noSamples),
    }),
    resCard({
      label: 'HTTP requests', range, aside: counts && m.peak.reqPerMin ? `Peak ${countText(m.peak.reqPerMin)} / min` : '',
      value: counts ? bigValue(countText(cur.reqPerMin), 'per min', null) : bigValue('—', 'per min', null),
      chart: counts && pts.length ? html`${raw(areaChart(pts.map((p) => ({ t: p.t, value: p.reqPerMin })), { metric: 'requests', label: `HTTP requests per minute over the last ${range}` }))}` : nothing(counts ? noSamples : reqNote),
    }),
    resCard({
      label: 'Bandwidth out', range, aside: counts ? `${bytesText(cur.monthBytes)} this month` : '',
      value: counts ? bigValue(rateV, rateU, null) : bigValue('—', 'B/s', null),
      chart: counts && pts.length ? html`${raw(areaChart(pts.map((p) => ({ t: p.t, value: p.bytesPerSec })), { metric: 'bandwidth', label: `Bytes sent per second over the last ${range}` }))}` : nothing(counts ? noSamples : reqNote),
    }),
  ];
  return html`<div class="nj-res-grid">${cards}</div>`;
}

// ---------- Instances ----------

const INSTANCE_WORD = { running: 'Running', starting: 'Starting', crashed: 'Crashed', stopped: 'Stopped', unknown: 'Unknown' };

/** Memory "used / limit" in the limit's unit: "1.16 / 2 GB", "26.6 / 512 MB". */
function memoryPair(used, limit) {
  if (limit >= 1024) return `${used === null ? '—' : (used / 1024).toFixed(2)} / ${Number((limit / 1024).toFixed(1))} GB`;
  return `${used === null ? '—' : Number(used.toFixed(1))} / ${limit} MB`;
}

export function instanceTiles(list, svc) {
  if (!list.length) {
    return emptyState({ icon: 'hdd-stack', title: 'No instances running', text: svc.status === 'suspended' ? 'The service is suspended.' : svc.status === 'sleeping' ? 'It is asleep: the next request wakes it.' : 'Instances appear here once a deploy starts them.' });
  }
  return html`<div class="nj-instance-grid">${list.map((i) => {
    const status = INSTANCE_WORD[i.status] ?? 'Unknown';
    const foot = [uptime(i.startedAt), `${i.restarts} restart${i.restarts === 1 ? '' : 's'}`];
    if (i.restarts && i.lastExitCode !== null) foot.push(`last exit code ${i.lastExitCode}`);
    if (i.status === 'unknown') foot.push('its server is offline');
    return html`<div class="nj-instance">
      <div class="nj-instance-head"><span class="nj-instance-id">${svc.name}-${i.id}</span>${statusPill(status)}</div>
      ${meter({ label: 'CPU', value: `${i.cpu.used === null ? '—' : cpuText(i.cpu.used)} / ${cpuText(i.cpu.limit)} vCPU`, pct: pctOf(i.cpu.used, i.cpu.limit), metric: 'cpu' })}
      ${meter({ label: 'Memory', value: memoryPair(i.memory.usedMb, i.memory.limitMb), pct: pctOf(i.memory.usedMb, i.memory.limitMb), metric: 'memory' })}
      <div class="nj-meta">${foot.join(' · ')}${i.sampledAt ? '' : ' · no sample yet'}</div>
    </div>`;
  })}</div>`;
}

// ---------- The log viewer ----------

const LEVEL_TABS = [['', 'All'], ['debug,info', 'Info'], ['warn', 'Warnings'], ['error', 'Errors'], ['build', 'Build']];

/**
 * The dark log viewer's frame.
 * @param {{ services?: string[]|null, download?: boolean, foot?: string }} o   services: a picker (workspace Logs)
 */
export function logsPanel({ services = null, download = false, foot = '' } = {}) {
  return html`<section class="nj-logs" data-logs aria-labelledby="logs-title">
    <div class="nj-logs-bar">
      <div class="nj-logs-head"><h2 class="nj-logs-title" id="logs-title">Logs</h2><span class="nj-logs-live" data-logs-live role="status">Streaming live</span></div>
      ${services ? html`<label class="visually-hidden" for="logs-service">Service</label>
        <select class="form-select form-select-sm nj-logs-input" id="logs-service" data-logs-service><option value="">All services</option>${services.map((s) => html`<option value="${s}">${s}</option>`)}</select>` : ''}
      ${segmented('Level', LEVEL_TABS, '', 'level')}
      <label class="visually-hidden" for="logs-search">Search logs</label>
      <input class="form-control form-control-sm nj-logs-input" id="logs-search" type="search" placeholder="Search logs" autocomplete="off" maxlength="200" data-logs-search>
      <button type="button" class="btn btn-sm btn-secondary" data-logs-pause aria-pressed="false">Pause</button>
      ${download ? html`<a class="btn btn-sm btn-secondary" data-logs-download data-reload download href="#" aria-label="Download these logs (the last 24 hours, with the filters above)"><i class="bi bi-download" aria-hidden="true"></i></a>` : ''}
    </div>
    <button type="button" class="nj-logs-new" data-logs-new hidden></button>
    <div class="nj-logs-body" role="log" aria-live="polite" aria-label="Log lines, newest first" data-logs-body><div class="nj-logs-empty">Loading…</div></div>
    ${foot ? html`<div class="nj-logs-foot">${foot}</div>` : ''}
  </section>`;
}

const logRow = (l, withService) => html`<div class="nj-log-line ${withService ? 'nj-log-row-svc' : 'nj-log-row'}"><span class="nj-log-time">${logTime(l.at)}</span>${withService ? html`<span class="nj-log-svc">${l.service}</span>` : ''}<span class="nj-log-inst">${l.instance ?? ''}</span><span class="nj-log-level nj-log-${l.level}">${l.level}</span><span>${l.line}</span></div>`;

/**
 * Binds a logsPanel: the newest LOG_PAGE lines that match the level, search (and service), then live 'log' events
 * that match, newest first. Changing a filter asks the server again (its search covers the kept days).
 * @param {Element} root
 * @param {{ url: string, service?: string|null, downloadUrl?: (service: string) => string }} o
 *   service: this panel shows one service (the service page); otherwise the picker chooses
 * @returns {() => void} stop
 */
export function mountLogs(root, { url, service = null, downloadUrl = null }) {
  const panel = root.querySelector('[data-logs]');
  const body = panel.querySelector('[data-logs-body]');
  const live = panel.querySelector('[data-logs-live]');
  const pauseBtn = panel.querySelector('[data-logs-pause]');
  const newBtn = panel.querySelector('[data-logs-new]');
  const search = panel.querySelector('[data-logs-search]');
  const picker = panel.querySelector('[data-logs-service]');
  const download = panel.querySelector('[data-logs-download]');
  const withService = !service;
  let level = '';
  let q = '';
  let lines = [];
  let paused = false;
  let missed = 0;
  let token = 0;
  let more = false;
  const chosen = () => service ?? picker?.value ?? '';

  const filters = () => {
    const p = new URLSearchParams();
    if (level) p.set('level', level);
    if (q) p.set('q', q);
    if (!service && chosen()) p.set('service', chosen());
    return p;
  };
  const matches = (l) => (!chosen() || l.service === chosen()) && (!level || level.split(',').includes(l.level))
    && (!q || l.line.toLowerCase().includes(q.toLowerCase()) || String(l.instance ?? '').includes(q));

  function draw() {
    if (!lines.length) {
      body.innerHTML = String(html`<div class="nj-logs-empty">${level || q ? 'No lines match these filters in the kept logs.' : 'No log lines yet. Lines appear here as the service writes them.'}</div>`);
      return;
    }
    body.innerHTML = String(html`${lines.map((l) => logRow(l, withService))}${more && lines.length >= LOG_PAGE ? html`<div class="nj-logs-empty">Older lines match too: search for something narrower, or download them.</div>` : ''}`);
  }
  function updateDownload() {
    if (!download) return;
    const svc = chosen();
    download.hidden = !svc;
    if (svc) download.href = `${downloadUrl(svc)}?${filters()}`;
  }
  async function load() {
    const mine = (token += 1);
    const p = filters();
    p.set('limit', String(LOG_PAGE));
    try {
      const r = await api(`${url}?${p}`);
      if (mine !== token) return;
      lines = r.lines.reverse();
      more = r.more;
      missed = 0;
      newBtn.hidden = true;
      draw();
    } catch (err) {
      if (mine === token) body.innerHTML = String(html`<div class="nj-logs-empty">${err.details?.[0]?.message ?? err.message}</div>`);
    }
    updateDownload();
  }

  const stop = on('log', (e) => {
    if (service && e.service !== service) return;
    const fresh = e.lines.map((l) => ({ ...l, service: e.service })).filter(matches);
    if (!fresh.length) return;
    if (paused) {
      missed += fresh.length;
      newBtn.textContent = `${countText(missed)} new line${missed === 1 ? '' : 's'} while paused. Show them`;
      newBtn.hidden = false;
      return;
    }
    lines = [...fresh, ...lines].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, LOG_KEEP);
    draw();
  });

  const setPaused = (value) => {
    paused = value;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    live.textContent = paused ? 'Paused' : 'Streaming live';
    live.classList.toggle('is-paused', paused);
  };
  panel.addEventListener('click', (event) => {
    const lv = event.target.closest('[data-level]');
    if (lv) {
      level = lv.dataset.level;
      selectSegment(panel, 'level', level);
      load();
    }
    if (event.target.closest('[data-logs-pause]')) {
      setPaused(!paused);
      if (!paused && missed) load();
    }
    if (event.target.closest('[data-logs-new]')) {
      setPaused(false);
      load();
    }
  });
  let typing = null;
  search.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      q = search.value.trim();
      load();
    }, 300);
  });
  picker?.addEventListener('change', load);
  load();
  return () => {
    clearTimeout(typing);
    stop();
  };
}

/** The retention line under a service's logs. */
export function retentionText(planKey) {
  const plan = planOf(planKey);
  return plan ? `${plan.name} keeps logs for ${plan.logDays} days. Search covers all of them; the view shows the newest ${LOG_PAGE} lines that match.` : '';
}

// ---------- Dashboard ----------

/** A stat tile with a meter under it. */
function statMeter({ label, value, unit, caption, pct, metric }) {
  return html`<div class="nj-stat">
    <div class="nj-stat-label">${label}</div>
    <div class="nj-stat-value">${value}${unit ? html`<span class="nj-stat-unit">${unit}</span>` : ''}</div>
    ${pct === undefined ? '' : html`<div class="nj-meter nj-meter-${metric}" role="meter" aria-label="${label}" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="${value} ${unit}"><div class="nj-meter-fill" data-pct="${pct}"></div></div>`}
    ${caption ? html`<div class="nj-stat-caption">${caption}</div>` : ''}
  </div>`;
}

/** Kinds whose own pages (and numbers) arrive later: their card says so instead of drawing empty meters. */
const LATER = { postgres: 'Managed Postgres: storage and connections arrive with its own page.', keyvalue: 'Managed Key Value: memory and connections arrive with its own page.', workflow: 'Tasks and queue depth arrive with Workflows.' };

/**
 * A Cron Job's runs on its card and its Metrics row (roadmap 5.3): the last run (its result, when, how long it took),
 * its peak memory against the instance type's, and when the next one is.
 */
export function runMeters(run) {
  const last = run.last;
  const measured = last && !run.running && Number.isFinite(last.peakMemoryMb);
  const lastText = run.running ? 'Running now.' : last
    ? `${statusWord(last.status)} ${ago(last.at)}${Number.isFinite(last.durationMs) ? `, took ${msText(last.durationMs)}` : ''}${last.status === 'failed' && last.exitCode !== null ? ` (exit code ${last.exitCode})` : ''}.`
    : 'No runs yet.';
  return [
    html`<p class="nj-run-last mb-2"><span class="nj-meta">Last run</span> ${lastText}</p>`,
    meter({ label: 'Peak memory', value: measured ? `${memoryText(last.peakMemoryMb)} of ${memoryText(run.limitMb)}` : run.running ? 'Measured when it ends' : `Not measured · ${memoryText(run.limitMb)}`, pct: measured ? pctOf(last.peakMemoryMb, run.limitMb) : 0, metric: 'memory' }),
    html`<p class="nj-meta mb-0" data-next-run>${run.next ? `Next run ${until(run.next)} · ${utcText(run.next)}` : 'No next run: it is suspended, or has no schedule.'}</p>`,
  ];
}

/** A Cron Job's runs, newest first, each with a button that shows its log. */
export function runsTable(runs, limitMb) {
  if (!runs.length) return emptyState({ icon: 'clock-history', title: 'No runs yet', text: 'Each run shows here with its result, how long it took and its peak memory. Run now to try it.' });
  return html`<div class="table-responsive"><table class="table mb-0">
    <caption class="visually-hidden">Runs, newest first</caption>
    <thead><tr><th scope="col">Started</th><th scope="col">Status</th><th scope="col">Started by</th><th scope="col">Took</th><th scope="col">Exit code</th><th scope="col">Peak memory</th><th scope="col"><span class="visually-hidden">Log</span></th></tr></thead>
    <tbody>${runs.map((r) => html`<tr>
      <td class="nj-num">${when(r.startedAt)}</td>
      <td>${statusPill(statusWord(r.status))}${r.status === 'failed' && r.reason ? html`<div class="nj-meta">${r.reason}</div>` : ''}</td>
      <td>${r.by ?? '—'}</td>
      <td class="nj-num">${['queued', 'running'].includes(r.status) ? 'running' : msText(r.durationMs)}</td>
      <td class="nj-num">${r.exitCode ?? '—'}</td>
      <td class="nj-num">${r.peakMemoryMb === null || r.peakMemoryMb === undefined ? '—' : `${memoryText(r.peakMemoryMb)} of ${memoryText(limitMb)}`}</td>
      <td><button type="button" class="btn btn-link btn-sm p-0" data-run-log="${r.id}" aria-label="Show the log of the run started ${when(r.startedAt)}">Log</button></td>
    </tr>`)}</tbody>
  </table></div>`;
}

function serviceCard(c, ws) {
  const sub = c.instances ? `${c.typeLabel} · ${c.instances} × ${c.planName ?? c.plan} · ${c.regionName}` : c.run ? `${c.typeLabel} · ${c.run.scheduleText || 'no schedule'} · ${c.regionName}` : `${c.typeLabel} · ${c.regionName}`;
  const meters = c.run ? runMeters(c.run) : LATER[c.type] ? html`<p class="nj-meta mb-0">${LATER[c.type]}</p>` : c.cpu.limit
    ? [
      meter({ label: 'CPU', value: c.cpu.used === null ? `No samples · ${cpuText(c.cpu.limit)} vCPU` : `${cpuText(c.cpu.used)} of ${cpuText(c.cpu.limit)} vCPU`, pct: pctOf(c.cpu.used, c.cpu.limit), metric: 'cpu' }),
      meter({ label: 'Memory', value: c.memory.usedMb === null ? `No samples · ${memoryText(c.memory.limitMb)}` : `${memoryText(c.memory.usedMb)} of ${memoryText(c.memory.limitMb)}`, pct: pctOf(c.memory.usedMb, c.memory.limitMb), metric: 'memory' }),
    ]
    : [
      meter({ label: 'Bandwidth this month', value: bytesText(c.bandwidth.monthBytes), pct: 0, metric: 'bandwidth' }),
      meter({ label: 'Requests', value: `${countText(c.requests.perMin)} / min`, pct: 0, metric: 'requests' }),
    ];
  const foot = !c.last && ['postgres', 'keyvalue'].includes(c.type) ? 'Managed data store' : c.last
    ? html`<span class="nj-mono">${short(c.last.commit)}</span> · ${c.last.status === 'live' || c.last.status === 'superseded' ? `deployed ${ago(c.last.at)}` : c.last.status === 'failed' ? `failed ${ago(c.last.at)}` : `${statusWord(c.last.status).toLowerCase()} now`}`
    : 'Not deployed yet';
  return html`<article class="nj-svc-card" data-card="${c.name}">
    <div class="nj-svc-card-head"><div><a class="nj-svc-card-name" href="/w/${ws}/services/${c.name}">${c.name}</a><div class="nj-svc-card-sub">${sub}</div></div>${statusPill(statusWord(c.status))}</div>
    <hr class="nj-svc-card-rule">
    ${meters}
    <div class="nj-svc-card-foot">${foot}</div>
  </article>`;
}

export function deploysTable(list, ws, { withService = true } = {}) {
  if (!list.length) return emptyState({ icon: 'rocket-takeoff', title: 'No deploys yet', text: 'Each deploy shows here with its commit, trigger and result.' });
  return html`<div class="table-responsive"><table class="table mb-0">
    <caption class="visually-hidden">Deploys, newest first</caption>
    <thead><tr>${withService ? html`<th scope="col">Service</th>` : ''}<th scope="col">Commit</th><th scope="col">Status</th><th scope="col">Trigger</th><th scope="col">Started</th><th scope="col">Took</th></tr></thead>
    <tbody>${list.map((d) => html`<tr>
      ${withService ? html`<td><a href="/w/${ws}/services/${d.service}?tab=deploys">${d.service}</a></td>` : ''}
      <td><span class="nj-mono">${short(d.commit)}</span> <span class="nj-meta">${d.message ?? ''}</span></td>
      <td>${statusPill(statusWord(d.status))}${d.status === 'failed' && d.reason ? html`<div class="nj-meta">${d.reason}</div>` : ''}</td>
      <td>${d.trigger ?? '—'}${d.by?.name ? html`<div class="nj-meta">${d.by.name}</div>` : ''}</td>
      <td class="nj-num">${when(d.startedAt)}</td>
      <td class="nj-num">${['queued', 'building', 'deploying'].includes(d.status) ? 'running' : !d.endedAt || duration(d.startedAt, d.endedAt) === '0 s' ? '—' : duration(d.startedAt, d.endedAt)}</td>
    </tr>`)}</tbody>
  </table></div>`;
}

function dashboardBody(d, ws) {
  const s = d.services;
  const caption = [
    s.deploying.length ? `${s.deploying.length} deploying · ${s.deploying.join(', ')}` : '',
    s.failed.length ? `${s.failed.length} failed · ${s.failed.join(', ')}` : '',
    s.asleep.length ? `${s.asleep.length} asleep or suspended` : '',
  ].filter(Boolean).join(' · ') || (s.total ? 'All live' : 'Nothing deployed yet');
  const [memUsedV, memUsedU] = memoryParts(d.memory.usedMb);
  // Only services with samples are measured (Local network now; cloud regions with cloud monitoring).
  const reserving = d.cards.filter((c) => c.cpu.limit);
  const measured = reserving.filter((c) => c.cpu.used !== null).length;
  const measuredText = reserving.length && measured < reserving.length ? `Measured on ${measured} of ${reserving.length} services: the others have no samples yet` : 'Measured now, against what the services reserve';
  const [bwV, bwU] = bytesParts(d.bandwidth.monthBytes);
  const top = d.allocation.slice(0, 5);
  const rest = d.allocation.slice(5);
  const segs = [...top.map((a) => ({ label: a.service, value: a.cpu, unit: 'vCPU' })), ...(rest.length ? [{ label: rest.map((a) => a.service).join(', '), value: Math.round(rest.reduce((x, a) => x + a.cpu, 0) * 100) / 100, unit: 'vCPU' }] : [])];
  return html`<div class="nj-stats mb-4">
      ${statMeter({ label: 'Services running', value: s.live, unit: `of ${s.total}`, caption })}
      ${statMeter({ label: 'CPU in use', value: cpuText(d.cpu.used), unit: `/ ${cpuText(d.cpu.allocated)} vCPU`, pct: pctOf(d.cpu.used, d.cpu.allocated), metric: 'cpu', caption: measuredText })}
      ${statMeter({ label: 'Memory in use', value: memUsedV, unit: `${memUsedU} / ${memoryText(d.memory.allocatedMb)}`, pct: pctOf(d.memory.usedMb, d.memory.allocatedMb), metric: 'memory', caption: measuredText })}
      ${statMeter({ label: 'Bandwidth · this month', value: bwV, unit: `${bwU} of ${bytesText(d.bandwidth.includedBytes)}`, pct: pctOf(d.bandwidth.monthBytes, d.bandwidth.includedBytes), metric: 'bandwidth' })}
    </div>
    <section class="nj-card mb-4" aria-labelledby="alloc-title">
      <div class="nj-section-head"><h2 class="nj-card-title" id="alloc-title">CPU allocated by service</h2><span class="nj-meta">${cpuText(d.cpu.allocated)} vCPU reserved across ${d.allocation.length} service${d.allocation.length === 1 ? '' : 's'}</span></div>
      ${segs.length ? raw(stackedBar(segs, { label: 'CPU reserved by each service' })) : html`<p class="nj-meta mb-0">No service reserves CPU yet.</p>`}
    </section>
    <div data-cards class="nj-svc-cards mb-5">${d.cards.map((c) => serviceCard(c, ws))}</div>
    <section class="nj-card" aria-labelledby="recent-title">
      <div class="nj-section-head"><h2 class="nj-card-title" id="recent-title">Recent deploys</h2><a href="/w/${ws}/deploys">All deploys</a></div>
      ${deploysTable(d.deploys, ws)}
    </section>`;
}

export async function dashboardPage({ workspace }) {
  const id = encodeURIComponent(workspace.id);
  const [ws, d, github] = await Promise.all([api(`/api/v1/workspaces/${id}`), api(`/api/v1/workspaces/${id}/dashboard`), api(`/api/v1/workspaces/${id}/github`)]);
  const env = ws.projects.find((p) => p.isDefault)?.environments.find((e) => e.name === 'Production');
  const lead = `${d.services.total} service${d.services.total === 1 ? '' : 's'}${env ? ` · ${env.regionName} (${env.region})` : ''} · ${github.connected ? `connected to GitHub as ${github.login}` : 'not connected to GitHub yet'}`;
  const actions = html`<div class="d-flex gap-2"><a class="btn btn-secondary" href="/w/${workspace.id}/env-groups">Environment groups</a><a class="btn btn-primary" href="/w/${workspace.id}/new"><i class="bi bi-plus-lg" aria-hidden="true"></i> New service</a></div>`;
  if (!d.services.total) {
    return {
      title: `Production · ${workspace.name}`,
      content: html`${head({ eyebrow: workspace.name, title: 'Production', lead, actions })}${emptyState({
        icon: 'rocket-takeoff', title: 'No services yet',
        text: 'Launch your first service from a GitHub repo. Its CPU, memory, requests and deploys appear here.',
        action: html`<a class="btn btn-primary" href="/w/${workspace.id}/new">New service</a>`,
      })}`,
    };
  }
  return {
    title: `Production · ${workspace.name}`,
    content: html`${head({ eyebrow: workspace.name, title: 'Production', lead, actions })}
      <div class="nj-section-head"><h2 class="nj-section-title mb-0">Overview</h2>
        <div class="nj-search"><i class="bi bi-search" aria-hidden="true"></i><label class="visually-hidden" for="svc-filter">Filter services</label><input class="form-control" id="svc-filter" type="search" placeholder="Filter services" autocomplete="off"></div></div>
      <div data-dash>${dashboardBody(d, workspace.id)}</div>`,
    mount(root) {
      const box = root.querySelector('[data-dash]');
      const filter = root.querySelector('#svc-filter');
      const applyFilter = () => {
        const q = filter.value.trim().toLowerCase();
        for (const card of box.querySelectorAll('[data-card]')) card.hidden = Boolean(q) && !card.dataset.card.includes(q) && !card.textContent.toLowerCase().includes(q);
      };
      filter.addEventListener('input', applyFilter);
      const refresh = throttle(async () => {
        try {
          const fresh = await api(`/api/v1/workspaces/${id}/dashboard`);
          box.innerHTML = String(dashboardBody(fresh, workspace.id));
          applySizes(box);
          applyFilter();
        } catch { /* the next event tries again */ }
      });
      const stops = [on('metrics', refresh), on('deploy', refresh)];
      return () => {
        refresh.cancel();
        for (const s of stops) s();
      };
    },
  };
}

// ---------- Workspace Deploys, Metrics, Logs ----------

export async function deploysPage({ workspace }) {
  const id = encodeURIComponent(workspace.id);
  const [{ deploys }, { services }] = await Promise.all([api(`/api/v1/workspaces/${id}/deploys`), api(`/api/v1/workspaces/${id}/services`)]);
  return {
    title: `Deploys · ${workspace.name}`,
    content: html`${head({ eyebrow: workspace.name, title: 'Deploys', lead: 'Every deploy in this workspace: commit, trigger, status and how long it took.' })}
      <section class="nj-card">
        <div class="nj-section-head"><h2 class="nj-card-title mb-0">Newest first</h2>
          <div><label class="visually-hidden" for="deploys-service">Service</label><select class="form-select" id="deploys-service"><option value="">All services</option>${services.map((s) => html`<option value="${s.name}">${s.name}</option>`)}</select></div></div>
        <div data-deploys>${deploysTable(deploys, workspace.id)}</div>
      </section>`,
    mount(root) {
      const box = root.querySelector('[data-deploys]');
      const pick = root.querySelector('#deploys-service');
      const load = async () => {
        const q = pick.value ? `?service=${encodeURIComponent(pick.value)}` : '';
        try {
          box.innerHTML = String(deploysTable((await api(`/api/v1/workspaces/${id}/deploys${q}`)).deploys, workspace.id));
        } catch (err) {
          box.textContent = err.message;
        }
      };
      pick.addEventListener('change', load);
      const refresh = throttle(load, 3000);
      const stop = on('deploy', refresh);
      return () => {
        refresh.cancel();
        stop();
      };
    },
  };
}

function metricsRows(m, ws) {
  if (!m.services.length) return emptyState({ icon: 'activity', title: 'No services yet', text: 'Charts appear here once a service runs.' });
  return html`${m.services.map((s) => {
    const sampled = s.points.filter((p) => p.cpu !== null);
    const chart = (label, metric, pts, limit, text) => html`<div class="nj-mini-chart"><p class="nj-meta">${label} · ${text}</p>${pts.length ? raw(areaChart(pts, { metric, limit, height: 90, label: `${s.name} ${label} over the last ${m.range}` })) : html`<div class="nj-res-empty">No samples</div>`}</div>`;
    return html`<section class="nj-card mb-3" aria-labelledby="m-${s.name}">
      <div class="nj-section-head"><div><h2 class="nj-card-title mb-0" id="m-${s.name}"><a href="/w/${ws}/services/${s.name}?tab=metrics">${s.name}</a></h2><span class="nj-meta">${s.typeLabel}${s.instances ? ` · ${s.instances} × ${s.planName}` : ''} · ${s.regionName}</span></div>${statusPill(statusWord(s.status))}</div>
      ${s.run ? html`<div class="nj-run-row">${runMeters(s.run)}</div>` : !sampled.length && !s.points.some((p) => p.req) ? html`<p class="nj-meta mb-0">${LATER[s.type] ?? (s.region === 'local' ? `No samples in the last ${m.range} yet: they arrive every 10 seconds while an instance runs.` : `Charts for ${s.regionName} arrive with cloud monitoring. Services in the Local network region have them now.`)}</p>` : html`<div class="nj-mini-charts">
        ${chart('CPU', 'cpu', sampled.map((p) => ({ t: p.t, value: p.cpu })), s.cpu.limit || undefined, s.cpu.used === null ? 'no samples now' : `${cpuText(s.cpu.used)} of ${cpuText(s.cpu.limit)} vCPU now`)}
        ${chart('Memory', 'memory', sampled.map((p) => ({ t: p.t, value: p.mem })), s.memory.limitMb || undefined, s.memory.usedMb === null ? 'no samples now' : `${memoryText(s.memory.usedMb)} of ${memoryText(s.memory.limitMb)} now`)}
        ${chart('Requests', 'requests', s.points.some((p) => p.req) ? s.points.map((p) => ({ t: p.t, value: p.reqPerMin })) : [], undefined, `${countText(s.requests.perMin)} / min now`)}
      </div>`}
    </section>`;
  })}`;
}

export async function metricsPage({ workspace }) {
  const id = encodeURIComponent(workspace.id);
  let range = new URLSearchParams(window.location.search).get('range');
  if (!RANGES.includes(range)) range = '1h';
  const m = await api(`/api/v1/workspaces/${id}/metrics?range=${range}`);
  return {
    title: `Metrics · ${workspace.name}`,
    content: html`${head({ eyebrow: workspace.name, title: 'Metrics', lead: 'CPU, memory and requests of every service. Samples arrive every 10 seconds.' })}
      <div class="nj-section-head"><h2 class="nj-section-title mb-0">Services</h2>${segmented('Range', RANGES.map((r) => [r, r]), range, 'range')}</div>
      <div data-metrics>${metricsRows(m, workspace.id)}</div>`,
    mount(root) {
      const box = root.querySelector('[data-metrics]');
      const load = async () => {
        try {
          box.innerHTML = String(metricsRows(await api(`/api/v1/workspaces/${id}/metrics?range=${range}`), workspace.id));
        } catch { /* keep what is drawn */ }
      };
      root.addEventListener('click', (event) => {
        const b = event.target.closest('[data-range]');
        if (!b) return;
        range = b.dataset.range;
        selectSegment(root, 'range', range);
        window.history.replaceState({}, '', `${window.location.pathname}?range=${range}`);
        load();
      });
      const refresh = throttle(load);
      const stop = on('metrics', () => { if (range === '1h') refresh(); });
      return () => {
        refresh.cancel();
        stop();
      };
    },
  };
}

export async function logsPage({ workspace }) {
  const id = encodeURIComponent(workspace.id);
  const { services } = await api(`/api/v1/workspaces/${id}/services`);
  const days = PLANS.map((p) => `${p.name} ${p.logDays} days`).join(', ');
  return {
    title: `Logs · ${workspace.name}`,
    content: html`${head({ eyebrow: workspace.name, title: 'Logs', lead: 'Live and kept logs from every service, newest first. Filter by level, search, or pick a service.' })}
      ${logsPanel({ services: services.map((s) => s.name), download: true, foot: `Each service keeps its logs as long as its instance type says: ${days}. Pick a service to download its lines.` })}`,
    mount(root) {
      return mountLogs(root, { url: `/api/v1/workspaces/${id}/logs`, downloadUrl: (svc) => `/api/v1/workspaces/${id}/services/${encodeURIComponent(svc)}/logs/download` });
    },
  };
}

