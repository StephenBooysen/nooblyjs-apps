// The back office (/admin) in nooblyjs-core's frame: the accelerators NooblyJS Cloud runs on, in the rail's order,
// each with its state and a way in (src/platform/accelerators.js describe()).
import { html } from '/ui/js/html.js';
import { pageHead, statusPill, button } from '/ui/js/components/index.js';

export const routes = [{ path: '/', title: 'Back office', nav: 'overview', page: async () => backOffice }];

const backOffice = {
  async render(view, { ctx }) {
    const { items } = await ctx.hostApi.get('admin/accelerators');
    if (!ctx.isCurrent()) return;
    view.innerHTML = String(html`${pageHead({ eyebrow: 'Operator', title: 'Back office', lead: 'The accelerators NooblyJS Cloud runs on. Open one from the rail on the left or below. Customers never see these screens.' })}
      <div class="grid">${items.map(acceleratorCard)}</div>`);
  },
};

function acceleratorCard(a) {
  const live = a.state === 'mounted';
  const meta = live ? `Mounted${a.version ? ` · v${a.version}` : ''}` : a.reason;
  return html`<section class="card hero-accelerator" aria-label="${a.label}">
    <div class="card__head"><h2 class="card__title">${a.label}</h2>${statusPill({ text: live ? 'Live' : 'Not installed', tone: live ? 'success' : 'neutral' })}</div>
    <p class="card__meta">${meta}</p>
    ${live ? html`<div class="actions">${button({ label: `Open ${a.label}`, kind: 'secondary', small: true, href: a.href })}</div>` : ''}
  </section>`;
}
