// One process per DATA_DIR (roadmap 8.7.7; the audit's P3). Two copies on the same folder (a rolling deploy, a second
// replica, `docker run` twice) would both run the cron scheduler, the Workflow queue, billing's hand-off and the
// infrastructure operations, and both read-modify-write the same JSON files.
//
// The lock is DATA_DIR/hero-co.lock, created with O_EXCL and touched every heartbeatMs while the process runs. A lock
// is free when it is missing, when its process is gone (same host), or when nobody has touched it for staleMs (a
// container killed without stopping, on another host). A process that finds its lock no longer its own (it was paused
// past staleMs and another took over) is told through onLost, and app.js stops it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const LOCK_FILE = 'hero-co.lock';
/** The tokens of the locks this process holds (a second createApp in one process is a second copy too). */
const HELD = new Set();

/** Whether a process of this host is running. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** The lock's holder and when it was last touched, or null when there is none. */
export async function readLock(dataDir) {
  const file = path.join(dataDir, LOCK_FILE);
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    let holder = {};
    try {
      holder = JSON.parse(text);
    } catch {
      // Being written by a process that has just created it: judged by its age alone.
    }
    return { ...holder, touchedAt: stat.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function isFree(holder, staleMs, now = Date.now()) {
  if (!holder) return true;
  if (holder.hostname === os.hostname() && Number.isInteger(holder.pid)) {
    // Our own pid on our own host, with a token we do not hold, is a previous life of this container (pid 1 again).
    if (holder.pid === process.pid) return !HELD.has(holder.token);
    if (!alive(holder.pid)) return true;
  }
  return now - holder.touchedAt > staleMs;
}

function describe(holder) {
  const since = holder.startedAt ? `, since ${holder.startedAt}` : '';
  return holder.pid ? `pid ${holder.pid} on ${holder.hostname}${since}` : 'a process that is starting';
}

/**
 * Takes DATA_DIR's lock, or throws when another process holds it.
 * @param {string} dataDir
 * @param {object} [o]
 * @param {number} [o.staleMs]      untouched this long, a lock is free (default 60 s)
 * @param {number} [o.heartbeatMs]  how often the holder touches it (default 10 s)
 * @param {number} [o.waitMs]       how long to wait for a held lock to go stale (default staleMs + 2 heartbeats;
 *                                  0 refuses at once: the CLI commands)
 * @param {(holder: object|null) => void} [o.onLost]   the lock is someone else's now
 * @param {{ warn?: Function }} [o.log]
 * @returns {Promise<{ file: string, release: () => Promise<void> }>}
 */
export async function lockDataDir(dataDir, { staleMs = 60_000, heartbeatMs = 10_000, waitMs, onLost = () => {}, log = console } = {}) {
  const file = path.join(dataDir, LOCK_FILE);
  const token = crypto.randomUUID();
  const body = `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), token }, null, 2)}\n`;
  const deadline = Date.now() + (waitMs ?? staleMs + 2 * heartbeatMs);
  let warned = false;

  for (;;) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
      if ((await readLock(dataDir))?.token === token) break;
      continue;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const holder = await readLock(dataDir);
    if (isFree(holder, staleMs)) {
      // Moved aside, not deleted: of two processes that both found it stale, only one rename succeeds.
      const aside = `${file}.stale-${token}`;
      await fs.rename(file, aside).then(() => fs.rm(aside, { force: true }), (err) => { if (err.code !== 'ENOENT') throw err; });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Another NooblyJS Cloud is using ${dataDir} (${describe(holder)}). Run one process per DATA_DIR: stop it first (deploy by stop-then-start). If it is gone for good, delete ${file}.`);
    }
    if (!warned) {
      log.warn?.(`[hero-co] ${dataDir} is in use by ${describe(holder)}: waiting up to ${Math.round((deadline - Date.now()) / 1000)} s for it to stop.`);
      warned = true;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(heartbeatMs, 1000, Math.max(deadline - Date.now(), 10))));
  }

  HELD.add(token);
  let lost = false;
  const beat = setInterval(async () => {
    try {
      const holder = await readLock(dataDir);
      if (holder?.token !== token) {
        lost = true;
        HELD.delete(token);
        clearInterval(beat);
        onLost(holder);
        return;
      }
      const now = new Date();
      await fs.utimes(file, now, now);
    } catch (err) {
      log.warn?.(`[hero-co] could not touch ${file}: ${err.message}`);
    }
  }, heartbeatMs);
  beat.unref();

  return {
    file,
    get lost() { return lost; },
    async release() {
      clearInterval(beat);
      HELD.delete(token);
      if ((await readLock(dataDir).catch(() => null))?.token === token) await fs.rm(file, { force: true });
    },
  };
}
