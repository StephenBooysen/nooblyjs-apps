// An accelerator's own page in nooblyjs-core's frame: the operator rail's Customers, Marketing and Payments buttons
// (src/platform/accelerators.js EMBEDDED_SCREENS). The page is a same-origin frame filling the content area, and its
// own sidebar does the navigating. Its #route is kept in the address bar, so a reload or a shared link opens the same
// view, and a link inside it to another embedded screen (Customers → Marketing) moves the rail there too.
import { html } from '/ui/js/html.js';

/** App name → its ui description from GET /api/v1/shell: { src, screens: [{ mountPath, src }] }. */
const screens = new Map();

/** Called by the frame once per app that uses this module. */
export function init({ app }) {
  screens.set(app.name, app.ui);
}

export const routes = [{ path: '/', layout: 'full', page: async () => embeddedPage() }];

function embeddedPage() {
  let stop = () => {};
  return {
    render(view, { ctx }) {
      const { src, screens: all = [] } = screens.get(ctx.app.name);
      view.innerHTML = String(html`<h1 class="visually-hidden">${ctx.app.label}</h1><iframe class="hero-embed" src="${src}${location.hash}" title="${ctx.app.label}"></iframe>`);
      const frame = view.querySelector('iframe');

      const keepHash = () => {
        const inner = frame.contentWindow?.location;
        if (!ctx.isCurrent() || inner?.pathname !== src || location.hash === inner.hash) return;
        history.replaceState(history.state, '', `${location.pathname}${location.search}${inner.hash}`);
      };
      const onLoad = () => {
        if (!ctx.isCurrent()) return;
        const inner = frame.contentWindow.location;
        // A link inside that leads to a page of the frame itself (it has a rail of its own): open it in the window.
        if (frame.contentDocument?.getElementById('noobly-shell')) return location.assign(inner.href);
        const other = all.find((s) => s.src === inner.pathname && s.src !== src);
        if (other) return ctx.navigate(`${other.mountPath}${inner.hash}`, { absolute: true });
        keepHash();
        frame.contentWindow.addEventListener('hashchange', keepHash);
      };
      frame.addEventListener('load', onLoad);
      stop = () => {
        frame.removeEventListener('load', onLoad);
        frame.contentWindow?.removeEventListener('hashchange', keepHash);
      };
    },
    destroy() {
      stop();
    },
  };
}
