// Cron schedules in UTC (public/js/shared/cron.js, roadmap 5.3): parsing with errors in words, matching, the next runs
// and the schedule in words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, cronMatches, nextRuns, describeCron } from '../public/js/shared/cron.js';

const iso = (dates) => dates.map((d) => d.toISOString());

test('parsing: fields, ranges, lists, steps and shorthands; mistakes are said in words', () => {
  assert.ok(!parseCron('0 2 * * *').error);
  assert.ok(!parseCron('  */15   9-17 * * 1-5 ').error);
  assert.equal(parseCron('  */15   9-17 * * 1-5 ').expression, '*/15 9-17 * * 1-5');
  assert.ok(!parseCron('@daily').error);
  assert.ok(!parseCron('0 0 1,15 * 7').error, 'Sunday as 7');
  assert.match(parseCron('0 2 * *').error, /five fields; this has 4/);
  assert.match(parseCron('60 * * * *').error, /minute field goes from 0 to 59/);
  assert.match(parseCron('0 24 * * *').error, /hour field goes from 0 to 23/);
  assert.match(parseCron('0 0 * * 8').error, /Sunday is 0/);
  assert.match(parseCron('0 0 * JAN *').error, /month field "JAN"/);
  assert.match(parseCron('*/0 * * * *').error, /step .* 1 or more/);
  assert.match(parseCron('').error, /Enter a schedule/);
  assert.match(parseCron(null).error, /Enter a schedule/);
});

test('matching and the next runs are in UTC; day of month and day of week together match either', () => {
  const daily = parseCron('0 2 * * *');
  assert.ok(cronMatches(daily, '2026-11-22T02:00:30Z'));
  assert.ok(!cronMatches(daily, '2026-11-22T02:01:00Z'));
  assert.deepEqual(iso(nextRuns('0 2 * * *', new Date('2026-11-22T02:00:00Z'))), ['2026-11-23T02:00:00.000Z', '2026-11-24T02:00:00.000Z', '2026-11-25T02:00:00.000Z']);
  assert.deepEqual(iso(nextRuns('*/15 * * * *', new Date('2026-11-22T10:07:12Z'), 2)), ['2026-11-22T10:15:00.000Z', '2026-11-22T10:30:00.000Z']);
  // 2026-11-22 is a Sunday: the next weekday 09:00 is Monday.
  assert.deepEqual(iso(nextRuns('0 9 * * 1-5', new Date('2026-11-22T12:00:00Z'), 1)), ['2026-11-23T09:00:00.000Z']);
  assert.deepEqual(iso(nextRuns('30 6 1 * *', new Date('2026-11-22T00:00:00Z'), 2)), ['2026-12-01T06:30:00.000Z', '2027-01-01T06:30:00.000Z']);
  assert.deepEqual(iso(nextRuns('0 0 29 2 *', new Date('2026-11-22T00:00:00Z'), 1)), [], 'no 29 February within a year');
  const either = parseCron('0 0 13 * 5');
  assert.ok(cronMatches(either, '2026-11-13T00:00:00Z'), 'the 13th');
  assert.ok(cronMatches(either, '2026-11-20T00:00:00Z'), 'a Friday');
  assert.ok(!cronMatches(either, '2026-11-21T00:00:00Z'));
  assert.deepEqual(nextRuns('nonsense'), []);
});

test('the schedule in words', () => {
  assert.equal(describeCron('0 2 * * *'), 'Every day at 02:00 UTC');
  assert.equal(describeCron('@daily'), 'Every day at 00:00 UTC');
  assert.equal(describeCron('* * * * *'), 'Every minute');
  assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(describeCron('0 * * * *'), 'Every hour, on the hour');
  assert.equal(describeCron('5 * * * *'), 'Every hour at 05 minutes past');
  assert.equal(describeCron('0 */6 * * *'), 'Every 6 hours at 00 minutes past (from 00:00 UTC)');
  assert.equal(describeCron('30 9 * * 1-5'), 'Every weekday (Monday to Friday) at 09:30 UTC');
  assert.equal(describeCron('0 3 * * 0'), 'Every Sunday at 03:00 UTC');
  assert.equal(describeCron('0 3 * * 1,3'), 'Every Mon, Wed at 03:00 UTC');
  assert.equal(describeCron('0 4 1 * *'), 'On day 1 of every month at 04:00 UTC');
  assert.equal(describeCron('0 4 1 6 *'), 'On the schedule 0 4 1 6 * (UTC)');
  assert.equal(describeCron('bad'), '');
});
