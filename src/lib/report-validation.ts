import type { getCompetition } from './competition-config.ts';
import { dateOnly, ensure } from './validation.ts';
import { metricValue } from './metrics.ts';
import { itemCode } from './tracked-items.ts';
import { resolveReportTime } from './report-time.ts';

export interface ReportInput {
  item_code?: string;
  generated_at: string;
  period_start: string;
  period_end: string;
  rows: { participant_id: string; values: Record<string, string | number | null> }[];
}
export function participantId(raw: unknown): string {
  ensure(
    typeof raw === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._\/-]{0,79}$/u.test(raw.trim()),
    'Participant identifier must contain 1–80 letters, numbers, spaces or . _ / - characters.',
  );
  return raw.trim();
}
export function validateReport(c: ReturnType<typeof getCompetition>, raw: unknown) {
  ensure(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid report.');
  const input = raw as ReportInput;
  const code = c.multiple_items ? itemCode(input.item_code) : '';
  ensure(
    !c.multiple_items || c.items.some((item) => item.code === code),
    `Choose a configured ${c.item_label.toLowerCase()} before saving the report.`,
  );
  const timestamp = resolveReportTime(input.generated_at, c.timezone);
  ensure(Date.parse(timestamp) <= Date.now(), 'Reports cannot be future-dated.');
  const start = dateOnly(input.period_start),
    end = dateOnly(input.period_end);
  ensure(
    start <= end && start >= c.start_date && end <= c.end_date,
    'Report period must fall within the competition dates.',
  );
  ensure(
    end <= input.generated_at.slice(0, 10),
    'Report period cannot end after its generation date.',
  );
  if (c.metrics.some((m) => m.mode === 'daily'))
    ensure(
      start === end,
      'Daily running totals require a report covering one day. Upload separate daily reports.',
    );
  ensure(
    Array.isArray(input.rows) && input.rows.length > 0 && input.rows.length <= 100,
    'Include 1–100 participant rows.',
  );
  const rows = input.rows.map((rawRow) => {
    ensure(rawRow && typeof rawRow === 'object', 'Invalid report row.');
    const id = participantId(rawRow.participant_id);
    ensure(
      rawRow.values && typeof rawRow.values === 'object' && !Array.isArray(rawRow.values),
      `${id}: values are required.`,
    );
    ensure(
      Object.keys(rawRow.values).every((key) => c.metrics.some((m) => m.key === key)),
      `${id}: unknown metric. Reload the competition schema.`,
    );
    const values = c.metrics
      .map((m) => {
        const rawValue = rawRow.values[m.key];
        if (rawValue == null || rawValue === '') {
          ensure(
            !m.required,
            `${id}: ${m.label} is required. Correct the unreadable or missing value.`,
          );
          return null;
        }
        return { metric: m, value: metricValue(rawValue, m) };
      })
      .filter((v) => v !== null);
    ensure(values.length > 0, `${id}: enter at least one metric value.`);
    return { id, values };
  });
  ensure(
    new Set(rows.map((r) => r.id)).size === rows.length,
    'Each participant can appear only once per report.',
  );
  return { timestamp, start, end, rows, item_code: code };
}
