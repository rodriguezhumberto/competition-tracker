export interface PowerHourMetricFormat {
  precision: number;
  type: 'integer' | 'decimal' | 'currency';
  currency: string;
}
export function formatPowerHourScore(value: number, metric?: PowerHourMetricFormat | null): string {
  if (!metric) return String(value);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: metric.precision,
    maximumFractionDigits: metric.precision,
    ...(metric.type === 'currency' ? { style: 'currency', currency: metric.currency } : {}),
  }).format(value);
}
