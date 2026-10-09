import { and, asc, desc, eq, or } from 'drizzle-orm';
import { db, sqlite } from '../db/index.ts';
import {
  competitions,
  competition_metrics,
  report_values,
  reports,
  power_hour_reports,
  power_hour_sessions,
} from '../db/schema.ts';
import { dateOnly, ensure, label, positiveId } from './validation.ts';
import { validateMetrics, validateProfile } from './metrics.ts';
import { itemConfiguration, type TrackedItem } from './tracked-items.ts';
import { validTimezone } from './report-time.ts';

export function getCompetitions() {
  return db.select().from(competitions).orderBy(desc(competitions.id)).all();
}
export function currentCompetition() {
  return db.select().from(competitions).where(eq(competitions.is_active, true)).get();
}
export function getCompetition(id: unknown) {
  const competition = db
    .select()
    .from(competitions)
    .where(eq(competitions.id, positiveId(id)))
    .get();
  ensure(competition, 'Competition not found.');
  const metrics = db
    .select()
    .from(competition_metrics)
    .where(eq(competition_metrics.competition_id, competition.id))
    .orderBy(asc(competition_metrics.position))
    .all();
  return {
    ...competition,
    items: JSON.parse(competition.tracked_items) as TrackedItem[],
    metrics,
    profile: validateProfile(JSON.parse(competition.report_profile), metrics),
  };
}
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
export function addCompetition(input: Record<string, unknown>) {
  const items = itemConfiguration(input);
  const start = dateOnly(input.start_date),
    end = dateOnly(input.end_date);
  ensure(start <= end, 'End date must be on or after the start date.');
  const metrics = validateMetrics(parse(input.metrics));
  const official = String(input.official_metric_key || metrics[0].key);
  ensure(
    metrics.some((m) => m.key === official && m.public),
    'The official ranking metric must be public.',
  );
  const profile = validateProfile(input.profile ? parse(input.profile) : { columns: {} }, metrics);
  return sqlite
    .transaction(() => {
      const active = input.is_active === 'on' || input.is_active === true;
      if (active) db.update(competitions).set({ is_active: false }).run();
      const c = db
        .insert(competitions)
        .values({
          name: label(input.name, 'Competition name'),
          metric_label: metrics.find((m) => m.key === official)!.label,
          start_date: start,
          end_date: end,
          is_active: active,
          timezone: validTimezone(input.timezone || 'America/Chicago'),
          official_metric_key: official,
          report_profile: JSON.stringify(profile),
          ...items,
        })
        .returning()
        .get();
      db.insert(competition_metrics)
        .values(metrics.map((m) => ({ ...m, competition_id: c.id })))
        .run();
      return c;
    })
    .immediate();
}
export function activateCompetition(id: unknown) {
  sqlite
    .transaction(() => {
      const target = getCompetition(id);
      db.update(competitions).set({ is_active: false }).run();
      db.update(competitions).set({ is_active: true }).where(eq(competitions.id, target.id)).run();
    })
    .immediate();
}
export function updateCompetition(input: Record<string, unknown>) {
  return sqlite
    .transaction(() => {
      const c = getCompetitionForEditing(input.competition_id);
      ensure(
        !db
          .select({ id: power_hour_sessions.id })
          .from(power_hour_sessions)
          .where(
            and(
              eq(power_hour_sessions.competition_id, c.id),
              eq(power_hour_sessions.report_mode, true),
              or(
                eq(power_hour_sessions.status, 'active'),
                eq(power_hour_sessions.status, 'processing'),
              ),
            ),
          )
          .get(),
        'This report configuration is in use by a live Power Hour. End the Power Hour before editing it.',
      );
      ensure(
        Number(input.schema_version) === c.schema_version,
        'Competition settings changed. Reload before editing.',
      );
      const items = itemConfiguration({
        multiple_items: c.multiple_items,
        item_label: c.item_label,
        items: c.items,
        ...input,
      });
      const usedReports = c.usedItemCodes.map((code) => ({ code }));
      if (c.hasReports && !usedReports.length) usedReports.push({ code: '' });
      ensure(
        !usedReports.length || items.multiple_items === c.multiple_items,
        'Tracking multiple items is locked after reports exist.',
      );
      const nextItems = JSON.parse(items.tracked_items) as TrackedItem[];
      ensure(
        usedReports.every(
          (report) => !report.code || nextItems.some((item) => item.code === report.code),
        ),
        'Report codes used by saved reports cannot be removed or changed.',
      );
      const metrics = validateMetrics(parse(input.metrics));
      ensure(
        c.metrics.every((m) => metrics.some((next) => next.key === m.key)),
        'Existing metrics cannot be removed; make them private instead.',
      );
      const added = metrics.some((m) => !c.metrics.some((old) => old.key === m.key));
      if (added)
        ensure(
          input.confirm_add === true,
          'Confirm that new metrics leave earlier reports without values.',
        );
      const official = String(input.official_metric_key);
      ensure(
        metrics.some((m) => m.key === official && m.public),
        'The official ranking metric must be public.',
      );
      const oldOfficial = c.metrics.find((m) => m.key === c.official_metric_key)!;
      const newOfficial = metrics.find((m) => m.key === official)!;
      if (official !== c.official_metric_key || oldOfficial.direction !== newOfficial.direction)
        ensure(
          input.confirm_ranking === true,
          'Confirm that this changes the official ranking using existing values.',
        );
      for (const m of metrics) {
        const previous = c.metrics.find((p) => p.key === m.key);
        if (previous) {
          const used = c.lockedMetricKeys.includes(previous.key);
          if (used)
            for (const field of ['type', 'precision', 'currency', 'mode'] as const)
              ensure(
                m[field] === previous[field],
                `${previous.label}: type, precision, currency and scoring mode are locked after values exist.`,
              );
          db.update(competition_metrics)
            .set(m)
            .where(eq(competition_metrics.id, previous.id))
            .run();
        } else
          db.insert(competition_metrics)
            .values({ ...m, competition_id: c.id })
            .run();
      }
      const profile = validateProfile(parse(input.profile), metrics);
      const changedProfile = JSON.stringify(profile) !== JSON.stringify(c.profile);
      db.update(competitions)
        .set({
          ...items,
          metric_label: newOfficial.label,
          official_metric_key: official,
          report_profile: JSON.stringify(profile),
          schema_version: c.schema_version + 1,
          profile_version: c.profile_version + (changedProfile ? 1 : 0),
        })
        .where(eq(competitions.id, c.id))
        .run();
      return getCompetitionForEditing(c.id);
    })
    .immediate();
}

