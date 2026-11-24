# Running NooblyJS Cloud in production (roadmap 8.1)

One instance of the app, from the Docker image, with its records in MongoDB, its sessions in Redis and `DATA_DIR` on
a persistent volume. A restart or a new image keeps everyone signed in and every record.

**One instance only, for now.** Three stores still live under `DATA_DIR`: nooblyjs-core's sign-in records
(`authservice` `file` provider: core has no provider on dataService yet), the infrastructure accelerator's FsStore,
and telemetry history (`filing` `local`). A second instance would not see the first one's passwords, platform state or
metrics. Running several needs those three moved first.

The app enforces it (roadmap 8.7.7): at start it takes `DATA_DIR/hero-co.lock` and touches it every 10 seconds. A
second process on the same `DATA_DIR` waits up to 80 seconds for the lock to go stale (the first one was killed
without stopping), then refuses to start, naming the process that holds it. A lock whose process is gone on the same
host is taken at once. Delete the file by hand only when you are sure no copy is running.

## What is where

With `MONGODB_URL`, the records of hero-co (`hero_*` collections), the customers accelerator (`cx_*`: customers,
the consent ledger, the unsubscribe list, communications) and the payments accelerator (`pay_*`: the ledger,
invoices, payments, refunds) are in MongoDB. Everything else is under `DATA_DIR`:

| Under `DATA_DIR` | What | |
| --- | --- | --- |
| `auth/` | nooblyjs-core's sign-ins: people, password hashes, roles, sessions; `INITIAL_ADMIN_PASSWORD.txt` until deleted | back up |
| `infrastructure/` | The infrastructure accelerator: cloud accounts, credentials (encrypted with `INFRA_SECRET_KEY`), servers, operations, Static Site files (`static/`) | back up |
| `settings/` | nooblyjs-core's settings and feature flags (encrypted with `SETTINGS_SECRET`) | back up |
| `audit/`, `events/` | The audit trail and event log, a file a day | back up |
| `telemetry/` | Services' metric history and logs | back up (or accept losing history) |
| `data/` | hero-co's records, without `MONGODB_URL` | back up |
| `customers/`, `payments/` | The customers and payments accelerators' records, without `MONGODB_URL` | back up |
| `secrets/` | A development key (only without `HERO_SECRET_KEY`, so never in production) | |
| `hero-co.lock` | Who is running on this `DATA_DIR` (roadmap 8.7.7); never copied | |

Before roadmap 8.7.8 the payments records were files under `DATA_DIR/payments` even with `MONGODB_URL`; an install
from then refuses to start with MongoDB until they are moved into the `pay_*` collections (and the folder away).

Redis holds only sessions: losing it signs everyone out, nothing more. The four keys are in neither place: keep them
in your secret store, because a restore needs the same ones.

## Backup and restore

`node app.js --backup <folder>` copies `DATA_DIR` and every `hero_*`, `cx_*` and `pay_*` collection into
`<folder>/nooblyjs-cloud-<time>/` (`data/`, `mongodb/` in canonical Extended JSON, and `manifest.json` with the
counts). `node app.js --restore <backup>` puts one back into an empty `DATA_DIR` and database (`--force` moves the
current files aside and replaces the collections), then checks every count. Both take `DATA_DIR`'s lock, so they
run with the app stopped, and the copy is consistent across the folder and the database
(`test/backup.test.js`, on files and on MongoDB).

```bash
docker stop nooblyjs-cloud
docker run --rm -v nooblyjs-data:/data -v /srv/backups:/backups --env-file production.env nooblyjs-cloud node app.js --backup /backups
docker start nooblyjs-cloud
# restore, into a new volume
docker run --rm -v nooblyjs-data-restored:/data -v /srv/backups:/backups --env-file production.env nooblyjs-cloud \
  node app.js --restore /backups/nooblyjs-cloud-<time>
```

Run it nightly (a minute of downtime for a small install), copy each backup off the server (another region or
provider), and keep at least seven. Restore one into a new volume and database every month and start the app on it:
a backup is only as good as its last restore. On a managed MongoDB (Atlas, DocumentDB) also turn on its own
point-in-time backups; for a large database, `mongodump` and `mongorestore` of the same collections do the same job.

## Build

The image is built from the folder that holds the four repositories (hero-co links core and the accelerators):

```bash
cd nooblyjs-apps/nooblyjs-apps-hero-co
npm run docker:build          # docker build -f Dockerfile -t nooblyjs-cloud ../..
```

`Dockerfile.dockerignore` sends only nooblyjs-core, the three accelerators and hero-co, with no `node_modules`, data
or `.env` files. The image runs Node 24 as the `node` user with `NODE_ENV=production`, `DATA_DIR=/data` and the Local
network agent off.

## Run

