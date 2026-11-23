# syntax=docker/dockerfile:1.7
# NooblyJS Cloud (roadmap 8.1). hero-co depends on nooblyjs-core and three accelerators through file: links to sibling
# checkouts, so the build context is the folder that holds all three repositories:
#
#   <root>/nooblyjs-core
#   <root>/nooblyjs-accl/{nooblyjs-accel-customers,nooblyjs-accel-payments,nooblyjs-accl-infrastructure}
#   <root>/nooblyjs-apps/nooblyjs-apps-hero-co      (this file; Dockerfile.dockerignore beside it)
#
#   npm run docker:build        (docker build -f Dockerfile -t nooblyjs-cloud ../..)
#
# Run it with DATA_DIR on a volume (the infrastructure accelerator's store, core's sign-in records and telemetry live
# there) and the production environment in docs/production.md.

FROM node:24-bookworm-slim AS deps
WORKDIR /src
COPY nooblyjs-core/ nooblyjs-core/
COPY nooblyjs-accl/nooblyjs-accel-customers/ nooblyjs-accl/nooblyjs-accel-customers/
COPY nooblyjs-accl/nooblyjs-accel-payments/ nooblyjs-accl/nooblyjs-accel-payments/
COPY nooblyjs-accl/nooblyjs-accl-infrastructure/ nooblyjs-accl/nooblyjs-accl-infrastructure/
COPY nooblyjs-apps/nooblyjs-apps-hero-co/package.json nooblyjs-apps/nooblyjs-apps-hero-co/package-lock.json nooblyjs-apps/nooblyjs-apps-hero-co/
WORKDIR /src/nooblyjs-apps/nooblyjs-apps-hero-co
# --install-links copies the linked packages into node_modules (rather than symlinks to /src), so every package,
# core included, resolves its dependencies from this one node_modules: one copy of nooblyjs-core, and its optional
# mongodb driver found. No install scripts: ssh2's optional native speed-up is not needed.
RUN npm install --omit=dev --install-links --ignore-scripts --no-audit --no-fund \
 && node -e "const r = require('node:module').createRequire(require.resolve('nooblyjs-core')); for (const m of ['mongodb', 'ioredis']) r.resolve(m); if (require('node:fs').lstatSync('node_modules/nooblyjs-core').isSymbolicLink()) process.exit(1)"

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=11010 \
    DATA_DIR=/data \
    HERO_LOCAL_AGENT=off
WORKDIR /app
COPY --from=deps /src/nooblyjs-apps/nooblyjs-apps-hero-co/node_modules ./node_modules
COPY nooblyjs-apps/nooblyjs-apps-hero-co/package.json nooblyjs-apps/nooblyjs-apps-hero-co/app.js ./
COPY nooblyjs-apps/nooblyjs-apps-hero-co/src ./src
COPY nooblyjs-apps/nooblyjs-apps-hero-co/public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 11010
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health/ready`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "app.js"]
