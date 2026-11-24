// One process per DATA_DIR (roadmap 8.7.7; the audit's P3): a second copy on the same folder refuses to start, a lock
// left by a copy that is gone is taken over, and a copy that loses its lock is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startApp, tempDir } from './helpers.js';
import { createApp } from '../src/app.js';
import { lockDataDir, readLock, LOCK_FILE } from '../src/platform/lock.js';

const quiet = { warn() {} };

/** Writes a lock as another process would have, touched `ageMs` ago. */
async function planted(dir, holder, ageMs = 0) {
  const file = path.join(dir, LOCK_FILE);
  await fs.writeFile(file, JSON.stringify({ startedAt: new Date().toISOString(), token: 'theirs', ...holder }));
  const at = new Date(Date.now() - ageMs);
  await fs.utimes(file, at, at);
  return file;
}

test('a second app on the same DATA_DIR refuses to start, and mounts nothing', async () => {
  const t = await startApp({ cards: false });
  try {
    const holder = await readLock(t.dataDir);
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.hostname, os.hostname());
    await assert.rejects(createApp({ config: t.config, lock: { waitMs: 0 } }), /Another NooblyJS Cloud is using .* \(pid \d+ on .*\)\. Run one process per DATA_DIR/);
    // It waits for a held lock to go stale before refusing (a start right after a stop that killed the old one).
    const started = Date.now();
    await assert.rejects(createApp({ config: t.config, lock: { waitMs: 300 } }), /Another NooblyJS Cloud/);
    assert.ok(Date.now() - started >= 300, 'waited');
    // The first app is untouched and still holds the lock.
    assert.equal((await t.get('/health/live')).status, 200);
    assert.equal((await readLock(t.dataDir)).token, holder.token);
  } finally {
    await t.close();
  }
});

test('shutdown releases the lock, so the next start takes it at once', async () => {
  const dir = await tempDir();
  const first = await lockDataDir(dir, { log: quiet });
  await first.release();
  assert.equal(await readLock(dir), null);
  const second = await lockDataDir(dir, { log: quiet, waitMs: 0 });
  assert.ok(await readLock(dir));
  await second.release();
});

test('a lock left by a process that is gone is taken over', async () => {
  const dir = await tempDir();
  // This host, a pid that is not running (a crash, or nodemon's restart): free at once, however fresh.
  await planted(dir, { pid: 2 ** 22 + 12345, hostname: os.hostname() });
  const a = await lockDataDir(dir, { log: quiet, waitMs: 0 });
  assert.equal((await readLock(dir)).pid, process.pid);
  await a.release();

  // Another host (a container killed without stopping): free once nobody has touched it for staleMs.
  await planted(dir, { pid: 1, hostname: 'another-container' }, 120_000);
  const b = await lockDataDir(dir, { log: quiet, waitMs: 0 });
  assert.equal((await readLock(dir)).hostname, os.hostname());
  await b.release();

  // Pid 1 of this very host, as in a restarted container: a previous life of this process, not a live holder.
  await planted(dir, { pid: process.pid, hostname: os.hostname() });
  const c = await lockDataDir(dir, { log: quiet, waitMs: 0 });
  await c.release();
});

test('a fresh lock of another host is respected; a file still being written counts as held', async () => {
  const dir = await tempDir();
  await planted(dir, { pid: 1, hostname: 'another-container' }, 5_000);
  await assert.rejects(lockDataDir(dir, { log: quiet, waitMs: 0 }), /pid 1 on another-container/);
  await fs.writeFile(path.join(dir, LOCK_FILE), '');
  await assert.rejects(lockDataDir(dir, { log: quiet, waitMs: 0 }), /a process that is starting/);
});

test('a process whose lock was taken from it is told, and stops touching it', async () => {
  const dir = await tempDir();
  let lostTo;
  const held = await lockDataDir(dir, { log: quiet, heartbeatMs: 20, onLost: (holder) => { lostTo = holder; } });
  await planted(dir, { pid: 4242, hostname: 'the-new-one' });
  for (let i = 0; i < 50 && !lostTo; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(lostTo?.hostname, 'the-new-one');
  assert.equal(held.lost, true);
  await held.release();
  assert.equal((await readLock(dir)).hostname, 'the-new-one', 'release leaves the new holder\'s lock alone');
});

test('the holder keeps its lock fresh', async () => {
  const dir = await tempDir();
  const held = await lockDataDir(dir, { log: quiet, heartbeatMs: 20 });
  const old = new Date(Date.now() - 30_000);
  await fs.utimes(path.join(dir, LOCK_FILE), old, old);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(Date.now() - (await readLock(dir)).touchedAt < 5_000, 'touched again');
  await held.release();
});
