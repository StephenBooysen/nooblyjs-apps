# NooblyJS Cloud (hero-co)

A Heroku/Render-style PaaS on nooblyjs-core and the NooblyJS accelerators. Read these first, in this order:

1. `.claude/steering/product.md`: what we build, for whom, the screens (§5) and the copy rules.
2. `.claude/steering/stack.md`: how it is built: ESM, Node ≥ 22.12, Express 5, no build step, the theme, the CSP.
3. `.claude/steering/roadmap.md`: what is next. Tick a box only when its test passes.

The UI spec and mock-ups live in `.claude/steering/ui/`.

## Run

```bash
npm run setup             # npm ci here and in every linked package (core, the three accelerators): each needs its own
npm start                 # http://localhost:11010: sign up at /, sign in at /services/authservice/views/login.html (or /dev/login in development)
npm test                  # node:test, offline, on the mock cloud
npm run test:ui:install   # once: Playwright Chromium (needs system libraries: sudo npx playwright install-deps chromium)
npm run test:ui           # Playwright, desktop + phone
MONGODB_URL=mongodb://127.0.0.1:27017 REDIS_URL=redis://127.0.0.1:6379 npm test   # on the production providers
npm run docker:build      # the production image (docs/production.md); context is the folder holding the repos
```

Local network region (infra spec 8.9): in development `npm start` also runs the infrastructure accelerator's agent
against this machine's Docker (`HERO_LOCAL_AGENT=fork|mock|off`; tests use `mock`). A Local network service builds on
this machine and answers at `<base URL>/<workspace>/<service>/` (`src/routes/proxy.js`: none of our cookies go to the
app, its cookies are dropped, its pages are sandboxed). The start-up admin gets a workspace of their own.

Development people (created on first start outside production; password `development-only-1`): `stevie` (workspace
exclusivity-life), `amara` (amara-labs), `ops-platform` (operator, infra Owner), `ops-support` (operator, infra Viewer).
Tests call as a person with the `X-Dev-Person` header (id or email), or sign in with a cookie jar (`test/helpers.js`).
"Continue with GitHub" uses the mock GitHub at `/dev/github` unless `GITHUB_CLIENT_ID` is set. Account emails land in
the customers accelerator's console outbox (`hero.accelerators.mounted.customers.marketing.channels.email.outbox`).

## Layout

- `app.js`: entry (`--seed [--reset]` seeds the infrastructure accelerator).
- `src/app.js`: `createApp()`: core, CSP, sessions, gates, accelerators, API, pages. Tests start it on port 0.
- `src/platform/`: `accounts.js` (people, workspaces, members, invitations, tokens on core dataService), `auth.js`
  (sign-up/in, verify, reset, GitHub, the mock GitHub), `session.js` (sessions, CSRF, gates, dev sign-in),
  `customers-link.js` (customer, organisation, consent, account emails), `host.js` (the infrastructure accelerator's
  host contract), `accelerators.js` (customers at `/admin`, payments at `/admin/payments` and `/admin/billing`,
  infrastructure at `/infrastructure`), `billing.js` (stack.md D14: the plan catalogue in the payments accelerator, a
  billing account per workspace, the hourly hand-off, *card required*, suspend and resume, the development seed),
  `people.js`, `realtime.js`.
- `src/routes/`: `api.js` (`/api/v1`), `workspaces.js` (`/api/v1/workspaces/:workspace/...`, invitations), `pages.js`
  (page URLs answered with `public/index.html`), `telemetry.js` (dashboard, metrics, instances, logs, scale).
- `src/telemetry/`: metric history and logs from `services.platform.telemetry` and the proxy, saved under
  `DATA_DIR/telemetry` (stack.md §4.2, §4.3).
- `src/scheduling/cron.js`: Cron Jobs' minute scheduler (UTC, stack.md D10) and the follower that writes each run's
  start and result to the service's logs; `src/routes/jobs.js`: runs, Run now and the schedule;
  `public/js/shared/cron.js`: the cron parser, its words and next runs, shared by the server and the browser.
