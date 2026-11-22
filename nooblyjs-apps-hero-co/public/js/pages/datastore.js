// Postgres and Key Value (roadmap 6.4; product.md §6.3, §6.4): the short create form (name, region, plan, and the daily
// backup time or what happens when it is full), the page of one (connection details with an audited reveal, Storage or
// Memory and Connections meters, backups with Back up now and Restore, the services linked to it, the plan), and the
// Link to service card on a service's Environment tab. The stores are the platform's (src/routes/datastores.js).
import { html } from '../html.js';
import { api } from '../api.js';
import { on } from '../sse.js';
import { showErrors } from '../forms.js';
import { applySizes } from '../charts.js';
import { statusPill, stepper } from '../components/index.js';
import { DATA_PLANS, DATA_DEFAULTS, EVICTIONS, dataPlanText, priceText } from '../shared/catalog.js';
import { statusWord, storeMeters } from './watch.js';
import { bytesText, ago } from '../format.js';

const feedback = (name) => html`<div class="invalid-feedback" id="${name}-error" data-for="${name}"></div>`;
const WORDS = {
  postgres: { what: 'database', title: 'Postgres', action: 'Create database', lead: 'A Postgres database of your own: its own user and password, backed up every day, reachable only from this workspace\'s services.' },
  keyvalue: { what: 'store', title: 'Key Value', action: 'Create Key Value store', lead: 'A Redis-compatible store (Valkey) for a cache or a queue, reachable only from this workspace\'s services.' },
};
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function clearErrors(form) {
  for (const el of form.querySelectorAll('[aria-invalid="true"]')) {
    el.removeAttribute('aria-invalid');
    el.classList.remove('is-invalid');
  }
  for (const el of form.querySelectorAll('.invalid-feedback[data-for]')) el.textContent = '';
  const alert = form.querySelector('[data-form-alert]');
  if (alert) alert.hidden = true;
}

function plansGroup(type, chosen) {
  return html`<div role="radiogroup" aria-label="Plan" aria-describedby="plan-error" class="nj-plans">${DATA_PLANS[type].map((p) => html`<label class="nj-plan">
    <input type="radio" class="visually-hidden" name="plan" value="${p.key}"${p.key === chosen ? html` checked` : ''}>
    <span class="nj-plan-name">${p.name}</span>
    <span class="nj-plan-price nj-num">${priceText(p.priceUsd)}</span>
    <span class="nj-plan-spec nj-num">${dataPlanText(type, p)}</span>
  </label>`)}</div>${feedback('plan')}`;
}

