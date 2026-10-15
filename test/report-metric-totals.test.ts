import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMetric } from '../src/lib/metrics.ts';
import { reportMetricTotal } from '../src/lib/report-metric-totals.ts';

test('review totals sum signed decimals exactly and format currency at its configured precision', () => {
  const metric = { ...newMetric('sales'), type: 'currency' as const };
  const rows = ['0.10', '0.20', '-0.05'].map((value) => ({
    participant_id: '1',
    values: { sales: value },
  }));
  assert.deepEqual(reportMetricTotal(rows, metric), { value: '$0.25', incomplete: false });
  assert.deepEqual(reportMetricTotal(rows, { ...metric, type: 'decimal' }), {
    value: '0.25',
    incomplete: false,
  });
});

test('missing and invalid cells flag partial totals rather than silently counting as zero', () => {
  const metric = newMetric('sales');
  const rows = ['12.34', '', null, 'bad', '1.234'].map((value) => ({
    participant_id: '1',
    values: { sales: value },
  }));
  assert.deepEqual(reportMetricTotal(rows, metric), { value: '12.34', incomplete: true });
  assert.deepEqual(reportMetricTotal(rows.slice(1), metric), { value: '—', incomplete: true });
  assert.deepEqual(reportMetricTotal([{ participant_id: '1', values: { sales: '0' } }], metric), {
    value: '0',
    incomplete: false,
  });
});
