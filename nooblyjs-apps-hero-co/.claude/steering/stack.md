---
inclusion: always
type: Steering
title: NooblyJS Cloud — Stack
description: What NooblyJS Cloud is built with, how nooblyjs-core and the two accelerators fit underneath it, and the rules every change follows.
tags: [hero-co, nooblyjs-cloud, steering, stack]
---

# NooblyJS Cloud — Stack

> **Status:** Draft v1 · 2026-11-19, revised the same day: the theme is `nooblyjs/styling/styles.css`, every
> accelerator mounts with `mount()`, payments come from `nooblyjs-accel-payments`. What is built is `product.md`; the order is `roadmap.md`. Checked against
> `nooblyjs-core` 2.0.0, `nooblyjs-accelerator-infrastructure` 0.2.0 (roadmap phase 2, mock cloud only) and
> `nooblyjs-accel-customers` 0.3.0 (marketing MVP) on 2026-11-19; `nooblyjs-accel-payments` is new (steering, spec and
> roadmap only). Their own docs win on how they work inside:
> `nooblyjs-core/CLAUDE.md`, `nooblyjs-accl/.claude/steering/infrastructure-*.md`,
> `nooblyjs-accl/.claude/spec/customer-accelerator-*.md`, `nooblyjs-accl/nooblyjs-accel-payments/.claude/steering/`.

---

## 1. The stack at a glance