/** New Postgres / New Key Value. */
export async function createDataStorePage({ workspace, typeInfo }) {
  const ws = encodeURIComponent(workspace.id);
  const type = typeInfo.key;
  const w = WORDS[type];
  const catalog = await api(`/api/v1/workspaces/${ws}/catalog`);
  const first = catalog.regions.find((r) => r.available && r.local) ?? catalog.regions.find((r) => r.available);
  return {
    title: `New ${typeInfo.name} · ${workspace.name}`,
    content: html`<div class="nj-page-head"><div>
        <p class="nj-breadcrumb"><a href="/w/${workspace.id}">Production</a> / <a href="/w/${workspace.id}/new">New service</a> / ${typeInfo.name}</p>
        <h1 class="nj-title">New ${typeInfo.name}</h1>
        <p class="nj-lead">${w.lead}</p></div></div>
      ${stepper(['Choose service', 'Configure', 'Create'], 1)}
      <form class="nj-with-summary" novalidate data-form="datastore">
        <div class="nj-stack-gap-lg">
          <fieldset class="nj-fieldset">
            <legend><span class="nj-step-no" aria-hidden="true">1</span>Name and region</legend>
            <div class="nj-grid-2">
              <div><label class="form-label" for="f-name">Name</label>
                <input class="form-control" id="f-name" name="name" autocomplete="off" spellcheck="false" maxlength="40" placeholder="${type === 'postgres' ? 'main-db' : 'cache'}" aria-describedby="name-hint name-error">
                <div class="form-text" id="name-hint">Lower-case letters, digits and hyphens. Services link it by this name.</div>${feedback('name')}</div>
              <div><label class="form-label" for="f-region">Region</label>
                <select class="form-select" id="f-region" name="region" aria-describedby="region-hint region-error">${catalog.regions.map((r) => html`<option value="${r.id}"${r.available ? '' : html` disabled`}${r.id === first?.id ? html` selected` : ''}>${r.name} (${r.id})${r.available ? '' : ' · coming soon'}</option>`)}</select>
                <div class="form-text" id="region-hint">Put it in the region of the services that use it: a link stays inside one region.</div>${feedback('region')}</div>
            </div>
          </fieldset>
          <fieldset class="nj-fieldset">
            <legend><span class="nj-step-no" aria-hidden="true">2</span>Plan</legend>
            <p class="mb-0">${type === 'postgres' ? 'Connections at once, and the storage its meter counts against. You can change it later; connections change at once.' : 'Memory for its keys and clients at once. Changing it later starts the store again, and its keys are lost.'}</p>
            ${plansGroup(type, DATA_DEFAULTS[type].plan)}
          </fieldset>
          <fieldset class="nj-fieldset">
            <legend><span class="nj-step-no" aria-hidden="true">3</span>${type === 'postgres' ? 'Backups' : 'When it is full'}</legend>
            ${type === 'postgres' ? html`<div class="nj-grid-2"><div><label class="form-label" for="f-backup">Daily backup at (UTC)</label>
                <input class="form-control nj-num" id="f-backup" name="backupTime" type="time" value="${DATA_DEFAULTS.postgres.backupTime}" aria-describedby="backup-hint backupTime-error">
                <div class="form-text" id="backup-hint">The last ${DATA_DEFAULTS.postgres.keepBackups} are kept. Back up now and Restore are on its page.</div>${feedback('backupTime')}</div></div>`
              : html`<div class="nj-grid-2"><div><label class="form-label" for="f-eviction">Eviction</label>
                <select class="form-select" id="f-eviction" name="eviction" aria-describedby="eviction-hint eviction-error">${EVICTIONS.map((e) => html`<option value="${e.key}"${e.key === DATA_DEFAULTS.keyvalue.eviction ? html` selected` : ''}>${e.name}</option>`)}</select>
                <div class="form-text" id="eviction-hint">Keys live in memory only: a restart empties the store.</div>${feedback('eviction')}</div></div>`}
          </fieldset>
        </div>
        <aside class="nj-summary" aria-label="Summary">
          <h2 class="nj-card-title">Summary</h2>
          <dl><dt>Type</dt><dd>${typeInfo.name}</dd><dt>Plan</dt><dd data-sum="plan">—</dd><dt>Region</dt><dd data-sum="region">—</dd></dl>
          <hr>
          <div class="nj-summary-total"><span>Estimated</span><strong class="nj-num" data-sum="price">$— / mo</strong></div>
          <p class="nj-meta">Link it to a service on that service's Environment tab: it gets ${DATA_DEFAULTS[type].linkKey}, and only this workspace's services can connect.</p>
          <div class="alert alert-danger mt-3 mb-0" role="alert" tabindex="-1" data-form-alert hidden></div>
          <button type="submit" class="btn btn-primary w-100 nj-deploy-btn">${w.action}</button>
        </aside>
      </form>`,
    mount(root) {
      const form = root.querySelector('[data-form="datastore"]');
      const $ = (sel) => form.querySelector(sel);
      const update = () => {
        const p = DATA_PLANS[type].find((x) => x.key === form.querySelector('input[name="plan"]:checked')?.value);
        $('[data-sum="plan"]').textContent = p ? `${p.name} · ${dataPlanText(type, p)}` : '—';
        $('[data-sum="price"]').textContent = p ? `${priceText(p.priceUsd)} / mo` : '$— / mo';
        $('[data-sum="region"]').textContent = $('#f-region').selectedOptions[0]?.textContent ?? '—';
      };
      form.addEventListener('change', update);
      update();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearErrors(form);
        const body = {
          type, name: $('#f-name').value.trim(), region: $('#f-region').value,
          plan: form.querySelector('input[name="plan"]:checked')?.value,
          ...(type === 'postgres' ? { backupTime: $('#f-backup').value || null } : { eviction: $('#f-eviction').value }),
        };
        const button = form.querySelector('[type="submit"]');
        const label = button.textContent;
        button.disabled = true;
        button.textContent = 'Creating…';
        try {
          const result = await api(`/api/v1/workspaces/${ws}/datastores`, { method: 'POST', body });
          window.location.assign(result.redirect);
        } catch (err) {
          showErrors(form, err);
          button.disabled = false;
          button.textContent = label;
        }
      });
    },
  };
}

