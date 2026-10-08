import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReportTime, zonedClock, zonedReportTime, validTimezone } from '../src/lib/time.ts';
import { centralReportTime, centralWeek } from '../src/lib/central-time.ts';
import { calendarWeek } from '../src/lib/calendar.ts';
test('shared time conversion preserves milliseconds, fractional offsets and explicit printed offsets', () => {
  assert.equal(
    resolveReportTime('2026-01-01T00:00:00.125', 'America/Chicago'),
    '2026-01-01T06:00:00.125Z',
  );
  assert.equal(
    resolveReportTime('2026-07-01T00:00:00.1', 'America/Chicago'),
    '2026-07-01T05:00:00.100Z',
  );
  assert.equal(
    resolveReportTime('2026-01-01T00:00:00.12', 'Asia/Kathmandu'),
    '2025-12-31T18:15:00.120Z',
  );
  assert.equal(
    resolveReportTime('2026-01-01T00:00:00+02:00', 'America/Chicago'),
    '2025-12-31T22:00:00.000Z',
  );
  assert.equal(
    zonedClock('America/Chicago', new Date('2026-01-01T05:59:59Z')),
    '2025-12-31T23:59:59',
  );
  assert.equal(centralReportTime('2026-01-01T06:00:00Z'), '2026-01-01 00:00:00 CST');
  assert.equal(centralReportTime('2026-07-01T05:00:00Z'), '2026-07-01 00:00:00 CDT');
  assert.match(zonedReportTime('2026-01-01T00:00:00Z', 'Asia/Kathmandu'), /^2026-01-01 05:45:00 /);
});
test('strict parsing rejects invalid dates, clocks, offsets and DST gaps or ambiguous clocks', () => {
  for (const value of [
    '2026-02-29T12:00',
    '2026-01-01T24:00',
    '2026-01-01T12:60',
    '2026-01-01T12:00+24:00',
    '2026-01-01T12:00+01:60',
  ])
    assert.throws(() => resolveReportTime(value, 'America/Chicago'));
  assert.throws(
    () => resolveReportTime('2026-03-08T02:30:00.100', 'America/Chicago'),
    /does not exist/,
  );
  assert.throws(
    () => resolveReportTime('2026-11-01T01:30:00.100', 'America/Chicago'),
    /occurs twice/,
  );
  assert.equal(
    resolveReportTime('2026-11-01T01:30:00.100-06:00', 'America/Chicago'),
    '2026-11-01T07:30:00.100Z',
  );
  assert.throws(() => validTimezone('Mars/Base'));
  assert.deepEqual(calendarWeek('2026-01-01'), { start: '2025-12-29', end: '2026-01-04' });
  assert.deepEqual(centralWeek('2026-01-01'), calendarWeek('2026-01-01'));
});
