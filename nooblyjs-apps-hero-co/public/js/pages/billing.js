// Billing (roadmap 7.7; product.md §5): what the workspace pays for (its services and their monthly prices), the next
// invoice as it stands, cards and invoices (with their PDFs), and the details printed on the invoices. The money comes
// from nooblyjs-accel-payments through /api/v1/workspaces/:ws/billing; the next invoice, cards and invoices are drawn
// by its BillingSummary component and a card is added with its CardForm (card-prompt.js). Billing is the Owner's.
import { html, render } from '../html.js';
import { api } from '../api.js';
import { bindForm } from '../forms.js';
import { on } from '../sse.js';
import { statTile, statusPill, emptyState } from '../components/index.js';
import { mountCard, BILLING_SUMMARY } from '../components/card-prompt.js';
import { priceText } from '../shared/catalog.js';

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const head = (workspace) => html`<div class="nj-page-head"><div><p class="nj-breadcrumb">${workspace.name}</p><h1 class="nj-title">Billing</h1>
  <p class="nj-lead">Your plan, usage this period, cards and invoices.</p></div></div>`;

function servicesTable(services) {
  if (!services.length) return emptyState({ icon: 'credit-card', title: 'Nothing to pay for yet', text: 'Starter services, Key Value Starter and Static Sites are free.' });
  return html`<div class="table-responsive"><table class="table nj-billing-services">
    <caption class="visually-hidden">Services and their monthly prices</caption>
    <thead><tr><th scope="col">Service</th><th scope="col">Type</th><th scope="col">Plan</th><th scope="col" class="text-end">Price</th></tr></thead>
    <tbody>${services.map((s) => html`<tr>
      <td><a href="./services/${s.name}">${s.name}</a>${s.suspendedByBilling ? html` ${statusPill('Suspended')}` : ''}</td>
      <td>${s.label}</td>
      <td>${s.planName ?? 'Free'}</td>
      <td class="text-end nj-num">${s.usd ? `${priceText(s.usd)} / mo` : 'Free'}</td>
    </tr>`)}</tbody>
  </table></div>`;
}

function detailsForm(account) {
  const a = account.address ?? {};
  return html`<form novalidate data-form="details" class="nj-billing-details">
    <div class="alert alert-danger" role="alert" tabindex="-1" data-form-alert hidden></div>
    <div class="row g-3">
      <div class="col-md-6"><label class="form-label" for="b-name">Name on invoices</label>
        <input class="form-control" id="b-name" name="name" value="${account.name}" required maxlength="200" aria-describedby="b-name-error"><div class="invalid-feedback" id="b-name-error" data-for="name"></div></div>
      <div class="col-md-6"><label class="form-label" for="b-email">Invoices and receipts go to</label>
        <input class="form-control" id="b-email" name="email" type="email" value="${account.email}" required aria-describedby="b-email-error"><div class="invalid-feedback" id="b-email-error" data-for="email"></div></div>
      <div class="col-md-6"><label class="form-label" for="b-line1">Street address</label>
        <input class="form-control" id="b-line1" name="line1" value="${a.line1 ?? ''}" maxlength="200" aria-describedby="b-line1-error"><div class="invalid-feedback" id="b-line1-error" data-for="address.line1"></div></div>
      <div class="col-md-3"><label class="form-label" for="b-city">City</label>
        <input class="form-control" id="b-city" name="city" value="${a.city ?? ''}" maxlength="200"></div>
      <div class="col-md-3"><label class="form-label" for="b-postal">Postal code</label>
        <input class="form-control" id="b-postal" name="postalCode" value="${a.postalCode ?? ''}" maxlength="200"></div>
      <div class="col-md-3"><label class="form-label" for="b-country">Country</label>
        <input class="form-control" id="b-country" name="country" value="${account.country ?? ''}" maxlength="2" placeholder="ZA" aria-describedby="b-country-hint b-country-error"><div class="form-text" id="b-country-hint">Two letters, such as ZA or US.</div><div class="invalid-feedback" id="b-country-error" data-for="country"></div></div>
      <div class="col-md-5"><label class="form-label" for="b-tax">VAT or tax number</label>
        <input class="form-control" id="b-tax" name="taxId" value="${account.taxId ?? ''}" maxlength="50" aria-describedby="b-tax-error"><div class="invalid-feedback" id="b-tax-error" data-for="taxId"></div></div>
    </div>
    <div class="mt-3 d-flex align-items-center gap-3"><button type="submit" class="btn btn-secondary">Save details</button><span class="nj-meta" role="status" data-details-note></span></div>
  </form>`;
}