function connectionCard(d) {
  const c = d.connection;
  if (!c || d.status !== 'live') return html`<p class="nj-meta mb-0">${d.status === 'failed' ? `It could not be created: ${d.reason ?? 'no reason given'}` : 'The connection details appear once it is up.'}</p>`;
  const where = c.through === 'relay'
    ? 'This string names the server itself: use it from the machine the Local network runs on (psql, a migration tool). Your services reach it through a relay on the workspace\'s own network, and linking puts that address in the variable. No other workspace\'s service can connect.'
    : c.through === 'network'
      ? 'It answers on a private name only the workspace\'s own network resolves. Nothing outside the workspace can connect.'
      : 'Private to the workspace\'s services in this region.';
  return html`<dl class="nj-kv mb-3">
      <dt>Host</dt><dd><code>${c.host}</code></dd>
      <dt>Port</dt><dd class="nj-num">${c.port}</dd>
      ${d.type === 'postgres' ? html`<dt>Database</dt><dd><code>${c.database}</code></dd>` : ''}
      <dt>User</dt><dd><code>${c.user}</code></dd>
      <dt>Password</dt><dd class="nj-meta">•••••••• <span>(in the connection string)</span></dd>
    </dl>
    <p class="nj-meta">${where}</p>
    <form class="nj-reveal" data-reveal-form novalidate>
      <label class="form-label" for="f-confirm">Type <strong>${d.name}</strong> to see the connection string</label>
      <div class="d-flex flex-wrap gap-2"><input class="form-control nj-mono" id="f-confirm" name="confirm" autocomplete="off" spellcheck="false" aria-describedby="confirm-error confirm-hint">
        <button type="submit" class="btn btn-secondary">Reveal</button></div>
      ${feedback('confirm')}
      <p class="form-text" id="confirm-hint">This is recorded in the audit log.</p>
      <div data-revealed></div>
    </form>`;
}

function metersCard(d) {
  const facts = d.type === 'postgres' ? (d.storage ? { storage: d.storage, connections: d.connections } : null) : d.memory ? { memory: d.memory, connections: d.connections } : null;
  return facts ? storeMeters(facts) : html`<p class="nj-meta mb-0">${d.type === 'postgres' ? 'Storage and connections show once it is up.' : 'Memory and clients show once it is up.'}</p>`;
}

