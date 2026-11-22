// The watch screens' number formats (public/js/format.js): units always, limits where there are some.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuText, memoryText, memoryParts, bytesText, rateParts, countText, pctOf, ago, uptime, logTime, duration, msText, until, utcText } from '../public/js/format.js';

test('CPU, memory, bytes and counts carry their units', () => {
  assert.deepEqual([cpuText(0.414), cpuText(0.004), cpuText(0), cpuText(12.34), cpuText(null)], ['0.41', '<0.01', '0', '12.3', '—']);
  assert.deepEqual([memoryText(58.46), memoryText(512), memoryText(2252.8), memoryText(16384), memoryText(null)], ['58.5 MB', '512 MB', '2.2 GB', '16 GB', '—']);
  assert.deepEqual(memoryParts(1024), ['1', 'GB']);
  assert.deepEqual([bytesText(999), bytesText(67_526_076), bytesText(100e9), bytesText(12_400_000_000)], ['999 B', '67.5 MB', '100 GB', '12.4 GB']);
  assert.deepEqual(rateParts(3_100_000), ['3.1', 'MB/s']);
  assert.deepEqual([countText(1240.4), countText(null)], ['1,240', '—']);
  assert.deepEqual([pctOf(0.84, 2), pctOf(3, 2), pctOf(null, 2), pctOf(1, 0)], [42, 100, 0, 0]);
});

test('times: how long ago, uptime, log times and deploy durations', () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  const at = (s) => new Date(now - s * 1000).toISOString();
  assert.deepEqual([ago(at(10), now), ago(at(720), now), ago(at(3 * 3600), now), ago(at(2 * 86400), now), ago(null, now)], ['just now', '12 min ago', '3 hours ago', '2 days ago', '']);
  assert.deepEqual([uptime(at(40), now), uptime(at(720), now), uptime(at(3 * 3600), now), uptime(at(86400), now), uptime(null, now)], ['Up 40 s', 'Up 12 min', 'Up 3 h', 'Up 1 day', 'Not started']);
  assert.match(logTime('2026-11-22T08:21:04.112Z'), /^\d\d:21:04\.112$/);
  assert.equal(logTime('nonsense'), '');
  assert.deepEqual([duration(at(48), at(0)), duration(at(192), at(0)), duration(at(120), at(0)), duration(null, at(0))], ['48 s', '3 min 12 s', '2 min', '']);
});

test('runs: how long they took, how long until the next, and its time in UTC', () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  assert.deepEqual([msText(5), msText(4210), msText(42_400), msText(192_000), msText(120_000), msText(null)], ['under 1 s', '4.2 s', '42 s', '3 min 12 s', '2 min', '—']);
  const at = (s) => new Date(now + s * 1000).toISOString();
  assert.deepEqual([until(at(20), now), until(at(720), now), until(at(3 * 3600), now), until(at(2 * 86400), now), until(null, now)], ['in under a minute', 'in 12 min', 'in 3 hours', 'in 2 days', '']);
  assert.deepEqual([utcText('2026-11-22T16:30:00Z', now), utcText('2026-11-23T02:00:00Z', now), utcText('nonsense', now)], ['16:30 UTC', 'Mon 23 Nov, 02:00 UTC', '']);
});