// Editing needs usage metadata; public reads and report imports do not.
export function getCompetitionForEditing(id: unknown) {
  const competition = getCompetition(id);
  const used = db
    .selectDistinct({ key: competition_metrics.key })
    .from(report_values)
    .innerJoin(competition_metrics, eq(competition_metrics.id, report_values.metric_id))
    .where(eq(competition_metrics.competition_id, competition.id))
    .all();
  const usedReports = db
    .selectDistinct({ code: reports.item_code })
    .from(reports)
    .where(eq(reports.competition_id, competition.id))
    .all();
  const powerHourMetrics = db
    .selectDistinct({ key: competition_metrics.key })
    .from(power_hour_sessions)
    .innerJoin(
      competition_metrics,
      eq(power_hour_sessions.report_metric_id, competition_metrics.id),
    )
    .where(eq(power_hour_sessions.competition_id, competition.id))
    .all();
  const powerHourItems = db
    .selectDistinct({ code: power_hour_reports.item_code })
    .from(power_hour_reports)
    .innerJoin(power_hour_sessions, eq(power_hour_reports.session_id, power_hour_sessions.id))
    .where(eq(power_hour_sessions.competition_id, competition.id))
    .all();
  return {
    ...competition,
    lockedMetricKeys: [...new Set([...used, ...powerHourMetrics].map((metric) => metric.key))],
    hasReports: usedReports.length > 0 || powerHourItems.length > 0,
    usedItemCodes: [
      ...new Set([...usedReports, ...powerHourItems].map((report) => report.code).filter(Boolean)),
    ],
  };
}

// Load the admin forms' configurations once, independent of competition count.
export function getCompetitionConfigurations() {
  const competitions = getCompetitions();
  const metrics = db
    .select()
    .from(competition_metrics)
    .orderBy(asc(competition_metrics.position))
    .all();
  const byCompetition = new Map<number, typeof metrics>();
  for (const metric of metrics) {
    const group = byCompetition.get(metric.competition_id) ?? [];
    group.push(metric);
    byCompetition.set(metric.competition_id, group);
  }
  return competitions.map((competition) => {
    const metrics = byCompetition.get(competition.id) ?? [];
    return {
      ...competition,
      items: JSON.parse(competition.tracked_items) as TrackedItem[],
      metrics,
      profile: validateProfile(JSON.parse(competition.report_profile), metrics),
    };
  });
}
