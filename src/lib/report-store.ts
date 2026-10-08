import { reviewableDraft, checkDraftRevision } from './draft-store.ts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, sqlite } from '../db/index.ts';
import {
  competitions,
  competition_metrics,
  entries,
  reports,
  report_values,
  report_drafts,
} from '../db/schema.ts';
import { ensure } from './validation.ts';
import { decimal } from './metrics.ts';
import { getCompetition } from './competition-config.ts';
import { validateReport } from './report-validation.ts';

// Validation, baseline reads and writes all run within saveReport's IMMEDIATE transaction.
function prepareReport(competition: ReturnType<typeof getCompetition>, input: unknown) {
  const report = validateReport(competition, input);
  const rows = report.rows.map((row) => {
    const last = db
      .select({ timestamp: entries.timestamp_on_report })
      .from(entries)
      .where(
        and(
          eq(entries.competition_id, competition.id),
          eq(entries.operator_number, row.id),
          eq(entries.item_code, report.item_code),
        ),
      )
      .orderBy(desc(entries.timestamp_on_report))
      .limit(1)
      .get();
    ensure(
      !last || report.timestamp > last.timestamp,
      `Operator ${row.id}: report timestamp must be newer than the last entry. Duplicate or older reports are not saved.`,
    );
    const values = row.values.map(({ metric, value }) => {
      if (metric.mode === 'latest') return { metric, value, contribution: null };
      if (metric.mode === 'additive') return { metric, value, contribution: value };
      const previous = db
        .select({ value: report_values.value, date: entries.report_date })
        .from(report_values)
        .innerJoin(entries, eq(entries.id, report_values.entry_id))
        .where(
          and(
            eq(report_values.metric_id, metric.id),
            eq(entries.operator_number, row.id),
            eq(entries.item_code, report.item_code),
          ),
        )
        .orderBy(desc(entries.timestamp_on_report))
        .limit(1)
        .get();
      const baseline = previous?.date === report.end ? previous.value : 0;
      return { metric, value, contribution: value - baseline };
    });
    return { id: row.id, values };
  });
  return { ...report, rows };
}
export function saveReport(
  competitionId: unknown,
  input: unknown,
  options: {
    schemaVersion?: number;
    profileVersion?: number;
    proof?: string;
    draftToken?: string;
    draftRevision?: number;
  } = {},
) {
  return sqlite
    .transaction(() => {
      const draft = options.draftToken ? reviewableDraft(options.draftToken) : null;
      if (draft) checkDraftRevision(draft, options.draftRevision);
      const c = getCompetition(competitionId);
      if (draft) ensure(draft.competition_id === c.id, 'Draft belongs to a different competition.');
      const schemaVersion = draft?.schema_version ?? options.schemaVersion;
      const profileVersion = draft?.profile_version ?? options.profileVersion;
      const proof = draft?.proof_image_path ?? options.proof;
      if (schemaVersion !== undefined)
        ensure(
          schemaVersion === c.schema_version,
          'Competition settings changed. Reload and review the report again.',
        );
      if (profileVersion !== undefined)
        ensure(
          profileVersion === c.profile_version,
          'Report mapping changed. Scan and review the report again.',
        );
      const prepared = prepareReport(c, input);
      const report = db
        .insert(reports)
        .values({
          competition_id: c.id,
          item_code: prepared.item_code,
          timestamp: prepared.timestamp,
          period_start: prepared.start,
          period_end: prepared.end,
          schema_version: c.schema_version,
          profile_version: c.profile_version,
          proof_image_path: proof || null,
        })
        .returning()
        .get();
      const saved = prepared.rows.map((row) => {
        const entry = db
          .insert(entries)
          .values({
            competition_id: c.id,
            report_id: report.id,
            operator_number: row.id,
            item_code: prepared.item_code,
            timestamp_on_report: prepared.timestamp,
            report_date: prepared.end,
            proof_image_path: proof || null,
          })
          .returning()
          .get();
        db.insert(report_values)
          .values(
            row.values.map((v) => ({
              entry_id: entry.id,
              metric_id: v.metric.id,
              value: v.value,
              contribution: v.contribution,
            })),
          )
          .run();
        return entry;
      });
      if (options.draftToken) {
        const removed = db
          .delete(report_drafts)
          .where(eq(report_drafts.token, options.draftToken))
          .returning()
          .get();
        ensure(removed, 'This preview has already been saved or expired.');
      }
      return saved;
    })
    .immediate();
}
export function recentEntries() {
  return db
    .select({
      id: entries.id,
      operatorNumber: entries.operator_number,
      itemCode: entries.item_code,
      trackedItems: competitions.tracked_items,
      competition: competitions.name,
      date: entries.timestamp_on_report,
      proof: entries.proof_image_path,
    })
    .from(entries)
    .innerJoin(competitions, eq(competitions.id, entries.competition_id))
    .orderBy(desc(entries.id))
    .limit(10)
    .all();
}
export function recentMetricReports() {
  const recent = recentEntries();
  if (!recent.length) return [];
  const values = db
    .select({
      entryId: report_values.entry_id,
      label: competition_metrics.label,
      type: competition_metrics.type,
      precision: competition_metrics.precision,
      currency: competition_metrics.currency,
      value: report_values.value,
      contribution: report_values.contribution,
    })
    .from(report_values)
    .innerJoin(competition_metrics, eq(competition_metrics.id, report_values.metric_id))
    .where(
      inArray(
        report_values.entry_id,
        recent.map((entry) => entry.id),
      ),
    )
    .all()
    .map((value) => ({
      ...value,
      value: decimal(value.value, value.precision),
      contribution:
        value.contribution === null ? null : decimal(value.contribution, value.precision),
    }));
  return recent.map(({ trackedItems, ...entry }) => ({
    ...entry,
    itemName:
      (JSON.parse(trackedItems) as { code: string; name: string }[]).find(
        (item) => item.code === entry.itemCode,
      )?.name ?? entry.itemCode,
    values: values.filter((value) => value.entryId === entry.id),
  }));
}
