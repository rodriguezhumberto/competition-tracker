import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, lte } from 'drizzle-orm';
import { db, sqlite } from '../db/index.ts';
import { competitions, report_drafts } from '../db/schema.ts';
import { getCompetition } from './competition-config.ts';
import { ensure } from './assertions.ts';
import { validateItems } from './tracked-items.ts';
import type { ReportInput } from './report-validation.ts';

export const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;
type Competition = ReturnType<typeof getCompetition>;

function editableReport(raw: unknown, competition: Competition): ReportInput {
  ensure(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid draft report.');
  const report = raw as Record<string, unknown>;
  const field = (value: unknown, maximum = 80) => {
    ensure(typeof value === 'string' && value.length <= maximum, 'Invalid draft field.');
    return value;
  };
  ensure(
    Array.isArray(report.rows) && report.rows.length > 0 && report.rows.length <= 100,
    'Include 1–100 participant rows.',
  );
  const keys = new Set(competition.metrics.map((metric) => metric.key));
  // Drafts may retain blank/unreadable fields. Scoring validation happens at confirmation.
  return {
    item_code: competition.multiple_items ? field(report.item_code ?? '') : '',
    generated_at: field(report.generated_at),
    period_start: field(report.period_start),
    period_end: field(report.period_end),
    rows: report.rows.map((rawRow) => {
      ensure(rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow), 'Invalid draft row.');
      const row = rawRow as Record<string, unknown>;
      ensure(
        row.values && typeof row.values === 'object' && !Array.isArray(row.values),
        'Invalid draft values.',
      );
      const values = row.values as Record<string, unknown>;
      ensure(
        Object.keys(values).every((key) => keys.has(key)),
        'Draft contains an unknown metric.',
      );
      return {
        participant_id: field(row.participant_id),
        values: Object.fromEntries(
          Object.entries(values).map(([key, value]) => {
            ensure(
              value === null ||
                typeof value === 'string' ||
                (typeof value === 'number' && Number.isFinite(value)),
              'Invalid draft value.',
            );
            return [key, value === null ? null : field(String(value), 40)];
          }),
        ),
      };
    }),
  };
}

export function createDraft(
  competition: Competition,
  report: unknown,
  proof: string,
  options: { now?: number; status?: 'reviewable' | 'discarded' } = {},
) {
  const now = options.now ?? Date.now();
  const payload = JSON.stringify(editableReport(report, competition));
  return db
    .insert(report_drafts)
    .values({
      token: randomUUID(),
      competition_id: competition.id,
      schema_version: competition.schema_version,
      profile_version: competition.profile_version,
      payload,
      original_payload: payload,
      proof_image_path: proof,
      created_at: now,
      expires_at: now + DRAFT_LIFETIME_MS,
      status: options.status ?? 'reviewable',
    })
    .returning()
    .get();
}

export function listPendingDrafts(now = Date.now()) {
  return db
    .select({
      token: report_drafts.token,
      competitionName: competitions.name,
      createdAt: report_drafts.created_at,
      expiresAt: report_drafts.expires_at,
      revision: report_drafts.revision,
    })
    .from(report_drafts)
    .innerJoin(competitions, eq(competitions.id, report_drafts.competition_id))
    .where(and(eq(report_drafts.status, 'reviewable'), gt(report_drafts.expires_at, now)))
    .orderBy(desc(report_drafts.created_at))
    .all();
}

export function reviewableDraft(token: unknown, now = Date.now()) {
  ensure(
    typeof token === 'string' && token.length > 0 && token.length <= 100,
    'Invalid draft token.',
  );
  const draft = db.select().from(report_drafts).where(eq(report_drafts.token, token)).get();
  ensure(
    draft && draft.status === 'reviewable' && draft.expires_at > now,
    'This preview has expired, was discarded, or has already been saved. Scan the report again.',
  );
  return draft;
}

