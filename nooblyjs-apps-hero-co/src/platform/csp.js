// The Content-Security-Policy (roadmap 8.7.6; the audit's S2). core's policy allows the whole of jsDelivr and unpkg
// (every npm package) and Google Tag Manager in script-src, so an HTML injection anywhere could run any script on our
// origin. This one names each third-party file instead, and only where a page loads it:
//
//   strict     hero-co's own pages (Billing among them), the hosted checkout, the marketing preference pages, the
//              infrastructure accelerator and core's frame: scripts from this origin only (and Stripe's, when Stripe
//              takes the cards).
//   operator   nooblyjs-core's pages under /services (its sign-in page among them) and the customers accelerator's
//              screens under /admin: also the exact third-party files they load (THIRD_PARTY), never a whole host.
//
// hero-co's own page loads Bootstrap from public/vendor/. The files left in THIRD_PARTY are core's and the
// accelerators' views; the follow-up is theirs (roadmap 8.7.6, [core] [accl]).
import helmet from 'helmet';
import { CX_PUBLIC } from './accelerators.js';

const JSDELIVR = 'https://cdn.jsdelivr.net/npm';

/**
 * Every third-party file a page of ours may load: where it is, what for, and which policy allows it. A path that ends
 * in / allows the files under it (the icon font's folder); any other is that one file.
 */
export const THIRD_PARTY = [
  { kind: 'script', url: `${JSDELIVR}/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js`, policy: 'operator', use: 'core\'s pages (sign-in, the services portal) and the customers accelerator\'s screens' },
  { kind: 'script', url: `${JSDELIVR}/chart.js@4.4.0/dist/chart.umd.min.js`, policy: 'operator', use: 'core\'s service dashboards' },
  { kind: 'script', url: `${JSDELIVR}/chart.js@4.4.0/dist/chart.umd.js`, policy: 'operator', use: 'core\'s workflow dashboard' },
  { kind: 'script', url: 'https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui-bundle.js', policy: 'operator', use: 'core\'s API docs' },
  { kind: 'style', url: 'https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui.css', policy: 'operator', use: 'core\'s API docs' },
  { kind: 'style', url: `${JSDELIVR}/bootstrap@5.3.3/dist/css/bootstrap.min.css`, policy: 'strict', use: 'core\'s and the accelerators\' pages (the marketing preference page, the hosted checkout)' },
  { kind: 'style', url: `${JSDELIVR}/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css`, policy: 'strict', use: 'core\'s and the accelerators\' pages (the hosted checkout)' },
  { kind: 'font', url: `${JSDELIVR}/bootstrap-icons@1.11.3/font/fonts/`, policy: 'strict', use: 'the icon font of the stylesheet above' },
  { kind: 'style', url: 'https://fonts.googleapis.com', policy: 'strict', use: 'the theme\'s typefaces (stylesheets only)' },
  { kind: 'font', url: 'https://fonts.gstatic.com', policy: 'strict', use: 'the theme\'s typefaces' },
];

/** Stripe's origins, when Stripe takes the cards: its script, the Payment Element's and 3-D Secure frames, its API. */
const STRIPE = { script: ['https://js.stripe.com'], frame: ['https://js.stripe.com', 'https://hooks.stripe.com'], connect: ['https://api.stripe.com'] };

/** Pages under /admin that customers open: the marketing preference pages and the hosted checkout. */
const CUSTOMER_PAGES = [`${CX_PUBLIC}/`, '/admin/payments/p/'];

/** Which policy a request's page gets. */
export function policyFor(pathname) {
  if (pathname.startsWith('/services/')) return 'operator';
  if (pathname.startsWith('/admin/') && !CUSTOMER_PAGES.some((p) => pathname.startsWith(p))) return 'operator';
  return 'strict';
}

/**
 * helmet's directives for one policy.
 * @param {'strict'|'operator'} policy
 * @param {{ payProvider?: string, cspExtraSources?: string[] }} config
 */
export function directivesFor(policy, config = {}) {
  const extra = config.cspExtraSources ?? [];
  const stripe = config.payProvider === 'stripe';
  const allowed = (kind) => THIRD_PARTY.filter((f) => f.kind === kind && (f.policy === 'strict' || policy === 'operator')).map((f) => f.url);
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", ...allowed('script'), ...(stripe ? STRIPE.script : []), ...extra],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", ...allowed('style'), ...extra],
    fontSrc: ["'self'", 'data:', ...allowed('font')],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:', ...extra],
    connectSrc: ["'self'", ...(stripe ? STRIPE.connect : []), ...extra],
    frameSrc: ["'self'", ...(stripe ? STRIPE.frame : [])],
    workerSrc: ["'self'", 'blob:'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
    // Plain-HTTP deployments (local, behind some proxies) would break if sub-resources were forced to https://; HSTS
    // covers HTTPS deployments.
    upgradeInsecureRequests: null,
  };
}

/**
 * The CSP middleware: each page's policy (policyFor). CSP_MODE=report-only reports without blocking; off sends none
 * (refused in production: src/config.js productionProblem).
 * @param {{ cspMode?: string, payProvider?: string, cspExtraSources?: string[] }} config
 */
export function contentSecurityPolicy(config = {}) {
  const mode = config.cspMode ?? 'enforce';
  if (mode === 'off') return (req, res, next) => next();
  const reportOnly = mode === 'report-only';
  const policies = {
    strict: helmet.contentSecurityPolicy({ useDefaults: false, directives: directivesFor('strict', config), reportOnly }),
    operator: helmet.contentSecurityPolicy({ useDefaults: false, directives: directivesFor('operator', config), reportOnly }),
  };
  return (req, res, next) => policies[policyFor(req.path)](req, res, next);
}
