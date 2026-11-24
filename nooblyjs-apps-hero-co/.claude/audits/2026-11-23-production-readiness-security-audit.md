# Production readiness and security audit: NooblyJS Cloud (hero-co), 2026-11-23

## Verdict

**Not ready for a public launch yet.** The security base is solid: sessions, CSRF, tenant isolation, secrets at rest,
webhook signatures, the proxy sandbox and the container limits all held up. Three things block a launch, though:

1. **No email is ever sent in production** (P1). Password reset, email verification, invitations and payment-failure
   notices all stay in an in-memory outbox.
2. **The first production start writes the demo story** (P2): mock "connected" GCP and AWS accounts, six fake VMs,
   apps, databases and a platform tenant.
3. **The development sign-in turns on unless `NODE_ENV` is exactly `production`** (S1). With `NODE_ENV=prod`, anyone
   can sign in as a platform operator by sending one header.

After those, the next most important items are: the CSP that allows whole public CDNs on the payment pages (S2), the
two account-takeover paths at sign-up (S3, S4), and the missing single-instance lock and backups for the file stores
that hold payments and cloud credentials (P3, P5).

| Severity | Security | Production readiness |
| --- | --- | --- |
| Critical | 0 | 1 (P1) |
| High | 2 (S1, S2) | 4 (P2, P3, P4, P5) |
| Medium | 5 (S3–S7) | 5 (P6–P10) |
| Low / Info | 6 (S8–S13) | 3 (P11–P13) |

## Scope and method

- **Code:** hero-co (`src/`, `public/`, `app.js`, `Dockerfile`, `.github/workflows/hero-co.yml`), plus the parts of
  nooblyjs-core and the accelerators that hero-co's security depends on: the CSP, the settings store, the
  infrastructure secrets, the build agent's clone and static-site serving.
- **Starting point:** `.claude/steering/security-review.md` (roadmap 8.3) and `.claude/steering/production.md`. Their
  fixed items were spot-checked, not repeated. Items still open there are listed at the end.
- **Live checks:** the app was started with `NODE_ENV=production` and CI's production environment, on a throwaway
  `DATA_DIR` (since deleted), and probed with curl. A second start used `NODE_ENV=prod` to test S1.
- **Other checks:** `npm audit --omit=dev` on hero-co and the four linked packages; the unit suite (150 pass, 1
  skipped because it needs MongoDB and Redis).
- **Not covered:** a penetration test of the customers and payments accelerators' own APIs; the agent on a real cloud
  host; a real GCP or AWS account (the adapters have only been tested against fakes); MongoDB and Redis hardening;
  load testing.

Each finding says how it was confirmed. **Reproduced** means it was shown on a running instance. **Read in code**
means it was traced through the source but not run.

---

## Security findings

### S1 · High · The development sign-in is fail-open

- **Where:** `src/config.js:48` sets `devSignIn: !production && env.DEV_SIGN_IN !== '0'`, where
  `production = env.NODE_ENV === 'production'`.
- **What:** anything other than the exact string `production` turns on:
  - `/dev/login`, which lists every person and signs you in as any of them;
  - the `X-Dev-Person` header, which does the same per request;
  - the mock GitHub and Google;
  - the development people, including `ops-platform`, a platform operator whose password is
    `development-only-1`.
- **Impact:** one typo or one missing variable (`NODE_ENV=prod`, `Production`, unset on a PaaS) hands over every
  account, the back office, the cloud credentials and the payments screens.
- **Evidence (reproduced):** with `NODE_ENV=prod`, `GET /dev/login` returned 200. `GET /api/v1/me` with
  `X-Dev-Person: ops-platform` returned the platform operator.
- **Mitigation already in place:** the Docker image sets `NODE_ENV=production`.
- **Fix:** make development opt-in rather than production opt-out. Turn the dev sign-in on only when
  `NODE_ENV=development` (or `test`) and `DEV_SIGN_IN=1`. Refuse to start with it on when `PUBLIC_URL` is `https://`
  or the host isn't localhost. Never create the development people unless the dev sign-in is on and the people
  collection is empty.

### S2 · High · The CSP allows whole public CDNs and Google Tag Manager, and no third-party file has SRI