function backupsCard(d) {
  return html`<div class="nj-section-head"><h2 class="nj-card-title mb-0" id="backups-title">Backups</h2>
      <button type="button" class="btn btn-secondary btn-sm" data-backup${d.status === 'live' ? '' : html` disabled`}>Back up now</button></div>
    <p class="nj-meta">${d.backupTime ? `Every day at ${d.backupTime} UTC` : 'No daily backup'}; the last ${d.keepBackups} are kept. A restore makes a new database from the backup, and leaves this one as it is.</p>
    ${d.backups.length ? html`<div class="table-responsive"><table class="table nj-table mb-0"><thead><tr><th scope="col">Taken</th><th scope="col">Size</th><th scope="col">By</th><th scope="col"><span class="visually-hidden">Restore</span></th></tr></thead>
      <tbody>${d.backups.map((b) => html`<tr><td>${when(b.at)} <span class="nj-meta">· ${ago(b.at)}</span></td><td class="nj-num">${bytesText(b.bytes)}</td><td>${b.trigger === 'schedule' ? 'Daily' : 'Back up now'}</td>
        <td class="text-end"><button type="button" class="btn btn-link btn-sm" data-restore="${b.id}" aria-label="Restore the backup taken ${when(b.at)}">Restore</button></td></tr>`)}</tbody></table></div>`
      : html`<p class="nj-meta mb-0" data-no-backups>No backups yet.</p>`}
    <form class="nj-stack-gap mt-3" data-restore-form novalidate hidden>
      <input type="hidden" name="backup">
      <label class="form-label mb-0" for="f-into">Name of the new database</label>
      <div class="d-flex flex-wrap gap-2"><input class="form-control" id="f-into" name="into" autocomplete="off" spellcheck="false" maxlength="40" aria-describedby="into-error">
        <button type="submit" class="btn btn-primary">Restore into a new database</button></div>
      ${feedback('into')}${feedback('backup')}
    </form>`;
}

function planCard(d) {
  return html`<h2 class="nj-card-title" id="plan-title">Plan</h2>
    <form data-plan-form novalidate>
      ${plansGroup(d.type, d.plan)}
      ${d.type === 'postgres' ? html`<div class="mt-3"><label class="form-label" for="f-backup-time">Daily backup at (UTC)</label>
        <input class="form-control nj-num" id="f-backup-time" name="backupTime" type="time" value="${d.backupTime ?? ''}" aria-describedby="backupTime-error">${feedback('backupTime')}</div>`
        : html`<div class="mt-3"><label class="form-label" for="f-evict">Eviction</label>
        <select class="form-select" id="f-evict" name="eviction">${EVICTIONS.map((e) => html`<option value="${e.key}"${e.key === d.eviction ? html` selected` : ''}>${e.name}</option>`)}</select>${feedback('eviction')}</div>`}
      <div class="alert alert-danger mt-3 mb-0" role="alert" tabindex="-1" data-form-alert hidden></div>
      <div class="d-flex align-items-center gap-3 mt-3"><button type="submit" class="btn btn-secondary">Save</button><span class="nj-meta" role="status" data-plan-note></span></div>
      <p class="nj-meta mt-2 mb-0">${d.type === 'postgres' ? 'A new connection limit applies at once.' : 'A change starts the store again; its keys are lost.'}</p>
    </form>`;
}

