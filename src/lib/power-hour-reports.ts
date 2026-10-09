import { and, asc, desc, eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.ts';
import {
  power_hour_sessions,
  power_hour_reports,
  power_hour_report_values,
  report_drafts,
} from '../db/schema.ts';
import { getCompetition } from './competition-config.ts';
import { reviewableDraft, checkDraftRevision } from './draft-store.ts';
import { validateReport } from './report-validation.ts';
import { ensure } from './validation.ts';
import { events } from './events.ts';

export function preparePowerHourReport(input: Record<string, unknown>, baseline = false) {
  ensure(
    input.confirmed === true || input.confirmed === 'true',
    'Review and confirm the report before saving.',
  );
  const draft = reviewableDraft(baseline ? input.baseline_token : input.token);
  checkDraftRevision(draft, Number(baseline ? input.baseline_revision : input.revision));
  const competition = getCompetition(draft.competition_id);
  ensure(
    draft.schema_version === competition.schema_version &&
      draft.profile_version === competition.profile_version,
    'Competition settings changed. Scan and review the report again.',
  );
  const raw = baseline ? input.baseline_report : input.report;
  const report = validateReport(competition, typeof raw === 'string' ? JSON.parse(raw) : raw);
  return { draft, competition, report };
}

export function insertPowerHourReport(
  sessionId: number,
  prepared: ReturnType<typeof preparePowerHourReport>,
  metricId: number,
) {
  const { report, draft } = prepared;
  const rows = report.rows.map((row) => {
    const value = row.values.find((v) => v.metric.id === metricId)?.value;
    ensure(value !== undefined, `Operator ${row.id}: the tracked metric is required.`);
    return { operator_number: row.id, value };
  });
  const saved = db
    .insert(power_hour_reports)
    .values({
      session_id: sessionId,
      timestamp: report.timestamp,
      period_start: report.start,
      period_end: report.end,
      item_code: report.item_code,
      proof_image_path: draft.proof_image_path,
    })
    .returning()
    .get();
  db.insert(power_hour_report_values)
    .values(rows.map((row) => ({ ...row, report_id: saved.id })))
    .run();
  db.delete(report_drafts).where(eq(report_drafts.token, draft.token)).run();
  return saved;
}

export function powerHourReportHistory(sessionId: number) {
  return db
    .select()
    .from(power_hour_reports)
    .where(eq(power_hour_reports.session_id, sessionId))
    .orderBy(desc(power_hour_reports.timestamp))
    .all();
}

export function reportSessionScores(sessionId: number, precision: number) {
  const values = db
    .select({
      id: power_hour_report_values.id,
      operator: power_hour_report_values.operator_number,
      item: power_hour_reports.item_code,
      value: power_hour_report_values.value,
    })
    .from(power_hour_report_values)
    .innerJoin(power_hour_reports, eq(power_hour_reports.id, power_hour_report_values.report_id))
    .where(eq(power_hour_reports.session_id, sessionId))
    .orderBy(asc(power_hour_reports.timestamp), asc(power_hour_report_values.id))
    .all();
  const operators = new Map<
    string,
    { userId: number; name: string; items: Map<string, { baseline: number; latest: number }> }
  >();
  for (const row of values) {
    const operator = operators.get(row.operator) ?? {
      userId: row.id,
      name: row.operator,
      items: new Map(),
    };
    operator.userId = Math.min(operator.userId, row.id);
    const item = operator.items.get(row.item) ?? { baseline: row.value, latest: row.value };
    item.latest = row.value;
    operator.items.set(row.item, item);
    operators.set(row.operator, operator);
  }
  return [...operators.values()]
    .map((operator) => ({
      userId: operator.userId,
      name: operator.name,
      clicks:
        [...operator.items.values()].reduce((sum, item) => sum + item.latest - item.baseline, 0) /
        10 ** precision,
      flagged: false,
    }))
    .filter((row) => row.clicks > 0)
    .sort((a, b) => b.clicks - a.clicks || a.name.localeCompare(b.name));
}

export function savePowerHourReport(input: Record<string, unknown>) {
  const saved = sqlite
    .transaction(() => {
      const session = db
        .select()
        .from(power_hour_sessions)
        .where(eq(power_hour_sessions.id, Number(input.session_id)))
        .get();
      ensure(
        session?.report_mode && session.report_metric_id,
        'Choose a report-driven Power Hour.',
      );
      const prepared = preparePowerHourReport(input);
      ensure(
        prepared.competition.id === session.competition_id,
        'Choose the report format used by this Power Hour.',
      );
      ensure(
        prepared.competition.schema_version === session.report_schema_version &&
          prepared.competition.profile_version === session.report_profile_version,
        'The Power Hour report configuration changed. Start a new Power Hour with the updated configuration.',
      );
      const report = prepared.report;
      const history = powerHourReportHistory(session.id).filter(
        (item) => item.item_code === report.item_code,
      );
      const previous = history[0],
        baseline = history.at(-1);
      ensure(
        report.timestamp >= session.created_at,
        'Report timestamp falls before the Power Hour start.',
      );
      ensure(
        !previous || report.timestamp > previous.timestamp,
        'Report timestamp must be newer than the previous accepted report for this item.',
      );
      ensure(
        report.timestamp <= session.ends_at,
        'Report timestamp falls after the Power Hour end. Add time before uploading this report.',
      );
      ensure(
        !baseline || (report.start === baseline.period_start && report.end === baseline.period_end),
        'Use the same reporting period as this item’s baseline. Running totals cannot reset during a Power Hour.',
      );
      for (const row of previous ? report.rows : []) {
        const last = db
          .select({ value: power_hour_report_values.value })
          .from(power_hour_report_values)
          .innerJoin(
            power_hour_reports,
            eq(power_hour_reports.id, power_hour_report_values.report_id),
          )
          .where(
            and(
              eq(power_hour_reports.session_id, session.id),
              eq(power_hour_reports.item_code, report.item_code),
              eq(power_hour_report_values.operator_number, row.id),
            ),
          )
          .orderBy(desc(power_hour_reports.timestamp))
          .get();
        ensure(
          last,
          `Operator ${row.id} has no baseline for this item. Remove this row from the review; its starting total is unknown.`,
        );
        const value = row.values.find((v) => v.metric.id === session.report_metric_id)?.value;
        ensure(value !== undefined, `Operator ${row.id}: the tracked metric is required.`);
        ensure(
          value >= last.value,
          `Operator ${row.id}: the total decreased. Review the value or remove this row; counter resets cannot be scored.`,
        );
      }
      return {
        ...insertPowerHourReport(session.id, prepared, session.report_metric_id),
        is_baseline: !previous,
      };
    })
    .immediate();
  events.emit('power-hour-change');
  return saved;
}