- `src/scheduling/tasks.js`: Workflows' queue (stack.md D11): each task run a one-off container up to the concurrency,
  retries with backoff, cancel, the follower; `src/routes/tasks.js`: tasks, runs, the trigger key, and
  `/api/v1/tasks/...` (bearer key, mounted ahead of sessions); `public/js/pages/tasks.js`: task rows, tables, trigger card.
- `src/routes/sites.js`: a Static Site's files (what it serves, the deploys kept for rollback, this month's requests,
  bandwidth and cache hits), single-page app and publish directory, and Rollback (stack.md D12); `src/routes/proxy.js`
  answers a Local network site from `services.platform.staticSites.respond()`.
- `src/routes/billing.js`: the Owner's Billing API (cards, Pay now, details); `public/js/pages/billing.js` draws the
  Billing page with the payments accelerator's `BillingSummary`; `public/js/components/card-prompt.js` mounts its
  `CardForm` (the *Add a card* prompt that a 402 `card_required` opens from any form). Operators use *NooblyJS Pay* at
  `/admin/payments/`; customers pay a link on its hosted checkout (`/admin/payments/p/invoices/<token>`). Tests pass
  `billingTimers: false` and a `payClock`, and give a workspace a card with `addTestCard()` (`test/helpers.js`).
- `src/routes/datastores.js`: Postgres and Key Value (stack.md D13): create, the data store page's facts, reveal,
  backups and restore, plan, and Link to service (`PUT .../links`); `public/js/pages/datastore.js` draws the create form,
  the page and the Link to service card. The databases and stores are the platform's; set `HERO_LOCAL_POSTGRES_URL`
  (an admin connection string, environment only) to offer Postgres on the Local network.
- `docs/production.md`: the image, the production environment, MongoDB and Redis, one instance (roadmap 8.1). CI is
  `../.github/workflows/hero-co.yml`; `scripts/install-all.sh` installs the linked packages.
- `docs/security-review.md`: the 8.3 review (fixed, sound, open). `src/platform/reserved.js`: path segments a workspace
  id may never be (Local network services answer `/<workspace>/<service>/` ahead of our routes); a new top-level route
  fails `test/security.test.js` until its segment is added there.
- `docs/operator-setup.md`: opening a cloud region (pools, ingress, the environment) for operators.
- `public/`: `css/styles.css` (verbatim copy of `nooblyjs/styling/styles.css`; never edit it), `css/hero-co.css`
  (everything else, theme tokens only; dark values for each token under `:root[data-bs-theme="dark"]`; the log viewer
  uses `--nj-log-*`), `js/theme.js` (light or dark before the page draws; Settings → Appearance), `js/` (native ES modules: router, api, sse, charts, format, components, shell,
  pages; `pages/watch.js` draws the dashboard, Deploys, Metrics and Logs screens and the shared log viewer).

## Rules

- No inline `style=""`, `<style>`, inline scripts or `on*=` handlers: core's CSP has no `unsafe-inline`. Set dynamic
  sizes through the CSSOM (`data-pct` + `applySizes()`). `test/app.test.js` checks this.
- Escape everything with `html```; numbers carry units and limits; statuses are words as well as colours.
- Accessibility: `test/ui/a11y.spec.js` runs axe (WCAG 2.2 AA) on every screen in light and dark mode and checks 44 px
  targets on a phone; add a new screen to it. A table or log that scrolls gets `role="region" tabindex="0"` and a name.
- The only sign-in screen is nooblyjs-core's `/services/authservice/views/login.html` (with `?returnUrl=`); this app
  answers its API in `auth.js` (`login` router). Never build another sign-in page.
- Another workspace is a 404, never a 403. Operator-only routes are a 404 for customers. A new workspace route goes in
  `src/routes/workspaces.js` (behind `requireWorkspace`): `test/isolation.test.js` walks that router.
- Accelerators are mounted with `mount(app, eventEmitter, serviceRegistry, options)` and shut down in reverse.
- Temporary files go in `.temp/` (git-ignored); data in `DATA_DIR` (default `.application/`).