function content(workspace, d) {
  const s = d.summary;
  const up = s.upcoming;
  const card = s.methods.find((m) => m.isDefault);
  const paid = d.services.filter((x) => x.usd > 0 && !x.suspendedByBilling).length;
  const warning = d.warning
    ? html`<div class="alert ${d.warning.kind === 'delinquent' ? 'alert-danger' : 'alert-warning'} mb-4" role="alert" data-billing-warning><strong>${d.warning.kind === 'delinquent' ? 'Paid services are suspended.' : 'A payment failed.'}</strong> ${d.warning.message}</div>`
    : '';
  return html`${head(workspace)}
    ${warning}
    <div class="nj-stats mb-4">
      ${statTile({ label: 'Estimated / mo', value: priceText(d.estimateUsd), caption: `${paid} paid service${paid === 1 ? '' : 's'}` })}
      ${statTile({ label: 'This period so far', value: up ? up.amountDue.amount === 0 ? '$0' : formatted(up.amountDue) : '—', caption: up ? `${day(up.period.start)} – ${day(new Date(Date.parse(up.period.end) - 1).toISOString())}` : '' })}
      ${statTile({ label: 'Next invoice', value: up ? day(up.period.end) : '—', caption: 'Charged to the default card' })}
      ${statTile({ label: 'Card', value: card ? `${card.brand[0].toUpperCase()}${card.brand.slice(1)} ${card.last4}` : 'None', caption: card ? `Expires ${String(card.expMonth).padStart(2, '0')}/${card.expYear}` : 'Needed for paid plans' })}
    </div>

    <section class="nj-card mb-4" aria-labelledby="plan-title">
      <h2 class="nj-card-title" id="plan-title">Plan</h2>
      <p class="nj-meta">Each paid service is a flat price a month for 1 to 10 instances, billed by the hour it exists; a suspended service costs nothing. ${d.freeTier}</p>
      ${servicesTable(d.services)}
    </section>

    <section class="nj-card mb-4 nj-billing-summary" aria-label="Next invoice, cards and invoices" data-summary></section>

    <section class="nj-card mb-4" aria-labelledby="card-title">
      <h2 class="nj-card-title" id="card-title">${card ? 'Add another card' : 'Add a card'}</h2>
      <p class="nj-meta">${d.provider.provider === 'mock' ? 'Test mode: no card is charged. 4242 4242 4242 4242 pays; 4000 0000 0000 0341 is saved, then declined.' : 'Cards are kept by our payment provider.'}</p>
      <div data-card-slot><button type="button" class="btn btn-primary" data-add-card>Add a card</button></div>
    </section>

    <section class="nj-card mb-4" aria-labelledby="details-title">
      <h2 class="nj-card-title" id="details-title">Billing details</h2>
      <p class="nj-meta">Printed on your invoices. A VAT number and country make them tax invoices.</p>
      ${detailsForm(s.account)}
    </section>`;
}

let money = null;
const formatted = (m) => (money ? money(m) : `$${(m.amount / 100).toFixed(2)}`);

export async function billingPage({ workspace }) {
  if (workspace.role !== 'Owner') {
    return {
      title: `Billing · ${workspace.name}`,
      content: html`${head(workspace)}${emptyState({ icon: 'credit-card', title: 'Billing is the owner\'s', text: 'Only the workspace owner sees invoices and manages cards. Ask them if you need a receipt.' })}`,
    };
  }
  const [{ renderBillingSummary, formatMoney }, data] = await Promise.all([import(BILLING_SUMMARY), api(`/api/v1/workspaces/${workspace.id}/billing`)]);
  money = formatMoney;
  let d = data;
  const base = `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/billing`;
  return {
    title: `Billing · ${workspace.name}`,
    content: content(workspace, d),
    mount(root) {
      const main = root.querySelector('#main') ?? root;
      let cardForm = null;
      const draw = () => {
        cardForm?.destroy?.();
        cardForm = null;
        render(main, content(workspace, d));
        bind();
      };
      const reload = async () => {
        d = await api(base);
        draw();
      };
      const toast = (text) => {
        const note = main.querySelector('[data-details-note]');
        if (note) note.textContent = text;
      };
      function bind() {
        renderBillingSummary(main.querySelector('[data-summary]'), d.summary, {
          headingLevel: 2,
          pdfHref: (i) => i.pdfUrl,
          onPay: async (inv) => {
            let error = null;
            try {
              await api(`${base}/invoices/${encodeURIComponent(inv.id)}/pay`, { method: 'POST', body: {} });
            } catch (err) {
              error = err.message;
            }
            d = await api(base);
            d.payError = error;
            draw();
          },
          onMakeDefault: async (m) => {
            await api(`${base}/cards/${encodeURIComponent(m.id)}/default`, { method: 'POST', body: {} });
            await reload();
          },
          onRemove: async (m) => {
            try {
              await api(`${base}/cards/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
              await reload();
            } catch (err) {
              const box = main.querySelector('[data-summary]');
              const p = Object.assign(document.createElement('p'), { className: 'alert alert-warning mt-3 mb-0', textContent: err.message });
              p.setAttribute('role', 'alert');
              box.append(p);
            }
          },
        });
        if (d.payError) {
          const p = Object.assign(document.createElement('p'), { className: 'alert alert-danger mt-3 mb-0', textContent: d.payError });
          p.setAttribute('role', 'alert');
          main.querySelector('[data-summary]').prepend(p);
          d.payError = null;
        }
        const slot = main.querySelector('[data-card-slot]');
        main.querySelector('[data-add-card]')?.addEventListener('click', async () => {
          cardForm = await mountCard(slot, {
            workspaceId: workspace.id,
            onSaved: () => reload(),
            onCancel: () => draw(),
          });
        });
        bindForm(main.querySelector('[data-form="details"]'), {
          path: `${base}/details`,
          method: 'PATCH',
          busy: 'Saving…',
          body: (v) => ({ name: v.name, email: v.email, country: v.country.trim() || null, taxId: v.taxId, address: { line1: v.line1, city: v.city, postalCode: v.postalCode } }),
          done: (result) => {
            d = result;
            draw();
            toast('Saved.');
          },
        });
      }
      bind();
      // Invoices, payments and suspensions arrive on the workspace's live channel.
      const stop = on('billing', () => { if (!cardForm) reload().catch(() => {}); });
      return () => {
        stop();
        cardForm?.destroy?.();
      };
    },
  };
}
