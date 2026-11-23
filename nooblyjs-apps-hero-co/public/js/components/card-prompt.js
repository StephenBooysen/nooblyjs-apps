// The card form (roadmap 7.6, 7.7): the payments accelerator's CardForm with this app's session, on the Billing page and
// in the *Add a card* prompt a paid plan opens when the workspace has no card (402 card_required). The card number goes
// to the provider's hosted fields (a frame), never through our pages or API.
import { api } from '../api.js';

export const CARD_FORM = '/admin/payments/components/card-form.js';
export const BILLING_SUMMARY = '/admin/payments/components/billing-summary.js';

/**
 * Mounts the card form in `root`.
 * @param {HTMLElement} root
 * @param {{ workspaceId: string, onSaved?: (card: object) => void, onCancel?: () => void, save?: string }} o
 * @returns {Promise<{ destroy(): void }>}
 */
export async function mountCard(root, { workspaceId, onSaved, onCancel, save = 'Save card' }) {
  const { mountCardForm } = await import(CARD_FORM);
  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/cards`;
  return mountCardForm(root, {
    setup: () => api(base, { method: 'POST', body: {} }),
    confirm: async (setupId) => (await api(`${base}/${encodeURIComponent(setupId)}/confirm`, { method: 'POST', body: {} })).card,
    onSaved,
    onCancel,
    labels: { save },
    classes: { save: 'btn btn-primary', cancel: 'btn btn-secondary', frame: 'nj-card-frame' },
  });
}

/**
 * The *Add a card* prompt: a dialog with the card form. Resolves true once a card is saved (the caller then tries
 * again), false when closed. A Member is told the Owner adds cards (product.md §7).
 * @param {{ workspaceId: string, message: string, owner?: boolean }} o
 */
export function cardPrompt({ workspaceId, message, owner = true }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'nj-dialog';
    dialog.setAttribute('aria-labelledby', 'card-prompt-title');
    const title = Object.assign(document.createElement('h2'), { id: 'card-prompt-title', className: 'nj-card-title', textContent: 'Add a card' });
    const text = Object.assign(document.createElement('p'), { className: 'nj-meta', textContent: message });
    const body = document.createElement('div');
    dialog.append(title, text, body);
    let saved = false;
    let form = null;
    const close = () => dialog.close();
    dialog.addEventListener('close', () => {
      form?.destroy?.();
      dialog.remove();
      resolve(saved);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    if (!owner) {
      const p = Object.assign(document.createElement('p'), { textContent: 'Only the workspace owner adds cards. Ask them to add one on the Billing page, then try again.' });
      const ok = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-secondary', textContent: 'Close' });
      ok.addEventListener('click', close);
      body.append(p, ok);
      return;
    }
    mountCard(body, { workspaceId, save: 'Save card and continue', onSaved: () => { saved = true; close(); }, onCancel: close })
      .then((f) => { form = f; })
      .catch(() => {
        body.textContent = 'The card form could not load. Open Billing to add a card.';
      });
  });
}

/** The workspace id of the page we are on (/w/:workspace/...), or null. */
export const workspaceOfPage = () => /^\/w\/([^/]+)/.exec(window.location.pathname)?.[1] ?? null;