| Layer | Choice | Not allowed |
| --- | --- | --- |
| Runtime | Node.js ≥ 22.12 (run on 24 LTS in Docker and CI), **ES modules** (`"type": "module"`) | CommonJS in new code. `package.json` is still `commonjs` and is changed in Phase 0. |
| Server | Express 5, one app owned by this repo; JSON APIs under `/api/v1`; **Server-Sent Events** for live logs, metrics and deploy progress | GraphQL, WebSockets, Next/Nest/Fastify |
| Engineering base | **nooblyjs-core** `ServiceRegistry`: authservice, logging, caching, queueing, scheduling, working, workflow, measuring, notifying, searching, filing, dataservice; `FsStore`; `createServer`, `safeError`, `validation`, CSP helpers | Re-implementing any core service in this repo |
| Control plane | **nooblyjs-accl-infrastructure** via `mount()`: provider contract (mock → GCP/AWS), operations engine, VMs, deploy-from-Git, Caddy endpoints, buckets, cost catalogue, activity | Calling a cloud SDK from this repo; bypassing its operations engine |
| Customer back office | **nooblyjs-accel-customers** via `mount()`: `customer` and `marketing` modules (customer 360, consent, audit, transactional email) | Our own CRM tables; sending email outside its send pipeline |
| Billing | **nooblyjs-accel-payments** via `mount()`: plans, metered usage, subscriptions, invoices, card capture, dunning, refunds, ledger | Card data on our servers; our own invoice or proration logic |
| Browser | Plain HTML + native ES modules, **Bootstrap 5.3.3** and **Bootstrap Icons 1.11.3** from jsDelivr, the NooblyJS theme `styles.css` (verbatim copy of `nooblyjs/styling/styles.css`), `.nj-` components in `hero-co.css` (§5) | React, TypeScript, bundlers, Tailwind, any other CSS framework; hex values in components |
| Charts | Inline SVG drawn by one small local module (`public/js/charts.js`): area, stacked bar, meter | Chart libraries from a CDN |
| Fonts | Bricolage Grotesque and Figtree from Google Fonts (the theme's `@import`); JetBrains Mono added the same way in `hero-co.css` | Inter, Roboto, Arial |
| Records | Repositories over core **dataService** (`file` in dev and tests, `mongodb` in production); the infrastructure accelerator keeps its own FsStore under `<DATA_DIR>/infrastructure` | SQLite, ORM layers, a second store of record |
| Secrets | Env vars and customer secrets encrypted AES-256-GCM (same approach as the infrastructure accelerator's `secrets.js`, key from `HERO_SECRET_KEY` → `SETTINGS_SECRET` → `SESSION_SECRET`) | The core **settings** service for customer secrets (it reveals values over HTTP) |
| Tests | `node:test` + `node:assert`, offline on the mock cloud; Playwright for screens (desktop + phone width) | Jest/Mocha/Vitest in this repo (the accelerators keep theirs) |
| Source control | GitHub REST API over `fetch` + webhooks (HMAC verified) | GitHub SDKs; GitLab/Bitbucket in v1 |

**No build step.** `npm start` runs the source as written. Dependencies stay minimal: `express`, `nooblyjs-core`,
the three accelerators as `file:` links, plus a reason in the PR for anything else.

## 2. Where it sits

```
/workspaces/codespaces-blank/
├── nooblyjs/styling/styles.css          the NooblyJS theme (copied verbatim into public/css/)
├── nooblyjs-core/                       engineering base (separate repo)
├── nooblyjs-accl/                       accelerators monorepo
│   ├── nooblyjs-accl-infrastructure/    Noobly Cloud: VMs, deploys, endpoints, buckets; phase 8 platform hosting (ESM, mount())
│   ├── nooblyjs-accel-customers/        customers, consent, marketing comms (CommonJS, mount())
│   └── nooblyjs-accel-payments/         plans, usage, invoices, cards, dunning (ESM, mount(); new)
└── nooblyjs-apps/                       git repo
    └── nooblyjs-apps-hero-co/           ← this app: NooblyJS Cloud
```

`package.json` dependencies (Phase 0):

```json
"nooblyjs-core": "file:../../nooblyjs-core",
"nooblyjs-accelerator-infrastructure": "file:../../nooblyjs-accl/nooblyjs-accl-infrastructure",
"nooblyjs-accel-customers": "file:../../nooblyjs-accl/nooblyjs-accel-customers",
"nooblyjs-accel-payments": "file:../../nooblyjs-accl/nooblyjs-accel-payments"
```

## 3. How the three foundations are used

### 3.1 nooblyjs-core

| Core service | Used for in NooblyJS Cloud | Provider (dev → prod) |
| --- | --- | --- |
| `authservice` | Email + password sign-up and sessions; GitHub sign-in through the `passport` provider (`passport-github2`); personal API tokens for the CLI later | `file` → `passport` + Redis session store |
| `logging` | App logs (not customer logs, see §4.3) | `file` → `file` + stdout |
| `queueing` | Build jobs, deploy fan-out, log batches, webhook events | `memory` → `redis` |
| `scheduling` | Not used for Cron Jobs: see D10 (`src/scheduling/cron.js`); metric flushes and the hourly log sweep are timers in `src/telemetry/` (D9) | `memory` |
| `working` | Build workers off the request path | `default` |
| `workflow` | Not used for Workflow services: see D11 (`src/scheduling/tasks.js`); kept for multi-step onboarding | `memory` + `exportState()` persisted by us |
| `measuring` | Not used for metric history: see D9 (`src/telemetry/metrics.js`) | `default` |
| `caching` | Dashboard summaries, GitHub repo lists, session store | `memory` → `redis` |
| `notifying` | Internal topics (`deploy.*`, `service.*`) and outbound webhooks | `memory` |
| `searching` | Repo search; log search scans instead (D9) | `memory` |
| `filing` | Metric history and log archives (D9). Static site files are the platform's, not ours (D12) | `local` → `s3`/`gcp` |
| `dataservice` | Workspaces, projects, environments, services, deploys, plans, usage | `file` → `mongodb` |

Rules from core apply here unchanged: `ClientError` + `sendSafeError` for errors, `validate()` + `parseLimit` for
input, route permissions declared up front, the CSP from `contentSecurityPolicy.js` (no inline styles or scripts;
clicks through `data-onclick`), injected logger with structured metadata.

### 3.2 nooblyjs-accl-infrastructure (the control plane)

Mounted **for operators only** at `/infrastructure` (the accelerator takes a single-segment `mountPath`) with `mount(app, eventEmitter, serviceRegistry, { mountPath,
dataDir, host, platform: { enabled: true } })`. Its events (`infrastructure.deploy.*`, `infrastructure.instance.*`,
`infrastructure.telemetry.*`) arrive on our shared `eventEmitter`. This repo builds the `host` object (auth, `requireRole`, audit, events, store, people, frame) in
`src/platform/host.js` rather than using `createDevLauncher()`, which refuses production. Its people are the operators
from the accounts store.

What NooblyJS Cloud takes from it:

| Capability | How we use it |
| --- | --- |
| Cloud accounts + provider contract | The operator's GCP project / AWS account per region; customers never see clouds |
| VMs (launch, health, SSH runner, cloud-init with Docker) | The **fleet**: hosts in each region that run customer containers |
| Operations engine (queued steps, per-resource locks, crash recovery) | Every build, deploy, restart, suspend and scale is an operation |
| `app.deploy` (clone → build → start → health check → switch, blue/green) | The deploy pipeline for Web, Private, Worker services (extended for buildpacks, §4.1) |
| Caddy endpoints + Let's Encrypt | `*.nooblyjs.app` (wildcard cert) and custom domains |
| Buckets | Static site storage; build artefacts; log archives; Postgres backups |
| Cost catalogue + hourly cost snapshots | Our **cost** side; customer **prices** are our own plan table |
| Activity + audit | Operator activity; customer-facing deploy history is ours |

Gaps for a multi-tenant host are closed **in the accelerator**, in its roadmap **phase 8 — Platform hosting**, one spec
each in `nooblyjs-accl/nooblyjs-accl-infrastructure/.claude/specs/`: 8.1 platform API and workloads (the in-process
`services.platform` this repo calls), 8.2 containers on shared hosts with limits and tenant networks, 8.3 builds and
the registry, 8.4 ingress, `*.nooblyjs.app` and rolling deploys, 8.5 per-instance telemetry and logs, 8.6 Postgres,
8.7 Key Value, 8.8 static sites on a CDN. Mount it with `platform: { enabled: true }`. Sandbox isolation stays
open (`product.md` §11).

### 3.3 nooblyjs-accel-customers (the back office)

Mounted at `/admin/customers` with `mount(app, eventEmitter, serviceRegistry, { modules: ['customer', 'marketing'],
basePath: '/admin', containerPrefix: 'cx', tenancy: { enabled: false }, auth: { roleResolver } })`.

| Capability | How we use it |
| --- | --- |
| `customers:upsert` by identity (`nooblyjs-cloud:<personId>`), organisations | Every sign-up creates/links a customer and its organisation (the workspace) |
| Consent ledger | The sign-up form's email consent; `canContact()` gates every message |
| Notes, timeline, audit | Support history; our deploy and billing events added with `registerTimelineProvider` |
| `sendTransactional` + templates + suppressions | Welcome, verify email, password reset, deploy failed, free tier exceeded, card needed |
| Roles `admin`, `data-steward`, `marketer`, `agent`, `readonly` | Operator staff only; customers never reach these UIs |

Notes: it is CommonJS and mounts its own Express 4 routers; we load it with `import customers from
'nooblyjs-accel-customers'` and prove it mounts on our Express 5 app in Phase 0. Its mount result is passed to the
payments accelerator (`customers: cx`) so invoices and payment emails go through its consent pipeline. With the `file` data provider set
`marketing.dispatch.concurrency: 1` (its README explains why). Its UIs load Bootstrap and `styles.css`; they are
operator screens and keep their own look.

### 3.4 nooblyjs-accel-payments (billing)

Mounted with `mount(app, eventEmitter, serviceRegistry, { modules: ['payments', 'billing', 'reporting'], basePath:
'/admin', containerPrefix: 'pay', provider, customers: cx, currency, tax, dunning, auth: { roleResolver } })`.

| Capability | How we use it |
| --- | --- |
| `ensureAccount({ externalRef: workspaceId })` | A billing account per workspace, created on sign-up |
| Catalogue (products, prices, meters) | The plan table (Free → Pro Plus) and meters `cpu_hours`, `memory_gb_hours`, `bandwidth_gb`; the Summary's *Estimated / mo* reads these prices |
| `recordUsage()` | Hourly, from the infrastructure accelerator's `services.platform.usage()` (its spec 8.5) |
| `CardForm`, `BillingSummary` components | The Billing page and the *Add a card* prompt when the free tier is exceeded |
| `pay.invoice.*`, `pay.payment.failed`, `pay.account.delinquent` events | Banners, suspension after the final dunning attempt |
| Operator UI at `/admin/payments/` | Finance and support staff |

### 3.5 One entry point

Every accelerator mounts the same way, `mount(app, eventEmitter, serviceRegistry, options)`, and returns an object
with `shutdown()` (decided 2026-11-19; the infrastructure accelerator moved from `register()`). `src/platform/
accelerators.js` mounts all three in order (customers → payments → infrastructure), builds the infrastructure
accelerator's `host`, and shuts them down in reverse.

## 4. What this repo builds

### 4.1 Domain

`workspace → project → environment → service → deploy / instance`, plus `envGroup`, `githubConnection`, `plan`,
`usage`, `invoice`. A **service** has a `type` (one of the nine), `source` (repo, branch, root dir), `build` (runtime,
build/start commands), `plan`, `instances`, `region`, `env`, `autoDeploy`, `status`.

**Builds, placement and rollout** are the infrastructure accelerator's (phase 8: 8.2 placement on shared hosts,
8.3 runtime templates for Node 22 / Python 3.12 / Go 1.23 and the registry, 8.4 rolling deploys). This repo turns a
service into a workload spec (`services.platform.workloads.create(workspaceId, spec)`), maps plan names to
`{ cpu, memoryMb }`, and follows the operation through events. Postgres and Key Value services map to
`services.platform.databases` / `services.platform.keyvalue` (8.6, 8.7); Static Sites to `static` workloads (8.8).
Cron Jobs and Workflows both run as `job` workloads through `services.platform.workloads.runJob()`: a Cron Job from
our minute scheduler (D10), a Workflow's task runs from our queue (D11), side by side up to the job's `concurrency`.

### 4.1a Accounts (built in Phase 1)

- **Records** (`src/platform/accounts.js`, core dataService `file` → `mongodb`): `hero_people`, `hero_workspaces`,
  `hero_memberships`, `hero_projects`, `hero_environments`, `hero_invitations`, `hero_tokens`. Workspace ids are URL
  slugs from the team name (`acme`, `acme-2`), fixed when renamed. Tokens and invitations store only a SHA-256 hash.
- **Credentials**: core `authservice` (`file` under `<DATA_DIR>/auth`) holds passwords; the person is found by email.
  The product's rule (12+ characters with a number) replaces core's on the instance (roadmap Phase 1 follow-up [core]).
- **Sessions** (`src/platform/session.js`): `express-session` cookie `hero.sid` (HttpOnly, SameSite=Lax, Secure in
  production) on core's `createSessionStore` (memory, or Redis with `REDIS_URL`); a new session id at every sign-in;
  a per-person `sessionEpoch` that a password reset bumps, signing out every other session. CSRF: double-submit
  `noobly.csrf` or a same-origin Origin, on every cookie write and on the sign-in forms.
- **GitHub sign-in** (`src/platform/auth.js`): `passport-github2` with `read:user,user:email`; the primary verified
  email links to an existing account. Without `GITHUB_CLIENT_ID` outside production it talks to the mock at
  `/dev/github`.
- **Gates**: `requireWorkspace` (non-members get a 404) on every `/w/:workspace` page and `/api/v1/workspaces/:workspace`
  route; `requireOwner` for members, invitations and rename; core's `/services` portal for platform operators only.
- **Customers link** (`src/platform/customers-link.js`): identity `nooblyjs-cloud:<personId>`, an organisation per
  workspace, the sign-up checkbox on the consent ledger (`source: form`, the checkbox text as evidence), and the
  `cloud-*` transactional templates (created and approved at start if missing; operators may edit them).
- **Development**: `/dev/login`, the `X-Dev-Person` header and the people in `people.js` (password
  `development-only-1`) exist only when `NODE_ENV` is not production. Operators: `node app.js --operator <email> <role>`.

### 4.2 Live data

- Deploy progress: `infrastructure.deploy.*` events on our `eventEmitter` → our deploy records → SSE.
- Metrics: `services.platform.telemetry.subscribe({ onMetrics })` (8.5, every 10 s per instance) →
  `src/telemetry/metrics.js` → raw for 1 h, minute roll-ups for 24 h, hour roll-ups for 30 days, saved through
  `filing` (`<DATA_DIR>/telemetry/metrics/<workspace>/<service>.json`, flushed every minute) → charts (at most 240
  points). Requests, 5xx and bytes out come from our proxy (`src/routes/proxy.js` `onRequest`). History is ours; the
  accelerator keeps 15 minutes. Live: a `metrics` event per service at most every 5 s.
- Plan limits are part of every metric payload (`{ value, unit, limit }`), because the UI never shows a bare number.
- Usage: hourly `services.platform.usage()` → payments `recordUsage()`.

### 4.3 Customer logs

`services.platform.telemetry.subscribe({ onLogs })` (8.5; one line per event, tagged with workspace, service and
instance, within 3 s) → `src/telemetry/logs.js` → (a) live fan-out over SSE (`log` events), (b) NDJSON chunks per
service per minute in `filing` (`<DATA_DIR>/telemetry/logs/<workspace>/<service>/<minute>-<id>.ndjson`), swept hourly
after the plan's retention (3 / 7 / 14 / 30 days), (c) search by scanning the chunks in the asked window, newest
first (D9). A deploy's build and rollout lines join as level `build` when it ends. Levels are parsed from JSON or
logfmt `level`, `[TAG]` or a leading word (`INFO`, `WARN`, `ERROR`, `DEBUG`…); stderr without one is an error.

### 4.4 Layout

```
nooblyjs-apps-hero-co/
├── app.js                 Express app: core registry, the three accelerators, our routers, SSE, CSP
├── src/
│   ├── platform/          accelerators.js (mounts the three accelerators + the infrastructure host object), workloads.js (service → workload spec)
│   ├── domain/            workspaces, projects, environments, services, deploys, env-groups
│   ├── github/            app/OAuth, repos, webhooks
│   ├── telemetry/         index.js (subscribe, live events), metrics.js (roll-ups), logs.js (chunks, search, retention)
│   ├── billing/           usage hand-off to payments, free-tier checks, Billing page API
│   ├── routes/            /api/v1/*, /hooks/github, /events (SSE)
│   └── seed/              the seed story (product.md §9)
├── public/
│   ├── css/               styles.css (verbatim theme copy), hero-co.css
│   └── js/                router.js, api.js, sse.js, charts.js, components/, pages/
├── test/                  node:test (unit, API, accelerator mount), ui/ (Playwright)
└── .claude/steering/      product.md, stack.md, roadmap.md, ui/
```

## 5. Styling

The theme is **`/workspaces/codespaces-blank/nooblyjs/styling/styles.css`**: the NooblyJS design system's Bootstrap 5
theme (tokens, type, buttons, cards, forms, badges, pills, chips, alerts, tables, progress, navbar, modals). nooblyjs-core
(`src/views/css/styles.css`) and the customers accelerator (`src/shared/views/css/styles.css`) carry identical copies.

- **Load order on every page:** Bootstrap 5.3.3 CSS (jsDelivr) → Bootstrap Icons 1.11.3 (jsDelivr) →
  `/css/styles.css` (verbatim copy of the theme; re-copy to update, never edit) → `/css/hero-co.css`. The theme pulls
  Bricolage Grotesque and Figtree from Google Fonts with `@import`.
- **CSP:** use core's `contentSecurityPolicy.js`, which already allows `cdn.jsdelivr.net`, `fonts.googleapis.com` and
  `fonts.gstatic.com`; add the payment provider's domains for the card form (payments spec §10).
- **Token names.** The style guide writes `--nj-<name>`; the theme defines them without the prefix. Use the theme's
  names: `--nj-bg` → `--bg`, `--nj-surface` → `--surface`, `--nj-surface-sunken` → `--surface-sunken`,
  `--nj-hover` → `--divider`, `--nj-border(-strong)` → `--border(-strong)`, `--nj-ink(-2)` → `--ink(-2)`,
  `--nj-muted` → `--muted`, `--nj-on-ink(-muted)` → `--on-ink(-muted)`, `--nj-accent` → `--accent`,
  `--nj-accent-hover` → `--accent-link`, `--nj-accent-soft/-tint/-light` → `--accent-soft/-tint/-light`,
  `--nj-teal(-soft)` → `--teal(-soft)`, teal text → `--teal-text`, `--nj-warning-soft`/text → `--warn-soft`/`--warn-ink`,
  `--nj-danger-soft`/text → `--danger-soft`/`--danger-ink`, `--nj-neutral-soft`/text → `--neutral-soft`/`--neutral-text`.
- **Where the theme and the style guide differ** (the theme wins; raise it with the design team if it matters):
  warning soft `#FBEFC4` vs `#FBEFD2`, warning text `#6B4E00` vs `#6E4A0E`, danger soft `#FADDE2` vs `#F8DADD`, danger
  text `#8A1F35` vs `#7D1A26`; the theme's mono font is the system stack, not JetBrains Mono.
- **What the theme does not have**, added in `public/css/hero-co.css` with the theme's tokens only: JetBrains Mono
  (Google Fonts `@import`) for IDs, commits, URLs and logs; dark mode (`[data-bs-theme="dark"]` values for each token,
  after light mode ships); the `.nj-` components the mock-ups use (stat tile, meter, option card, repo row, instance
  tile, log viewer, status pill, stepper, sticky summary); the style guide's radius scale where it differs.
- The style guide's **Never** list is a review checklist: no gradients, no emoji, no coloured left borders on cards,
  no pure white page ground, no Inter/Roboto/Arial, no saturated fills behind text.
- Accessibility: WCAG 2.2 AA, 44 px targets, the 2 px persimmon focus outline, status in words as well as colour,
  `prefers-reduced-motion`, works at phone width.

## 6. Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `11010`) |
| `DATA_DIR` | Records and accelerator data (default `./.application`) |
| `SESSION_SECRET`, `HERO_SECRET_KEY` | Sessions; encryption of env vars and tokens (required in production) |
| `PUBLIC_URL`, `APP_DOMAIN` | Our base URL; the customer domain (`nooblyjs.app`) |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub connect and sign-in (sign-in uses the OAuth app's client id and secret; callback `<PUBLIC_URL>/auth/github/callback`) |
| `DEV_SIGN_IN` | `0` turns the development sign-in off outside production (it is always off in production) |
| `INFRA_PROVIDERS`, `INFRA_*` | Passed through to the infrastructure accelerator (`mock` until its phase 2 adapters land) |
| `REDIS_URL`, `MONGODB_URL` | Production providers for queueing/caching/sessions and dataService |
| `SMTP_URL`, `CX_TRACKING_SECRET` | Transactional email through the customers accelerator |
| `PAY_PROVIDER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYSTACK_SECRET_KEY` | The payments accelerator's provider (`mock` until set) |
| `INFRA_PLATFORM_DOMAIN`, `INFRA_PLATFORM_DNS_ZONE` | `nooblyjs.app` and its DNS zone, for the accelerator's ingress (spec 8.4) |
| `HERO_LOCAL_POSTGRES_URL` | An admin connection string to the Postgres server the Local network's databases live on (`postgres://postgres:<password>@127.0.0.1:5432/postgres`; D13). Only from the environment, never a file of ours. Without it the Local network offers no Postgres |

## 7. Commands

```bash
npm start            # app.js on :11010
npm run dev          # nodemon over src/ and public/
npm run seed         # the seed story; -- --reset to start again
node app.js --operator <email> <platform|support|none>   # grant or remove an operator role
npm test             # node:test, offline, mock cloud
npm run test:ui      # Playwright, desktop + phone
```

## 8. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | ESM, Express 5, no build step | Matches the infrastructure and payments accelerators and the NooblyJS apps; core and all three accelerators load from ESM. |
| D2 | Infrastructure accelerator is an internal control plane, not a customer screen | Its product is IaaS for one team (VMs, clouds); ours is PaaS for many tenants. |
| D3 | Customers accelerator is the operator's back office | It owns customer records, consent and comms; customers sign in through core auth. |
| D4 | Every service ships as a container image, built and run by the infrastructure accelerator's phase 8 | One deploy, metrics and log path for all runtimes, reusable by other launchers. |
| D5 | Records in core dataService, not FsStore | Multi-tenant queries (by workspace, by status) and a MongoDB provider for production. |
| D6 | The theme is `nooblyjs/styling/styles.css`, copied verbatim; app extras in `hero-co.css` | One theme across core, the accelerators and the apps. |
| D7 | Every accelerator mounts with `mount(app, eventEmitter, serviceRegistry, options)` | One loader, one shutdown path; events on one emitter. |
| D8 | Billing is the payments accelerator; card data never touches our servers | PCI SAQ A scope; invoices, dunning and the ledger reused, not rebuilt. |
| D9 | Metric history and logs in our own small stores on `filing`, not core `measuring` and `searching` (2026-11-22) | Core `measuring` (`default`) keeps samples in memory only, stamps each at `add()` (an agent sample carries its own time) and has no roll-ups. `searching` would index every line a second time for a word search we can answer by scanning one service's chunks in the asked window, newest first (a 5,000-line ring answers the live view). Revisit with a log volume that needs an index. |
| D10 | Cron Jobs fire from our own minute scheduler (`src/scheduling/cron.js`, `public/js/shared/cron.js`), not core `scheduling` (2026-11-22) | Core's cron matches the server's local time (schedules are UTC, as Render's are) and a fire runs a worker script, where ours calls `workloads.runJob()` with the record's command. Its expression parser is not exported, and the browser needs the same parser to preview a schedule in words and list the next runs. One timer a second into each UTC minute, a guard against firing twice in a minute, and the platform's one-run-at-a-time rule (409) for overlaps. |
| D11 | A Workflow's tasks run from our own queue (`src/scheduling/tasks.js`, records `hero_task_runs`), each task run a one-off container through `workloads.runJob()`, not core `workflow` (2026-11-22) | Core `workflow` runs steps as worker scripts inside our process; a customer's task is a command in their built image, isolated like any of their code. The platform job carries the concurrency (parallel runs lock per lane, spec 8.2 R6, and running jobs reserve their place on a server), so a deploy and a task run never wait on each other. Our queue keeps what the platform does not: the task, its JSON input (`TASK_INPUT`, ≤ 16 KB), retries with a backoff (10 s, doubling, at most 5 min), waiting runs past the concurrency (≤ 1,000), cancel before start, and runs triggered from code with a per-Workflow key (only its SHA-256 kept). One pump at a time, in step with the follower of the platform's job events; a 5 s tick catches missed ends and due retries. |
| D12 | A Static Site's files are kept and served by the platform (`services.platform.staticSites`, infra spec 8.8's decision of 2026-11-22); on the Local network our proxy answers `/<workspace>/<site>/` from `staticSites.respond()` (2026-11-22) | Nothing keeps running for a site: its build runs once, the publish directory is uploaded into the platform's content-addressed store and the site switches to it in one write, so a request never mixes two deploys and a rollback is a switch with no build. The platform owns the cache headers, ETags, `_redirects`, `_headers`, the single-page-app fallback and `404.html`, so the cloud CDN adapters (8.8.3) keep the same behaviour. Our proxy adds what it adds for any app (the sandbox CSP, no cookies either way, redirects kept under the prefix) and counts requests, bytes out and cache hits (a 304 or an answer from the platform's memory) per month for the Bandwidth and Cache hit rate meters. The path prefix is the price of one origin: a site's build gets it as `BASE_PATH` (a site's variables are all build-time). |
| D13 | Postgres and Key Value are the platform's (`services.platform.databases` and `.keyvalue`, infra specs 8.6 and 8.7, decision of 2026-11-22); ours is a service record of type `postgres` or `keyvalue` naming it, and a service's links (`links: [{ key, store, type }]`) become `{ key, link: { database \| keyvalue } }` in its run spec (2026-11-22) | On the Local network a database is a database on the operator's Postgres server (`HERO_LOCAL_POSTGRES_URL`) with a login role of the same name that owns it, a connection limit from its plan, and CONNECT taken from everyone else; containers reach it only through the agent's relay on the workspace's own Docker network, which drops sources outside that network's subnet and forwards a connection only for one of the workspace's databases as its own role (TLS is declined on that hop, which never leaves the machine). A Key Value store is a Valkey container on the workspace's network with a password, a memory limit and an eviction policy, answering on a private name only that network resolves; its keys live in memory (no persistence locally, so nothing to back up). Backups are `pg_dump` files: daily at the chosen UTC time and on demand, 7 kept; a restore makes a new database. No point-in-time recovery, replicas or HA locally: those are the cloud adapters' (8.6.2, 8.6.3). The connection string is never kept by us: the platform puts it in the linked variable when a container starts, and the page shows it only after the name is typed (audited). |
