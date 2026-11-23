# Security review (roadmap 8.3), 2026-11-23

What was looked at, what was found and fixed (each with a test in `test/security.test.js` that fails without the fix),
and what is still open. Scope from the roadmap: tenant isolation, container hardening, webhook verification, secret
handling, rate limits, the payments SAQ A scope.

## Fixed

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | Critical | **A team name could put its service in front of our files.** Local network services answer `/<workspace>/<service>/` ahead of every route of ours, and a workspace id is its team name as a slug. Only 9 names were reserved, so a team called "JS" got `js`, and a service called `pages` answered `/js/pages/*.js`: our own scripts, run by our pages as ours (the sandbox header on the response does not apply to a script another page loads). "Infrastructure" could answer the agent's install script, "Hooks" the GitHub webhook, "CSS" our styles. That is cross-site scripting on our origin, account takeover, and the script attack PCI DSS 4.0.1 asks an SAQ A merchant to rule out. | `src/platform/reserved.js` reserves every path segment the app answers; a test walks the live routers and `public/` and fails on any segment missing from it. New workspaces skip reserved ids (and an explicit reserved id is refused), and the proxy ignores reserved first segments, so a workspace that already has one cannot use it. |
| 2 | Medium | **Open redirect after sign-in.** `safeNext` refused `//evil.com` and `/\evil.com` but not `/<tab>/evil.com` or `/<newline>/evil.com`, which browsers turn into `//evil.com`. A sign-in link could land the person on another site after a real sign-in (phishing). | No whitespace or control characters anywhere, 2,048 characters at most. |
| 3 | Medium | **Live events kept flowing after access ended.** An event stream (logs, deploys) took the person's workspaces once, when it opened. A removed member, a session signed out elsewhere, or a password reset left it streaming that workspace's logs (which can print secrets) until the browser closed it. | Every 10 s the stream reads the session and memberships again from the store and ends when anything it carries is no longer allowed; the browser's reconnect gets only what the person may see now. |
| 4 | Low | **A service could set headers that act on our whole origin.** The proxy dropped `Set-Cookie` and CSP, but passed `Clear-Site-Data` (sign every viewer out of us), `Strict-Transport-Security: max-age=0` (turn our HSTS off), `NEL` / `Report-To` / `Reporting-Endpoints` (reports about our pages to them), `Alt-Svc` and `Service-Worker-Allowed`. | Dropped for services and static sites; our own HSTS is kept on their answers. |
| 5 | Low | **The webhook parsed before it checked.** Up to 1 MB of JSON was parsed for anyone before the signature check. | The signature is checked on the raw body first. |
| 6 | Low | **The sign-in rate limiter could grow without bound.** It only dropped expired keys, so many made-up emails within the window kept growing it. | A hard cap of 10,000 keys; the oldest go first. (Trade-off: a flood of new keys can push out an older counter. The per-IP limit, 50 per 15 minutes, makes that flood need many addresses.) |

## Checked and sound

- **Tenant isolation.** Another workspace is a 404 on every route of the workspace router (`test/isolation.test.js`
  walks it); records are read by workspace; Owner-only actions (members, invitations, GitHub, billing, workspace
  settings) are enforced in the API, not just hidden in the page; secrets can be revealed by members after typing the
  name, as product.md §7 says, and each reveal is audited.
- **Proxied apps.** None of our cookies reach them, their cookies are dropped, their pages run in a sandbox without
  `allow-same-origin` (an opaque origin: no access to our cookies, storage or API as the viewer; their requests carry
  `Origin: null`, which our CSRF check refuses).
- **Sessions and CSRF.** `HttpOnly`, `SameSite=Lax`, `Secure` in production; a new session id at sign-in; a password
  reset ends every other session; double-submit token or same-origin `Origin` on every cookie write; login CSRF refused.
- **Webhooks and trigger keys.** HMAC-SHA256 with a per-workspace secret, constant-time compare, an unknown workspace
  answers the same 401, redeliveries deploy once. Workflow keys are 256-bit, stored as SHA-256, constant-time compare,
  every failure the same 401.
- **Secrets at rest.** AES-256-GCM with the record as associated data (a sealed value moved to another record will
  not open); the key from `HERO_SECRET_KEY` (required in production); never in an API answer except an audited reveal.
- **Containers.** `--cap-drop ALL`, `no-new-privileges`, PID, memory and CPU limits, read-only root with a small
  `/tmp`, ports bound to 127.0.0.1, one Docker network per workspace; the runtime templates run as the `node` user.
- **Rate limits.** Sign-in per email (10 / 15 min) and per IP (50 / 15 min), sign-up per IP, email sends per person
  and address; quotas on services, data stores and the Workflow queue.
- **Payments, SAQ A.** Card numbers only ever go to the provider's own fields (Stripe's Payment Element, or the mock
  provider's hosted fields, which production refuses); our API sees setup ids, the brand and the last four digits.
  The CSP has no `unsafe-inline`; finding 1 was the one way found to run a script of someone else's on our pages.

## Open (recommended before customers)

1. ~~**Egress from builds and containers.**~~ *Fixed 2026-11-23 in the infrastructure accelerator (spec 8.9 R14):
   an egress firewall applied by `install.sh` stops tenant containers and builds reaching the server and its private
   network (and cloud metadata), leaving the internet, DNS and the database relays on their gateway; tested on this
   Codespace's real iptables and Docker. Servers without it show a warning to operators.*
2. **A separate origin for customer apps.** On the Local network, apps answer on our own origin under a path. The
   sandbox keeps their scripts away from our cookies and API, but a page there can still look like ours (phishing).
   Cloud regions already use `<service>.nooblyjs.app`; give the Local network an apps host of its own as well.
3. **Root in a customer's own Dockerfile.** The templates drop to `node`; a repository's Dockerfile may run as root
   (without capabilities or new privileges). Enable Docker's `userns-remap` on hosts so root in a container is not root
   on the host.
4. **Rate limits are per process.** Fine for the one instance 8.1 supports; several instances need them in Redis.
5. **No general API rate limit.** Quotas cap what can be created; a per-person request limit on `/api/v1` would cap
   cost and noise from a stolen session or a runaway script.
