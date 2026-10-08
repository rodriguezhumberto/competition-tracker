import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { entries, report_values } from '../db/schema.ts';
import { ensure } from './validation.ts';
import { decimal } from './metrics.ts';
import { zonedClock } from './report-time.ts';
import { calendarWeek } from './calendar.ts';
import { getCompetition } from './competition-config.ts';

export class UnknownTrackedItemError extends Error {}

export function itemFilterErrorResponse(error: unknown, url: URL): Response | null {
  if (!(error instanceof UnknownTrackedItemError)) return null;
  const target = new URL(url);
  target.searchParams.delete('item');
  target.searchParams.delete('page');
  const href = (target.pathname + target.search)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Unknown item</title><body><h1>Unknown tracked item</h1><p>Choose a configured item or return to the combined standings.</p><a href="${href}">All items</a></body></html>`,
    {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' },
    },
  );
}

export interface Standing {
  operatorNumber: string;
  values: Record<string, string | null>;
  rank: number | null;
  updated: string;
}
export function leaderboard(
  id: number,
  options: {
    audience?: 'public' | 'admin';
    metric?: string | null;
    period?: string | null;
    item?: string | null;
    activityLimit?: number;
    activityOffset?: number;
    competition?: ReturnType<typeof getCompetition>;
  } = {},
) {
  const c = options.competition ?? getCompetition(id);
  ensure(c.id === id, 'Competition does not match the requested board.');
  const selectedItem = options.item || null;
  if (selectedItem && (!c.multiple_items || !c.items.some((item) => item.code === selectedItem)))
    throw new UnknownTrackedItemError(
      'Unknown tracked item. Choose a configured item or All items.',
    );
  // Audience is chosen by the authenticated server route, never a query parameter.
  const metrics = c.metrics.filter((m) => options.audience === 'admin' || m.public);
  const selected =
    metrics.find((m) => m.key === options.metric) ||
    metrics.find((m) => m.key === c.official_metric_key)!;
  const period = ['day', 'week'].includes(options.period || '') ? options.period! : 'lifetime';
  const today = zonedClock(c.timezone).slice(0, 10),
    week = calendarWeek(today);
  const start = period === 'day' ? today : period === 'week' ? week.start : c.start_date;
  const end = period === 'day' ? today : period === 'week' ? week.end : c.end_date;
  const observations = db
    .select({
      operator: entries.operator_number,
      itemCode: entries.item_code,
      metricId: report_values.metric_id,
      value: report_values.value,
      contribution: report_values.contribution,
      timestamp: entries.timestamp_on_report,
    })
    .from(entries)
    .innerJoin(report_values, eq(report_values.entry_id, entries.id))
    .where(
      and(
        eq(entries.competition_id, id),
        selectedItem ? eq(entries.item_code, selectedItem) : undefined,
        sql`${entries.report_date} >= ${start}`,
        sql`${entries.report_date} <= ${end}`,
      ),
    )
    .orderBy(asc(entries.timestamp_on_report))
    .all();
  const people = new Map<
    string,
    { values: Map<string, bigint>; latest: Map<string, bigint>; updated: string }
  >();
  const coverage = new Map<string, string>();
  const metricsById = new Map(metrics.map((metric) => [metric.id, metric]));
  for (const observation of observations) {
    coverage.set(observation.itemCode, observation.timestamp);
    const metric = metricsById.get(observation.metricId);
    if (!metric) continue;
    const person = people.get(observation.operator) || {
      values: new Map<string, bigint>(),
      latest: new Map<string, bigint>(),
      updated: observation.timestamp,
    };
    if (metric.mode === 'latest') {
      // Replace only this item's latest observation, retaining all other items.
      const key = JSON.stringify([metric.key, observation.itemCode]);
      const previous = person.latest.get(key) ?? 0n;
      const value = BigInt(observation.value);
      person.latest.set(key, value);
      person.values.set(metric.key, (person.values.get(metric.key) ?? 0n) - previous + value);
    } else {
      person.values.set(
        metric.key,
        (person.values.get(metric.key) ?? 0n) + BigInt(observation.contribution ?? 0),
      );
    }
    person.updated = observation.timestamp;
    people.set(observation.operator, person);
  }
  const sorted = [...people].sort(([a, av], [b, bv]) => {
    const x = av.values.get(selected.key),
      y = bv.values.get(selected.key);
    if (x === undefined && y !== undefined) return 1;
    if (y === undefined && x !== undefined) return -1;
    if (x !== undefined && y !== undefined && x !== y)
      return (x < y ? -1 : 1) * (selected.direction === 'asc' ? 1 : -1);
    return a.localeCompare(b, 'en', { numeric: true }) || a.localeCompare(b);
  });
  let previous: bigint | undefined,
    rank = 0;
  const rows: Standing[] = sorted.map(([operatorNumber, person], index) => {
    const score = person.values.get(selected.key);
    if (score !== undefined && (previous === undefined || score !== previous)) rank = index + 1;
    previous = score;
    return {
      operatorNumber,
      values: Object.fromEntries(
        metrics.map((m) => [
          m.key,
          person.values.has(m.key) ? decimal(person.values.get(m.key)!, m.precision) : null,
        ]),
      ),
      rank: score === undefined ? null : rank,
      updated: person.updated,
    };
  });
  const total = decimal(
    [...people.values()].reduce((sum, p) => sum + (p.values.get(selected.key) ?? 0n), 0n),
    selected.precision,
  );
  const updatesQuery = db
    .select({
      operatorNumber: entries.operator_number,
      itemCode: entries.item_code,
      timestamp: entries.timestamp_on_report,
      value: report_values.value,
      contribution: report_values.contribution,
    })
    .from(report_values)
    .innerJoin(entries, eq(entries.id, report_values.entry_id))
    .where(
      and(
        eq(entries.competition_id, id),
        selectedItem ? eq(entries.item_code, selectedItem) : undefined,
        eq(report_values.metric_id, selected.id),
        sql`${entries.report_date} >= ${start}`,
        sql`${entries.report_date} <= ${end}`,
      ),
    )
    .orderBy(desc(entries.timestamp_on_report), desc(entries.id));
  const limit = Math.max(1, Math.min(20, Math.trunc(options.activityLimit || 4)));
  const offset = Math.max(0, Math.min(2_000_000, Math.trunc(options.activityOffset || 0)));
  const activity = updatesQuery
    .limit(limit + 1)
    .offset(offset)
    .all();
  const hasMoreUpdates = activity.length > limit;
  const updates = activity.slice(0, limit).map((v) => ({
    operatorNumber: v.operatorNumber,
    itemCode: v.itemCode,
    itemName: c.items.find((item) => item.code === v.itemCode)?.name ?? v.itemCode,
    timestamp: v.timestamp,
    amount: decimal(
      selected.mode === 'latest' ? v.value : (v.contribution ?? 0),
      selected.precision,
    ),
  }));
  // Return presentation metadata only. Report instructions never reach public pages.
  return {
    competition: {
      id: c.id,
      name: c.name,
      start_date: c.start_date,
      end_date: c.end_date,
      timezone: c.timezone,
      official_metric_key: c.official_metric_key,
    },
    metrics: metrics.map(({ key, label, type, precision, currency, direction, mode }) => ({
      key,
      label,
      type,
      precision,
      currency,
      direction,
      mode,
    })),
    selected: {
      key: selected.key,
      label: selected.label,
      type: selected.type,
      precision: selected.precision,
      currency: selected.currency,
      direction: selected.direction,
      mode: selected.mode,
    },
    identifierLabel: c.profile.identifier_label,
    multipleItems: c.multiple_items,
    itemLabel: c.item_label,
    selectedItem,
    items: c.items.map((item) => ({ ...item, updated: coverage.get(item.code) ?? null })),
    rows,
    total,
    period,
    updates,
    hasMoreUpdates,
  };
}