export function checkDraftRevision(draft: ReturnType<typeof reviewableDraft>, revision: unknown) {
  ensure(
    Number.isSafeInteger(revision) && revision === draft.revision,
    'This draft changed in another tab. Reopen it before saving or confirming.',
  );
}

export function draftView(token: unknown) {
  const draft = reviewableDraft(token);
  const competition = getCompetition(draft.competition_id);
  return {
    token: draft.token,
    competitionId: competition.id,
    multipleItems: competition.multiple_items,
    itemLabel: competition.item_label,
    items: competition.items,
    revision: draft.revision,
    expiresAt: draft.expires_at,
    report: JSON.parse(draft.payload) as ReportInput,
    originalReport: JSON.parse(draft.original_payload ?? draft.payload) as ReportInput,
    metrics: competition.metrics,
    identifierLabel: competition.profile.identifier_label,
    timezone: competition.timezone,
    schemaChanged:
      draft.schema_version !== competition.schema_version ||
      draft.profile_version !== competition.profile_version,
  };
}

export function saveDraftEdits(token: unknown, revision: unknown, report: unknown) {
  return sqlite
    .transaction(() => {
      const draft = reviewableDraft(token);
      checkDraftRevision(draft, revision);
      const competition = getCompetition(draft.competition_id);
      ensure(
        draft.schema_version === competition.schema_version &&
          draft.profile_version === competition.profile_version,
        'Competition settings changed. Discard this draft and scan the report again.',
      );
      db.update(report_drafts)
        .set({
          payload: JSON.stringify(editableReport(report, competition)),
          revision: draft.revision + 1,
        })
        .where(eq(report_drafts.token, draft.token))
        .run();
      return draftView(draft.token);
    })
    .immediate();
}

export function discardDraft(token: unknown, revision: unknown) {
  return sqlite
    .transaction(() => {
      const draft = reviewableDraft(token);
      checkDraftRevision(draft, revision);
      db.update(report_drafts)
        .set({ status: 'discarded', revision: draft.revision + 1 })
        .where(eq(report_drafts.token, draft.token))
        .run();
    })
    .immediate();
}

// Expiry and confirmation serialize through IMMEDIATE transactions. Once claimed
// for cleanup, a draft cannot return to reviewable state or become a report.
export function claimExpiredDrafts(now = Date.now()) {
  sqlite
    .transaction(() => {
      db.update(report_drafts)
        .set({ status: 'expired' })
        .where(and(eq(report_drafts.status, 'reviewable'), lte(report_drafts.expires_at, now)))
        .run();
    })
    .immediate();
}

// Adding a reviewed code changes only the item list. Preserve this draft's proof,
// original extraction and edits while invalidating other previews' old schema.
export function addDraftItem(token: unknown, revision: unknown, item: unknown, report?: unknown) {
  return sqlite
    .transaction(() => {
      const draft = reviewableDraft(token);
      checkDraftRevision(draft, revision);
      const competition = getCompetition(draft.competition_id);
      ensure(competition.multiple_items, 'Enable tracking multiple items before adding an item.');
      ensure(
        draft.schema_version === competition.schema_version &&
          draft.profile_version === competition.profile_version,
        'Competition settings changed. Discard this draft and scan the report again.',
      );
      const items = validateItems([...competition.items, item]);
      const payload = editableReport(report ?? JSON.parse(draft.payload), competition);
      payload.item_code = items.at(-1)!.code;
      db.update(competitions)
        .set({
          tracked_items: JSON.stringify(items),
          schema_version: competition.schema_version + 1,
        })
        .where(eq(competitions.id, competition.id))
        .run();
      db.update(report_drafts)
        .set({
          payload: JSON.stringify(payload),
          schema_version: competition.schema_version + 1,
          revision: draft.revision + 1,
        })
        .where(eq(report_drafts.token, draft.token))
        .run();
      return draftView(draft.token);
    })
    .immediate();
}
