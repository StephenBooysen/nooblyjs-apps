# Running NooblyJS Cloud in production (roadmap 8.1)

One instance of the app, from the Docker image, with its records in MongoDB, its sessions in Redis and `DATA_DIR` on
a persistent volume. A restart or a new image keeps everyone signed in and every record.

**One instance only, for now.** Three stores still live under `DATA_DIR`: nooblyjs-core's sign-in records
(`authservice` `file` provider: core has no provider on dataService yet), the infrastructure accelerator's FsStore,
and telemetry history (`filing` `local`). A second instance would not see the first one's passwords, platform state or
metrics. Running several needs those three moved first.

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

Its `HEALTHCHECK` calls `/health/ready`, which answers 200 while MongoDB answers and 503 when it does not. Point a load
balancer's health check at the same path; `/health/live` only says the process is up.

## Environment

The app refuses to start without the **required** ones. It starts without the **recommended** ones, and logs a
`[hero-co]` warning for each one that is missing.

| Variable | | Value |
| --- | --- | --- |
| `SESSION_SECRET` | required | A long random string (`openssl rand -hex 32`). Signs the session cookie. |
| `HERO_SECRET_KEY` | required | A long random string. Encrypts environment variables and GitHub tokens; keep it, or they cannot be read. |
| `PAY_SIGNING_SECRET` | required | 16 characters or more. Signs hosted invoice and 3-D Secure links. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` | required | The mock card provider is refused in production. |
| `MONGODB_URL` | recommended | `mongodb://…` or `mongodb+srv://…`. Without it, records are files under `DATA_DIR`. |
| `MONGODB_DATABASE` | | Default `nooblyjs_cloud`. |
| `REDIS_URL` (or `SESSION_REDIS_URL`) | recommended | Sessions. Without it they are in memory, and a restart signs everyone out. |
| `TRUST_PROXY` | recommended | `1` behind one load balancer or proxy (secure cookies, client addresses). |
| `PUBLIC_URL` | recommended | The `https://` address people use; email links and the GitHub callback are built from it. |
| `CX_TRACKING_SECRET` | | Signs tracking and unsubscribe links; without it they stop working after a restart. |
| `SMTP_URL` | | Account emails. Without an email channel they go only to the customers accelerator's outbox. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | | "Continue with GitHub" (callback `<PUBLIC_URL>/auth/github/callback`). |

The first start creates nooblyjs-core's admin (`admin@localhost`, or `DEFAULT_ADMIN_EMAIL`) with its password in
`/data/auth/INITIAL_ADMIN_PASSWORD.txt`: read it, sign in, change it, delete the file. That admin is a platform
operator. Opening a cloud region is `docs/operator-setup.md`.

## Checked

- `npm test` passes on file records (Node 22 in CI) and on MongoDB and Redis (Node 24 in CI); each test app gets its
  own MongoDB database, dropped afterwards.
- `test/production.test.js`: the warnings, `/health/ready`, and a sign-in that survives a restart (Redis and MongoDB).
- The image, started in production against MongoDB and Redis: a sign-up, a container restart, and the same session
  still signed in (2026-11-23, by hand; CI's `docker` job starts it and waits for `/health/ready`).

CI is `.github/workflows/hero-co.yml` in nooblyjs-apps.
