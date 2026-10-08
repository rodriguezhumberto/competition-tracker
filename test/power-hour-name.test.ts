import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestedPowerHourName } from '../src/lib/power-hour-name.ts';

test('suggested Power Hour names follow Chicago time at each boundary in winter and summer', () => {
  const cases = [
    ['00:00', 'Late Night'],
    ['04:59', 'Late Night'],
    ['05:00', 'Early Morning'],
    ['07:59', 'Early Morning'],
    ['08:00', 'Morning'],
    ['11:59', 'Morning'],
    ['12:00', 'Midday'],
    ['13:59', 'Midday'],
    ['14:00', 'Afternoon'],
    ['17:59', 'Afternoon'],
    ['18:00', 'Evening'],
    ['21:59', 'Evening'],
    ['22:00', 'Late Night'],
    ['23:59', 'Late Night'],
  ];
  for (const [date, offset] of [
    ['2026-01-15', '-06:00'],
    ['2026-07-15', '-05:00'],
  ]) {
    for (const [time, label] of cases) {
      const instant = new Date(`${date}T${time}:00${offset}`);
      assert.equal(suggestedPowerHourName(instant), `${label} Power Hour`, `${date} ${time}`);
    }
  }
});