/** The page of one Postgres or Key Value service (servicePage hands it over). */
export async function dataStorePage({ workspace, svc, base }) {
  const ws = encodeURIComponent(workspace.id);
  let d = await api(`${base}/datastore`);
  const w = WORDS[d.type];
  const lead = () => `${w.title}${d.engine ? ` · ${d.engine === 'valkey' ? 'Valkey' : 'Postgres'} ${d.version ? String(d.version).split(' ')[0] : ''}` : ''} · ${d.planName} · ${d.regionName}`;
  const linked = () => (d.linked.length
    ? html`<ul class="list-unstyled mb-0">${d.linked.map((l) => html`<li><a href="/w/${workspace.id}/services/${l.service}?tab=environment">${l.service}</a> · <code>${l.key}</code></li>`)}</ul>`
    : html`<p class="nj-meta mb-0">No service uses it yet. Link it on a service's Environment tab, as <code>${d.linkKey}</code>.</p>`);
  return {
    title: `${svc.name} · ${workspace.name}`,
    content: html`<div class="nj-page-head"><div>
        <p class="nj-breadcrumb"><a href="/w/${workspace.id}">Production</a> / ${svc.name}</p>
        <div class="nj-title-row"><h1 class="nj-title">${svc.name}</h1><span data-status role="status" aria-label="Status">${statusPill(statusWord(d.status))}</span></div>
        <p class="nj-lead mb-1" data-lead>${lead()}</p>
        ${d.restoredFrom ? html`<p class="nj-meta mb-0">Restored from ${d.restoredFrom.database}'s backup of ${when(d.restoredFrom.at)}</p>` : ''}
      </div></div>
      <div class="nj-store-grid">
        <section class="nj-card" aria-labelledby="conn-title"><h2 class="nj-card-title" id="conn-title">Connection</h2><div data-connection>${connectionCard(d)}</div></section>
        <section class="nj-card" aria-labelledby="use-title"><h2 class="nj-card-title" id="use-title">${d.type === 'postgres' ? 'Storage and connections' : 'Memory and clients'}</h2><div data-meters>${metersCard(d)}</div>
          <h3 class="nj-subtitle mt-4">Linked services</h3><div data-linked>${linked()}</div></section>
        ${d.type === 'postgres' ? html`<section class="nj-card" aria-labelledby="backups-title" data-backups>${backupsCard(d)}</section>` : ''}
        <section class="nj-card" aria-labelledby="plan-title" data-plan>${planCard(d)}</section>
      </div>`,
    mount(root) {
      applySizes(root);
      const refresh = async () => {
        d = await api(`${base}/datastore`);
        root.querySelector('[data-status]').innerHTML = statusPill(statusWord(d.status));
        root.querySelector('[data-lead]').textContent = lead();
        if (!root.querySelector('[data-revealed]')?.textContent) root.querySelector('[data-connection]').innerHTML = connectionCard(d);
        root.querySelector('[data-meters]').innerHTML = metersCard(d);
        root.querySelector('[data-linked]').innerHTML = linked();
        const b = root.querySelector('[data-backups]');
        if (b && b.querySelector('[data-restore-form]')?.hidden !== false) b.innerHTML = backupsCard(d);
        applySizes(root);
      };
      const stops = [on('datastore', (e) => { if (e.service === svc.name) refresh(); })];
      // Meters move while it is used: look again every 15 seconds while the page is open.
      const timer = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 15_000);

      root.addEventListener('submit', async (event) => {
        const form = event.target;
        event.preventDefault();
        clearErrors(form);
        try {
          if (form.matches('[data-reveal-form]')) {
            const { url } = await api(`${base}/datastore/reveal`, { method: 'POST', body: { confirm: form.confirm.value } });
            form.querySelector('[data-revealed]').innerHTML = html`<label class="form-label mt-2" for="f-url">Connection string</label><input class="form-control nj-mono" id="f-url" readonly value="${url}">`;
          }
          if (form.matches('[data-restore-form]')) {
            const result = await api(`${base}/datastore/restore`, { method: 'POST', body: { backup: form.backup.value, into: form.into.value.trim() } });
            window.location.assign(result.redirect);
          }
          if (form.matches('[data-plan-form]')) {
            const body = { plan: form.querySelector('input[name="plan"]:checked')?.value, ...(d.type === 'postgres' ? { backupTime: form.backupTime.value || null } : { eviction: form.eviction.value }) };
            d = await api(`${base}/datastore`, { method: 'PATCH', body });
            form.querySelector('[data-plan-note]').textContent = d.type === 'postgres' ? 'Saved.' : 'Saved: the store is starting again.';
            await refresh();
          }
        } catch (err) {
          showErrors(form, err);
        }
      });
      root.addEventListener('click', async (event) => {
        const restore = event.target.closest('[data-restore]');
        if (restore) {
          const form = root.querySelector('[data-restore-form]');
          form.hidden = false;
          form.backup.value = restore.dataset.restore;
          form.into.value = `${svc.name}-restored`.slice(0, 40);
          form.into.focus();
        }
        const backup = event.target.closest('[data-backup]');
        if (backup) {
          backup.disabled = true;
          backup.textContent = 'Backing up…';
          try {
            await api(`${base}/datastore/backups`, { method: 'POST' });
          } catch (err) {
            backup.textContent = err.message;
            return;
          }
          // The backup's event refreshes the table; this is the fallback when the live channel is away.
          setTimeout(() => refresh().catch(() => {}), 2000);
        }
      });
      return () => {
        clearInterval(timer);
        for (const s of stops) s();
      };
    },
  };
}

// ---------- Link to service (a service's Environment tab) ----------

/** The card: the service's links, and a form to add one. */
export function linksCard(svc, stores) {
  const links = svc.links ?? [];
  const usable = stores.filter((s) => s.region === svc.region);
  return html`<section class="nj-card mt-4" aria-labelledby="links-title" data-links-card>
    <h2 class="nj-card-title" id="links-title">Linked data stores</h2>
    ${links.length ? html`<ul class="list-unstyled nj-env-keys">${links.map((l) => html`<li><code>${l.key}</code> <span class="nj-meta">→ <a href="/w/${svc.workspaceId}/services/${l.store}">${l.store}</a> (${l.type === 'postgres' ? 'Postgres' : 'Key Value'})</span>
      <button type="button" class="btn btn-link btn-sm" data-unlink="${l.key}" aria-label="Remove the link ${l.key}">Remove</button></li>`)}</ul>`
      : html`<p class="nj-meta">No data stores linked.</p>`}
    ${usable.length ? html`<form class="nj-link-form" data-link-form novalidate>
        <div><label class="form-label" for="f-link-store">Data store</label>
          <select class="form-select" id="f-link-store" name="store" aria-describedby="links-error">${usable.map((s) => html`<option value="${s.name}" data-type="${s.type}">${s.name} (${s.type === 'postgres' ? 'Postgres' : 'Key Value'})</option>`)}</select></div>
        <div><label class="form-label" for="f-link-key">As</label>
          <input class="form-control nj-mono" id="f-link-key" name="key" value="${DATA_DEFAULTS[usable[0].type].linkKey}" autocomplete="off" spellcheck="false"></div>
        <div class="nj-link-go"><button type="submit" class="btn btn-secondary">Link to service</button></div>
      </form>${feedback('links')}`
      : html`<p class="nj-meta mb-0">${stores.length ? 'None of the workspace\'s data stores is in this service\'s region.' : html`No Postgres or Key Value yet: <a href="/w/${svc.workspaceId}/new/postgres">New Postgres</a> · <a href="/w/${svc.workspaceId}/new/keyvalue">New Key Value</a>.`}</p>`}
    <p class="nj-meta mt-3 mb-0" role="status" data-links-note>The connection string goes in the variable when the service starts; it is not stored with the service. Saving deploys the service again.</p>
  </section>`;
}

/** Binds the card in `root` (the Environment panel); `reload` draws it again with the new links. */
export function bindLinks(root, { svc, base, stores, onChange = () => {} }) {
  let links = (svc.links ?? []).map(({ key, store }) => ({ key, store }));
  const card = () => root.querySelector('[data-links-card]');
  const save = async (next, form) => {
    const note = card().querySelector('[data-links-note]');
    try {
      const r = await api(`${base}/links`, { method: 'PUT', body: { links: next } });
      links = r.links.map(({ key, store }) => ({ key, store }));
      svc.links = r.links;
      card().outerHTML = linksCard(svc, stores);
      card().querySelector('[data-links-note]').textContent = r.redeploying ? 'Saved. The service is deploying again to pick it up.' : 'Saved.';
      onChange(r);
    } catch (err) {
      if (form) showErrors(form.parentElement, err);
      else note.textContent = err.message;
    }
  };
  root.addEventListener('change', (event) => {
    if (event.target.id !== 'f-link-store') return;
    const type = event.target.selectedOptions[0]?.dataset.type;
    const key = root.querySelector('#f-link-key');
    if (key && Object.values(DATA_DEFAULTS).some((x) => x.linkKey === key.value)) key.value = DATA_DEFAULTS[type].linkKey;
  });
  root.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-link-form]');
    if (!form) return;
    event.preventDefault();
    clearErrors(form.parentElement);
    save([...links, { key: form.key.value.trim(), store: form.store.value }], form);
  });
  root.addEventListener('click', (event) => {
    const b = event.target.closest('[data-unlink]');
    if (b) save(links.filter((l) => l.key !== b.dataset.unlink));
  });
}