- **Where:** nooblyjs-core `src/shared/utils/contentSecurityPolicy.js:23-24` (`CDN_SOURCES`, `ANALYTICS_SOURCES`).
  `public/index.html:8-9` and the accelerators' views load from them with no `integrity` attribute.
- **What:** `script-src` is `'self' https://cdn.jsdelivr.net https://unpkg.com https://www.googletagmanager.com
  https://*.google-analytics.com` (plus `js.stripe.com` with Stripe).
  - jsDelivr and unpkg serve every npm package, so any HTML injection can load an attacker's script from them, and
    Tag Manager is a known way around a CSP. So the "no `unsafe-inline`" protection is much weaker than
    `security-review.md` assumes.
  - hero-co's own pages load no script from any of these. Only Bootstrap's JS (jsDelivr) on the accelerators'
    operator pages, and Stripe, are used.
  - There are 0 `integrity` attributes across hero-co and the accelerators' pages.
- **Impact:**
  - **Defence in depth:** an injection bug anywhere becomes full script execution on our origin, including the
    Billing page that hosts the card form.
  - **Payments compliance:** PCI DSS 4.0.1 SAQ A now asks the merchant to confirm the page embedding the payment
    form isn't open to script attacks (6.4.3 / 11.6.1), and an allowlist of all of npm undercuts that.
- **Evidence (reproduced):** the production response header on `/` was read in full.
- **Fix:**
  - Drop `unpkg.com`, `googletagmanager.com` and `google-analytics.com` from `script-src` and `connect-src` for hero-co.
  - Narrow jsDelivr to the exact paths used (`https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/`), or better, copy
    Bootstrap and Bootstrap Icons into `public/vendor/`.
  - Add `integrity` to any third-party file that stays.
  - Keep a script inventory for the Billing page.

### S3 · Medium · Pre-account takeover through GitHub and Google sign-in

- **Where:** `src/platform/auth.js:347-351` (GitHub) and `:455-457` (Google).
- **What:** sign-up with a password creates an unverified account and signs it in. If someone later signs in with
  GitHub or Google using that email, the code links to the existing account and marks it verified, but leaves its
  password in place.
- **Impact:** an attacker who pre-registers `victim@company.com` with a password they know keeps access to the account
  once the real owner starts using it through GitHub or Google: their workspace, deploys and environment secrets.
- **Evidence:** read in code.
- **Fix:** when linking an identity provider to an account whose email was never verified, either refuse and ask the
  person to sign in with the password first, or reset the password and bump `sessionEpoch`, which ends the attacker's
  sessions.

### S4 · Medium · Sign-up can overwrite the password of an existing core login

- **Where:** `src/platform/auth.js:179-184`. If core's `createUser` says the user already exists and there is no hero
  person with that email, sign-up calls `core.updateUser(email, { password })`.
- **What:** the comment assumes the core login was left by a failed sign-up. It could also be a user an operator
  created in core's `/services` portal, or a core admin created after start-up (`ensureCoreAdmins` only runs at
  boot).
- **Impact:** anyone can set the password of such a login without proving they own the address, and then hold the
  email in hero-co.
- **Evidence:** read in code.
- **Fix:** only replace a core credential that hero-co itself created for a sign-up that didn't finish: mark it, with
  a short expiry. Otherwise refuse with "An account with this email exists" and point to password reset.

### S5 · Medium · Blind SSRF from build hosts through a public Git URL

- **Where:**
  - `src/routes/services.js:18` (`publicGitUrl`) accepts any `https://` host, including `https://10.0.0.5/…`,
    `https://localhost/…` and link-local addresses.
  - The infrastructure agent clones on the host itself (`agent/docker.js:249`, `git clone` in `os.tmpdir()`), not in
    the sandboxed build container.
- **What:** the egress firewall (spec 8.9 R14) filters container traffic (`DOCKER-USER`, tenant interfaces), not
  processes on the host. Git also follows the first redirect.
- **Impact:** a customer can make a build host send HTTPS requests to internal services and learn from the build log
  whether they answer. Cloud metadata endpoints are plain `http`, and GCP's needs a header, so credential theft is
  unlikely, but internal discovery is possible.
