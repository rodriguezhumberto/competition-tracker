import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickerClock, reportClockFields } from '../src/lib/report-clock-client.ts';
import { resolveReportTime } from '../src/lib/report-time.ts';

test('the picker displays explicit timestamps in the configured timezone and retains milliseconds', () => {
  assert.equal(
    pickerClock('2026-10-12T20:15:30.850Z', 'America/Chicago'),
    '2026-10-12T15:15:30.85',
  );
  assert.equal(
    pickerClock('2026-10-12T20:15:30.123Z', 'America/Chicago'),
    '2026-10-12T15:15:30.123',
  );
  assert.equal(pickerClock('2026-10-12T20:15:30Z', 'Asia/Kolkata'), '2026-10-13T01:45:30');
  assert.equal(pickerClock('2026-10-12T15:15', 'America/Chicago'), '2026-10-12T15:15');
});

test('review preserves the extracted instant until the date or time is edited', () => {
  const context = {
    timezone: 'America/Chicago',
    report: {
      generated_at: '2026-10-12T20:15:30.123Z',
      period_start: '',
      period_end: '',
      rows: [],
    },
  };
  assert.equal(reportClockFields.reportClock.call(context), '2026-10-12T15:15:30.123');
  assert.equal(context.report.generated_at, '2026-10-12T20:15:30.123Z');
  reportClockFields.updateReportClock.call(context, '2026-10-12T15:45');
  assert.equal(
    resolveReportTime(context.report.generated_at, context.timezone),
    '2026-10-12T20:45:00.000Z',
  );
});