```bash
docker run -d --name nooblyjs-cloud -p 11010:11010 -v nooblyjs-data:/data --env-file production.env nooblyjs-cloud
```

**Deploy by stop-then-start** ("Recreate" in Kubernetes, not a rolling or blue-green update): stop the running
container (SIGTERM; the app shuts down and releases the lock), then start the new image on the same volume. A new
container started while the old one still runs waits, then exits.

The one-off commands open `DATA_DIR` too, so they refuse while the app is running. Run them with it stopped:

```bash
docker stop nooblyjs-cloud
docker run --rm -v nooblyjs-data:/data --env-file production.env nooblyjs-cloud node app.js --operator <email> platform
docker start nooblyjs-cloud
```

Its `HEALTHCHECK` calls `/health/ready`, which answers 200 while MongoDB answers and 503 when it does not. Point a load
balancer's health check at the same path; `/health/live` only says the process is up.

## Environment

The app refuses to start without the **required** ones. It starts without the **recommended** ones, and logs a
`[hero-co]` warning for each one that is missing. The four keys must all differ: rotating one must not open, or lock,
what the others protect.

| Variable | | Value |
| --- | --- | --- |
| `NODE_ENV` | required | `production` (the image sets it). Any other value but `development` or `test` refuses to start, and so does an unset one with an `https://` `PUBLIC_URL`: development sign-in and sample data need `development` or `test` said out loud. |
| `SESSION_SECRET` | required | A long random string (`openssl rand -hex 32`). Signs the session cookie. |
| `HERO_SECRET_KEY` | required | A long random string. Encrypts environment variables and GitHub tokens; keep it, or they cannot be read. |
| `INFRA_SECRET_KEY` | required | A long random string. Encrypts the infrastructure accelerator's cloud credentials and passwords; keep it. |
| `SETTINGS_SECRET` | required | A long random string. Encrypts nooblyjs-core's settings (`DATA_DIR/settings/settings.enc.json`); keep it. |
| `SMTP_URL`, `EMAIL_FROM` | required | `smtps://user:password@smtp.example.com:465` (or `smtp://…:587`, which must offer STARTTLS) and `"NooblyJS Cloud <no-reply@example.com>"`. Verification, reset and invitation emails. `EMAIL=off` starts without them on purpose; emails then stay in the customers accelerator's outbox. |
| `INFRA_PROVIDERS` | required | The clouds the infrastructure accelerator connects: `gcp`, `aws`, or both (`gcp,aws`). Its default, `mock`, is refused unless `INFRA_ALLOW_MOCK=1`. |
| `PAY_SIGNING_SECRET` | required | 16 characters or more. Signs hosted invoice and 3-D Secure links. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` | required | The mock card provider is refused in production. |
| `MONGODB_URL` | recommended | `mongodb://…` or `mongodb+srv://…`. Without it, records are files under `DATA_DIR`. |
| `MONGODB_DATABASE` | | Default `nooblyjs_cloud`. |
| `REDIS_URL` (or `SESSION_REDIS_URL`) | recommended | Sessions. Without it they are in memory, and a restart signs everyone out. |
| `TRUST_PROXY` | recommended | `1` behind one load balancer or proxy (secure cookies, client addresses). |
| `PUBLIC_URL` | recommended | The `https://` address people use; email links and the GitHub callback are built from it. |
| `CX_TRACKING_SECRET` | | Signs tracking and unsubscribe links; without it they stop working after a restart. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | | "Continue with GitHub" (callback `<PUBLIC_URL>/auth/github/callback`). |

Production writes no sample data: the infrastructure accelerator starts empty, there are no demo customers and no
development people, and `npm run seed` refuses to run.

The first start creates nooblyjs-core's admin (`admin@localhost`, or `DEFAULT_ADMIN_EMAIL`) with its password in
`/data/auth/INITIAL_ADMIN_PASSWORD.txt`: read it, sign in, change it, delete the file. That admin is a platform
operator. Opening a cloud region is `.claude/steering/operator-setup.md`.

## Checked

- `npm test` passes on file records (Node 22 in CI) and on MongoDB and Redis (Node 24 in CI); each test app gets its
  own MongoDB database, dropped afterwards. A MongoDB you run yourself needs MongoDB's recommended open-file limit
  (`--ulimit nofile=64000:64000` for its container): the suite's many databases abort it at Docker's default 1024.
- `test/production.test.js`: the warnings, `/health/ready`, and a sign-in that survives a restart (Redis and MongoDB).
- The image, started in production against MongoDB and Redis: a sign-up, a container restart, and the same session
  still signed in (2026-11-23, by hand; CI's `docker` job starts it and waits for `/health/ready`).

CI is `.github/workflows/hero-co.yml` in nooblyjs-apps.