- **Evidence:** read in code.
- **Fix:** resolve the host and refuse private, loopback, link-local and CGNAT addresses. Clone with
  `-c http.followRedirects=false`. Better still, run the clone inside the build container, behind the same egress
  rules.

### S6 · Medium · Encryption keys fall back to `SESSION_SECRET`

- **Where:**
  - infrastructure `src/services/secrets.js:52`: `INFRA_SECRET_KEY || SETTINGS_SECRET || SESSION_SECRET`;
  - core `src/settings/providers/settings.js:134-135`: settings use `SETTINGS_SECRET || SESSION_SECRET`.
- **What:** `production.md` asks for neither `INFRA_SECRET_KEY` nor `SETTINGS_SECRET`, so in production the stored
  cloud credentials and core's settings are encrypted with the session-cookie secret. CI's production run sets
  neither either.
- **Impact:** one secret does two jobs. Rotating `SESSION_SECRET` after a leak, the normal response, makes every
  stored cloud credential unreadable. A leaked session secret also opens the credential store.
- **Evidence:** read in code; `production.md` checked.
- **Fix:** require `INFRA_SECRET_KEY` and `SETTINGS_SECRET` in production (refuse to start without them), document
  them, and remove the `SESSION_SECRET` fallback. Plan key versioning so a key can be rotated.

### S7 · Medium · Operator accounts have no second factor

- **What:** operators can connect cloud accounts (and so hold their credentials), refund payments, read every
  customer's records and run the infrastructure control plane, all behind a password, or behind GitHub or Google via
  the auto-link in S3.
- **Fix:** require TOTP or WebAuthn for operators, at least for the `platform` role. Don't auto-link GitHub or Google
  to operator accounts. Consider an idle timeout for operator sessions (see P12).

### S8 · Low · Account enumeration

- **What:** sign-in for an unknown email skips bcrypt (`auth.js:203`). Sign-up also says "An account with this email
  exists" (`auth.js:176`). Forgot-password is careful not to reveal this, but these two paths do.
- **Evidence (reproduced):** about 440 ms for an existing account against about 10 ms for an unknown one.
- **Fix:** run a dummy bcrypt compare for unknown emails. Accept that sign-up reveals it, or move to "check your
  email" sign-ups.

### S9 · Low · Anyone can lock a person out of password sign-in

- **What:** the per-email limit (10 per 15 minutes, `auth.js:201`) is checked before the password, so ten bad guesses
  block the real owner too, and an attacker can keep renewing the block.
- **Evidence (reproduced):** the 11th attempt returned 429.
- **Fix:** key the limit on email and IP together, or slow responses down progressively rather than blocking. Let a
  correct password through from an IP with no failures.

### S10 · Low · core's session tokens are stored in plaintext

- **What:** `DATA_DIR/auth/sessions.json` holds live bearer tokens as plain keys. That file and `users.json` were
  created `0664`. Password hashes are bcrypt with cost 12, which is good.
- **Fix:** store a hash of each token, create the files `0600`, and expire old sessions. Inside the container only
  the `node` user exists, so this matters mostly for backups and volume snapshots.

### S11 · Low · The CSRF check can throw a 500

- **What:** `session.js:143` compares lengths in characters, then calls `timingSafeEqual` on UTF-8 buffers. A
  non-ASCII header of the same length makes the buffers differ in size, which throws a `RangeError`.
- **Fix:** compare the buffers' byte lengths.

### S12 · Low · No limit on event streams per person

- **What:** `/api/v1/events` and the log streams have no per-person cap, so a stolen session or a runaway tab can
  hold many open connections, each re-checked every 10 s.
- **Fix:** cap open streams per person (5, say) and per IP. This fits with the open "general API rate limit" item
  from 8.3.

### S13 · Info · Dependencies

- hero-co's production tree has 3 moderate advisories: `uuid` < 11.1.1, through `passport-azure-ad` (deprecated) and
  `node-jose`. All of them come from nooblyjs-core's dependencies.
- nooblyjs-core, customers, payments and infrastructure audit clean with their own lockfiles.
- **Fix:** remove or replace `passport-azure-ad` in core.

---

## Production readiness findings

### P1 · Critical · No email delivery in production

