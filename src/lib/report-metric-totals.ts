import { decimal, formatMetric, scaled, type Metric } from './metrics.ts';
import type { ReportInput } from './report-validation.ts';

export function reportMetricTotal(rows: ReportInput['rows'], metric: Metric) {
  let sum = 0n;
  let count = 0;
  for (const row of rows) {
    try {
      sum += scaled(row.values[metric.key], metric.precision);
      count++;
    } catch {
      // Unreadable or unfinished cells must not make a partial sum look complete.
    }
  }
  return {
    value: count ? formatMetric(decimal(sum, metric.precision), metric) : '—',
    incomplete: count < rows.length,
  };
}
