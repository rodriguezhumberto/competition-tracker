import { ensure, label } from './validation.ts';

export interface Metric {
  id?: number;
  key: string;
  label: string;
  type: 'integer' | 'decimal' | 'currency';
  precision: number;
  currency: string;
  mode: 'daily' | 'additive' | 'latest';
  required: boolean;
  public: boolean;
  direction: 'desc' | 'asc';
  minimum: string | null;
  maximum: string | null;
  position: number;
}
export interface ReportProfile {
  identifier_label: string;
  identifier_aliases: string;
  date_instructions: string;
  columns: Record<string, string>;
}
export const modeLabels = {
  daily: 'Daily running total',
  additive: 'Additive amount',
  latest: 'Latest value',
};
export const modeDescriptions = {
  daily:
    'Enter the running total for one day. Later reports contribute only the change; each day starts from zero.',
  additive: 'Each new report adds its amount. Enter only new activity, not a running total.',
  latest:
    'The most recent value in the selected period is the score. Values are not added together.',
};
export function newMetric(key = 'metric_1'): Metric {
  return {
    key,
    label: '',
    type: 'decimal',
    precision: 2,
    currency: 'USD',
    mode: 'daily',
    required: true,
    public: true,
    direction: 'desc',
    minimum: null,
    maximum: null,
    position: 0,
  };
}
export function scaled(value: unknown, precision: number, field = 'Value'): bigint {
  ensure(typeof value === 'string' || typeof value === 'number', `${field} is required.`);
  const raw = String(value).trim();
  ensure(
    /^[-+]?\d+(?:\.\d+)?$/.test(raw) && raw.length <= 40,
    `${field} must be a signed decimal.`,
  );
  const [whole, fraction = ''] = raw.replace(/^[-+]/, '').split('.');
  ensure(fraction.length <= precision, `${field} allows at most ${precision} decimal places.`);
  const result =
    BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0') || '0');
  ensure(
    result <= 1_000_000_000n * 10n ** BigInt(precision),
    `${field} must be within ±1,000,000,000.`,
  );
  return raw.startsWith('-') ? -result : result;
}
export function decimal(value: bigint | number, precision: number): string {
  const n = BigInt(value),
    raw = (n < 0n ? -n : n).toString().padStart(precision + 1, '0');
  return `${n < 0n ? '-' : ''}${precision ? `${raw.slice(0, -precision)}.${raw.slice(-precision)}` : raw}`;
}
export function metricValue(value: unknown, metric: Metric): number {
  const amount = scaled(value, metric.precision, metric.label);
  if (metric.minimum !== null)
    ensure(
      amount >= scaled(metric.minimum, metric.precision),
      `${metric.label} must be at least ${metric.minimum}.`,
    );
  if (metric.maximum !== null)
    ensure(
      amount <= scaled(metric.maximum, metric.precision),
      `${metric.label} must be at most ${metric.maximum}.`,
    );
  return Number(amount);
}
export function validateMetrics(value: unknown): Metric[] {
  ensure(Array.isArray(value) && value.length > 0 && value.length <= 20, 'Define 1–20 metrics.');
  const metrics = value.map((raw, position) => {
    ensure(raw && typeof raw === 'object', 'Invalid metric definition.');
    ensure(
      typeof raw.key === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(raw.key),
      'Invalid metric key.',
    );
    ensure(['integer', 'decimal', 'currency'].includes(raw.type), 'Choose a numeric metric type.');
    const precision = Number(raw.precision);
    ensure(
      Number.isInteger(precision) &&
        precision >= 0 &&
        precision <= 6 &&
        (raw.type !== 'integer' || precision === 0),
      'Precision must be 0–6; whole numbers use 0.',
    );
    ensure(['daily', 'additive', 'latest'].includes(raw.mode), 'Choose a scoring mode.');
    ensure(['asc', 'desc'].includes(raw.direction), 'Choose a ranking direction.');
    for (const key of ['public', 'required'])
      ensure(typeof raw[key] === 'boolean', `Invalid ${key} setting.`);
    const currency = String(raw.currency || 'USD').toUpperCase();
    ensure(
      /^[A-Z]{3}$/.test(currency) && Intl.supportedValuesOf('currency').includes(currency),
      'Choose a supported currency code.',
    );
    const metric: Metric = {
      key: raw.key,
      label: label(raw.label, 'Metric label'),
      type: raw.type,
      precision,
      currency,
      mode: raw.mode,
      required: raw.required,
      public: raw.public,
      direction: raw.direction,
      minimum: raw.minimum == null || raw.minimum === '' ? null : String(raw.minimum),
      maximum: raw.maximum == null || raw.maximum === '' ? null : String(raw.maximum),
      position,
    };
    if (metric.minimum !== null) scaled(metric.minimum, precision, 'Minimum');
    if (metric.maximum !== null) scaled(metric.maximum, precision, 'Maximum');
    if (metric.minimum !== null && metric.maximum !== null)
      ensure(
        scaled(metric.minimum, precision) <= scaled(metric.maximum, precision),
        'Minimum must not exceed maximum.',
      );
    return metric;
  });
  ensure(new Set(metrics.map((m) => m.key)).size === metrics.length, 'Metric keys must be unique.');
  ensure(
    new Set(metrics.map((m) => m.label.toLowerCase())).size === metrics.length,
    'Give each metric a distinct label.',
  );
  return metrics;
}
export function validateProfile(raw: unknown, metrics: Metric[]): ReportProfile {
  ensure(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid report profile.');
  const p = raw as Record<string, any>;
  const bounded = (v: unknown, fallback: string, max: number) => {
    const s = v == null ? fallback : String(v).trim();
    ensure(s.length <= max, 'Report instructions are too long.');
    return s;
  };
  return {
    identifier_label: label(
      p.identifier_label || 'Operator number',
      'Participant identifier label',
    ),
    identifier_aliases: bounded(p.identifier_aliases, 'Cashier No, Operator No', 500),
    date_instructions: bounded(
      p.date_instructions,
      'Use the Generated timestamp and the printed report period.',
      2000,
    ),
    columns: Object.fromEntries(
      metrics.map((m) => [m.key, bounded(p.columns?.[m.key], m.label, 500) || m.label]),
    ),
  };
}
export function formatMetric(
  value: string | null,
  metric: Pick<Metric, 'type' | 'precision' | 'currency'>,
): string {
  if (value === null) return '—';
  // Intl accepts decimal strings at runtime, preserving precision beyond safe integers.
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: metric.precision,
    minimumFractionDigits: metric.type === 'currency' ? metric.precision : 0,
    ...(metric.type === 'currency' ? { style: 'currency', currency: metric.currency } : {}),
  }).format(value as unknown as number);
}