- **Where:**
  - `src/app.js:246` checks `config.emailChannel`, which `loadConfig()` never sets, so the warning always fires and
    nothing else happens.
  - `production.md:50` documents `SMTP_URL`, which nothing reads.
  - The customers accelerator has an SMTP adapter that needs a host-supplied transport, but hero-co never passes one.
- **Impact:** in production no verification, password-reset, invitation, welcome or payment-failure email leaves the
  process. They sit in a 1,000-message in-memory outbox and are lost on restart. People who forget their password are
  locked out, invite-only mode (`AUTH_TYPE=local`) can't work, and suspended customers are never told.
- **Evidence (reproduced):** sign-up and forgot-password in production logged "console email sent" and nothing else.
  The reset link did not appear in the log, which is good.
- **Fix:**
  - Read `SMTP_URL` (or a transactional provider's API key) in `loadConfig()`, build a transport, and pass it as the
    customers accelerator's email channel.
  - Set `emailChannel`.
  - Refuse to start in production without a channel, unless an explicit `EMAIL=off` is set.
  - Add a test that a reset email reaches the transport.

### P2 · High · The demo story is written on the first production start

- **Where:**
  - `app.js:15` passes `seed: !args.has('--seed')`, which is true on every normal start.
  - `src/app.js:250` then seeds whenever the infrastructure folder is empty.
  - The infrastructure accelerator's `seed()` writes sample content unless `host.sampleData === false`
    (`index.js:384`), and hero-co's host never sets it.
- **Impact:** a fresh production install shows "Stevie's GCP and AWS accounts (the mockups)" as *connected* mock
  accounts, six VMs, apps, databases, activity "by Stevie", and a platform tenant `exclusivity-life`. Operators can't
  tell this from real infrastructure, and it shows up in counts and costs.
- **Evidence (reproduced):** after the production start, `DATA_DIR/infrastructure/seed.yaml` said `sampleData: true`,
  `accounts/stevie-prod.md` said `provider: mock, state: connected`, and `vms/` held six VMs.
- **Fix:** seed only outside production (`seed: !config.production && …`), set `sampleData: false` on the host in
  production, and add a production-start test that asserts the infrastructure folder holds no sample data.

### P3 · High · "One instance only" is documented but not enforced

- **What:** nothing stops a second process using the same `DATA_DIR`, as happens in a blue-green or rolling deploy, a
  second replica, or `docker run` twice. Both processes would run:
  - the cron scheduler;
  - the Workflow queue;
  - billing's hourly hand-off and the payments jobs;
  - the infrastructure operations.
  Both would also do read-modify-write on the same JSON files.
- **Impact:** corrupted file stores, operations run twice, and billing work done twice. The usage events carry
  idempotency keys, which helps, but the idempotency store is itself a JSON file written the same racy way.
- **Fix:**
  - At start-up, take an exclusive lock on `DATA_DIR` (a lock file opened with `O_EXCL`, or `flock`) and refuse to
    start without it.
  - Document a stop-then-start deploy strategy ("Recreate").
  - Before running more than one instance, move the schedulers behind a leader lock in Redis.

### P4 · High · core's settings are written outside `DATA_DIR`

- **Where:** core `src/settings/providers/settings.js:101` defaults to `./.application/settings/settings.enc.json`,
  relative to the working directory.
- **What:** in the image the working directory is `/app`, which belongs to root and isn't the `/data` volume, so the
  settings (feature flags among them) either can't be written by `node` or are lost when the container is replaced.
- **Evidence:** reproduced locally. A production start with `DATA_DIR=.temp/…` still read
  `./.application/settings/settings.enc.json` and logged `[FLAGS] Could not read flag definitions … master secret is
  incorrect`, because the file came from a development run. The image behaviour is read in code, not run.
- **Fix:** pass `filepath: path.join(config.dataDir, 'settings', 'settings.enc.json')` when hero-co initialises core's
  settings, and add a test that nothing is written outside `DATA_DIR`.

### P5 · High · Payments and cloud credentials live in local JSON files with no backup procedure

- **What:** `production.md` names three stores under `DATA_DIR`: core's sign-ins, the infrastructure store and
  telemetry. It leaves out a fourth: the payments accelerator is mounted with a `file` data provider
  (`accelerators.js`, `providers.data.type: 'file'`). So the ledger, invoices, payments, refunds and idempotency
  records are JSON files, even when MongoDB is set. The encrypted cloud credentials and the audit trail are files too.
- **Impact:** financial records and credentials depend on one volume. There is no documented backup, no restore
  procedure and no restore test, and file writes aren't transactional.
- **Fix:**
  - Document and automate backups of `DATA_DIR` (snapshot plus off-site copy) and of MongoDB, and test a restore.
  - Move the payments data to MongoDB (the accelerator takes a data provider).
  - List every store under `DATA_DIR` in `production.md`.

### P6 · Medium · Every lookup reads whole collections

- **Where:** `accounts.js:50-51` and `records.js:38-41` implement `where`/`first` as `listAll()` plus a filter in
  JavaScript.
- **What:** `session.identify` runs on every request, static files included, and calls `workspacesFor`
  (`accounts.js:148`), which reads all memberships. Sign-in reads all people, and service and deploy lists read every
  workspace's records. Nothing is indexed or paginated, and tokens and deploy records are never purged.
- **Impact:** cost per request grows with the whole platform's size. With MongoDB, each request pulls whole
  collections over the network. This is fine for tens of customers and slow for thousands.
- **Fix:** query by field (core's dataService `find` with a filter, or the MongoDB driver directly) with indexes on
  `email`, `personId`, `workspaceId` and token ids. Skip `identify` for `/css`, `/js`, `/ui` and `/images`. Purge used
  and expired tokens.

### P7 · Medium · Environment and provider defaults

- **Gaps in `production.md`:** it omits `INFRA_SECRET_KEY`, `SETTINGS_SECRET` (see S6) and `INFRA_PROVIDERS`, and
  documents `SMTP_URL`, which does nothing (see P1).
- **Mock cloud by default:** `INFRA_PROVIDERS` defaults to `mock` (infrastructure `index.js:72`), so a "GCP" or "AWS"
  account connected in production quietly runs on the mock cloud and reports success.
- **Fix:** document every variable, and refuse `mock` in production unless it is explicitly allowed.

### P8 · Medium · Observability

- **What's missing:**
  - an access log for hero-co's own routes (only the service proxy records requests);
  - a metrics endpoint;
  - error tracking;
  - `unhandledRejection` and `uncaughtException` handlers, so a stray rejection ends the process;
  - a restart policy in the `docker run` example.
- **Log format:** logs are multi-line text with embedded JSON, which is awkward to ingest.
- **Fix:**
  - a one-line JSON access log with request id, status, duration and person id;
  - an error reporter;
  - `/metrics` (or OpenTelemetry) for request rate, latency, queue depths and job lag;
  - `--restart unless-stopped`, or the orchestrator's equivalent.

### P9 · Medium · Privacy and data lifecycle

- **What's missing:**
  - account deletion, workspace deletion, or an export of a person's data;
  - retention for used tokens, deploy records and the audit YAML. Telemetry does have retention.
- **Impact:** if you serve South Africa (`af-south`) or the EU, POPIA and GDPR rights to erasure and access can't be
  met without manual work on raw files.
- **Fix:** an Owner-initiated workspace deletion (services stopped, data stores removed, billing closed) and a
  person-level deletion and export, both audited. Add retention jobs.

### P10 · Medium · Build reproducibility and provenance

- **What:**
  - The Dockerfile runs `npm install --install-links` (`Dockerfile:25`) rather than `npm ci`.
  - Both stages use `node:24-bookworm-slim` by tag (`:14`, `:28`).
  - core and the accelerators come from whatever is checked out beside the repo (CI uses their `main`).
  - Actions are pinned by tag.
- **Impact:** two builds of the same commit can differ, and an image can't say which core and accelerator commits
  it contains.
- **Fix:**
  - Pin the base image by digest.
  - Record the commits of core and the accelerators as image labels (`org.opencontainers.image.revision` and one per
    repo).
  - Pin the CI refs for releases.
  - Pin actions by commit SHA.
  - Prefer `npm ci`, or verify the lockfile after `install`.

### P11 · Low · Shutdown has no deadline

- **What:** on SIGTERM, `server.close()` isn't awaited, open event streams keep connections up, and if
  `hero.shutdown()` hangs the process waits for SIGKILL.
- **Fix:** end event streams on shutdown, await `close()`, and exit after a deadline of about 20 s.

### P12 · Low · Sessions last 14 days, with no idle timeout

- **What:** the session cookie has a 14-day fixed lifetime for everyone, operators included.
- **Fix:** a rolling idle timeout (12 h for operators, longer for customers) on top of the absolute maximum.

### P13 · Low · The operator rail's embedded page can throw

- **Where:** `public/js/operator/embed.js:32`.
- **What:** this is from today's operator rail. If a link inside an embedded accelerator page goes to another site,
  reading `contentWindow.location` throws a `SecurityError` in the load handler.
- **Fix:** wrap the read in `try`/`catch` and leave the frame alone when it isn't same-origin.

---

## Checked and sound (this pass)

- **Session cookie:** `hero.sid` is `HttpOnly; Secure; SameSite=Lax` behind TLS, with a 14-day expiry.
  `noobly.csrf` is `Secure; SameSite=Lax`.
- **Development-only routes:** in production (`NODE_ENV=production`), `/dev/login`, `/dev/github` and `/dev/google`
  answer 404 and `X-Dev-Person` is ignored.
- **`/services`:** anonymous requests get a redirect or 401; only the sign-in page and its files are open.
- **Security headers:** HSTS (1 year, subdomains), `nosniff`, `X-Frame-Options: SAMEORIGIN`, COOP and CORP
  `same-origin`, `Referrer-Policy: no-referrer`; no `X-Powered-By`.
- **Errors:** the handler never returns a stack trace or internal message on a 500. API 404s are JSON.
- **Passwords:** bcrypt with cost 12.
- **Tokens:** verification, reset and invitation tokens are 256-bit, stored as SHA-256, single use and expiring.
- **Rate limiting:** sign-in is limited per email and per IP (the 11th attempt got 429).
- **OAuth:** GitHub and Google use `state`, and Google requires `email_verified`.
- **Static sites:** files are served by manifest lookup, so a path can't escape the site.
- **Secrets at rest:** AES-256-GCM, with `HERO_SECRET_KEY` required in production.
- **Tenant isolation, the proxy sandbox, webhook signatures, trigger keys and container limits:** as described in
  `security-review.md`. They were spot-checked, and their tests pass.
- **Telemetry:** history has a retention period.

## Still open from the 8.3 review

1. A separate origin for Local network apps (phishing risk on our own origin).
2. Docker `userns-remap` on hosts, for root in customers' own Dockerfiles.
3. Rate limits are per process.
4. There is no general per-person API rate limit (see S12).

## Suggested order

1. **Before any real customer:** P1 (email), P2 (seed), S1 (dev sign-in fail-closed), S6 and P7 (required secrets and
   no mock in production), P4 (settings path).
2. **Before taking payments:** S2 (CSP and vendored assets), P3 (instance lock), P5 (backups and payments on MongoDB).
3. **Soon after:** S3 and S4 (sign-up takeover paths), S7 (operator MFA), S5 (SSRF), P8 (observability).
4. **As volume grows:** P6 (queries and indexes), P9 (deletion and export), P10, and the Low items.

## Addendum: found while fixing (2026-11-23)

### P14 · Critical · The customers accelerator kept every record in memory

- **Where:** `src/platform/accelerators.js` mounted the customers accelerator with no `providers`, and its default
  data provider is `memory` (nooblyjs-accel-customers `index.js` `resolveCoreServices`).
- **What:** customers, organisations, the consent ledger (the sign-up checkbox's evidence), the unsubscribe list,
  communications and templates lived in the process. A restart emptied them. hero-co's people keep a `customerId`,
  so after any restart a password reset, verification or invitation email to an existing person failed with
  `customer … not found`, and only a warning was logged.
- **Evidence (reproduced):** sign up, restart on the same `DATA_DIR`, ask for a password reset: no email, and
  `[hero-co] email cloud-password-reset failed: customer 963b5c5d-… not found`.
- **Fixed** with roadmap 8.7.8: the customers and payments accelerators keep their records with hero-co's (MongoDB, or
  files under `DATA_DIR`), and a person whose customer is missing is linked again before the email is sent.
