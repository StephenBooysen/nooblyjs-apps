#!/usr/bin/env bash
# Installs hero-co and the packages it links to (nooblyjs-core and three accelerators, sibling checkouts beside
# nooblyjs-apps). npm links file: dependencies, and Node resolves a linked package's own imports from its real folder,
# so each one needs its own node_modules: without them, start-up fails with "Cannot find module 'nooblyjs-core/...'".
#
#   npm run setup        (from this folder; CI runs the same)
#
# Uses `npm ci` where a package has a lockfile in step with its package.json, `npm install` otherwise.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

install() {
  local dir="$1"
  if [ ! -f "$dir/package.json" ]; then
    echo "Missing $dir: check out nooblyjs-core and nooblyjs-accl beside nooblyjs-apps (in $ROOT)." >&2
    exit 1
  fi
  echo "==> $dir"
  if [ -f "$dir/package-lock.json" ] && (cd "$dir" && npm ci --no-audit --no-fund); then
    return
  fi
  (cd "$dir" && npm install --no-audit --no-fund)
}

install "$ROOT/nooblyjs-core"
install "$ROOT/nooblyjs-accl/nooblyjs-accel-customers"
install "$ROOT/nooblyjs-accl/nooblyjs-accel-payments"
install "$ROOT/nooblyjs-accl/nooblyjs-accl-infrastructure"
install "$HERE"
