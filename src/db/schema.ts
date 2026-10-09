import { sql } from 'drizzle-orm';
// Range and status validation lives in the transactional store.
import { sqliteTable, integer, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const admin_sessions = sqliteTable(
  'admin_sessions',
  {
    token_hash: text('token_hash').primaryKey(),
    credential_hash: text('credential_hash').notNull(),
    expires_at: integer('expires_at').notNull(),
  },
  (t) => [index('admin_sessions_expiry').on(t.expires_at)],
);

export const site_privacy = sqliteTable('site_privacy', {
  id: integer('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  password_hash: text('password_hash'),
  session_version: text('session_version').notNull().default(''),
});

export const competitions = sqliteTable(
  'competitions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    metric_label: text('metric_label').notNull(),
    start_date: text('start_date').notNull(),
    end_date: text('end_date').notNull(),
    is_active: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    timezone: text('timezone').notNull().default('America/Chicago'),
    official_metric_key: text('official_metric_key').notNull(),
    schema_version: integer('schema_version').notNull().default(1),
    profile_version: integer('profile_version').notNull().default(1),
    report_profile: text('report_profile').notNull().default('{}'),
    multiple_items: integer('multiple_items', { mode: 'boolean' }).notNull().default(false),
    item_label: text('item_label').notNull().default('Item'),
    tracked_items: text('tracked_items').notNull().default('[]'),
  },
  (t) => [
    uniqueIndex('one_active_competition')
      .on(t.is_active)
      .where(sql`${t.is_active} = 1`),
  ],
);

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});

export const entries = sqliteTable(
  'entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    competition_id: integer('competition_id')
      .notNull()
      .references(() => competitions.id),
    report_id: integer('report_id')
      .notNull()
      .references(() => reports.id),
    // Reports identify people by the operator/cashier number printed on the POS report.
    // Keep this as text so meaningful leading zeroes are retained.
    operator_number: text('operator_number').notNull(),
    item_code: text('item_code').notNull().default(''),
    // Canonical ISO-8601 UTC datetime, so chronological text ordering is reliable.
    timestamp_on_report: text('timestamp_on_report').notNull(),
    report_date: text('report_date').notNull(),
    proof_image_path: text('proof_image_path'),
  },
  (t) => [
    uniqueIndex('unique_report_timestamp').on(
      t.competition_id,
      t.operator_number,
      t.item_code,
      t.timestamp_on_report,
    ),
  ],
);

export const power_hour_sessions = sqliteTable(
  'power_hour_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    competition_id: integer('competition_id').references(() => competitions.id),
    name: text('name').notNull(),
    metric_label: text('metric_label').notNull().default('points'),
    status: text('status', { enum: ['active', 'processing', 'archived'] })
      .notNull()
      .default('active'),
    created_at: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    ends_at: text('ends_at').notNull(),
    password_hash: text('password_hash'),
    finalized_at: text('finalized_at'),
    report_mode: integer('report_mode', { mode: 'boolean' }).notNull().default(false),
    report_metric_id: integer('report_metric_id').references(() => competition_metrics.id),
    report_metric_precision: integer('report_metric_precision').notNull().default(0),
    report_schema_version: integer('report_schema_version'),
    report_profile_version: integer('report_profile_version'),
  },
  (t) => [
    uniqueIndex('one_active_power_hour')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
    index('sessions_by_competition').on(t.competition_id),
  ],
);

export const power_hour_participants = sqliteTable(
  'power_hour_participants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    session_id: integer('session_id')
      .notNull()
      .references(() => power_hour_sessions.id),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id),
    name_key: text('name_key').notNull(),
    credential_hash: text('credential_hash'),
  },
  (t) => [
    uniqueIndex('one_name_per_power_hour').on(t.session_id, t.name_key),
    uniqueIndex('one_membership_per_power_hour').on(t.session_id, t.user_id),
    uniqueIndex('one_power_hour_credential').on(t.credential_hash),
  ],
);

export const power_hour_scores = sqliteTable(
  'power_hour_scores',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    session_id: integer('session_id')
      .notNull()
      .references(() => power_hour_sessions.id),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id),
    clicks: integer('clicks').notNull().default(0),
    flagged: integer('flagged', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [uniqueIndex('one_score_per_user_session').on(t.session_id, t.user_id)],
);

export const competition_metrics = sqliteTable(
  'competition_metrics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    competition_id: integer('competition_id')
      .notNull()
      .references(() => competitions.id),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type', { enum: ['integer', 'decimal', 'currency'] }).notNull(),
    precision: integer('precision').notNull(),
    currency: text('currency').notNull().default('USD'),
    mode: text('mode', { enum: ['daily', 'additive', 'latest'] }).notNull(),
    required: integer('required', { mode: 'boolean' }).notNull().default(true),
    public: integer('public', { mode: 'boolean' }).notNull().default(true),
    direction: text('direction', { enum: ['desc', 'asc'] })
      .notNull()
      .default('desc'),
    minimum: text('minimum'),
    maximum: text('maximum'),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('metric_key_per_competition').on(t.competition_id, t.key)],
);

export const reports = sqliteTable('reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  competition_id: integer('competition_id')
    .notNull()
    .references(() => competitions.id),
  item_code: text('item_code').notNull().default(''),
  timestamp: text('timestamp').notNull(),
  period_start: text('period_start').notNull(),
  period_end: text('period_end').notNull(),
  schema_version: integer('schema_version').notNull(),
  profile_version: integer('profile_version').notNull(),
  proof_image_path: text('proof_image_path'),
});

export const report_values = sqliteTable(
  'report_values',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entry_id: integer('entry_id')
      .notNull()
      .references(() => entries.id),
    metric_id: integer('metric_id')
      .notNull()
      .references(() => competition_metrics.id),
    // Scaled integers; arithmetic is performed with BigInt, never binary decimals.
    value: integer('value').notNull(),
    contribution: integer('contribution'),
  },
  (t) => [
    uniqueIndex('value_per_entry_metric').on(t.entry_id, t.metric_id),
    index('values_by_metric').on(t.metric_id),
  ],
);

export const report_drafts = sqliteTable(
  'report_drafts',
  {
    token: text('token').primaryKey(),
    competition_id: integer('competition_id')
      .notNull()
      .references(() => competitions.id),
    schema_version: integer('schema_version').notNull(),
    profile_version: integer('profile_version').notNull(),
    payload: text('payload').notNull(),
    original_payload: text('original_payload'),
    revision: integer('revision').notNull().default(1),
    status: text('status', { enum: ['reviewable', 'discarded', 'expired'] })
      .notNull()
      .default('reviewable'),
    proof_image_path: text('proof_image_path').notNull(),
    created_at: integer('created_at').notNull(),
    expires_at: integer('expires_at').notNull().default(0),
    cleanup_attempts: integer('cleanup_attempts').notNull().default(0),
    cleanup_error: text('cleanup_error'),
  },
  (t) => [index('drafts_by_status_expiry').on(t.status, t.expires_at)],
);

// Isolated snapshots: Power Hour uploads never contribute to competition standings.
export const power_hour_reports = sqliteTable(
  'power_hour_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    session_id: integer('session_id')
      .notNull()
      .references(() => power_hour_sessions.id),
    timestamp: text('timestamp').notNull(),
    period_start: text('period_start').notNull(),
    period_end: text('period_end').notNull(),
    item_code: text('item_code').notNull().default(''),
    proof_image_path: text('proof_image_path'),
  },
  (t) => [uniqueIndex('power_hour_report_timestamp').on(t.session_id, t.item_code, t.timestamp)],
);

export const power_hour_report_values = sqliteTable(
  'power_hour_report_values',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    report_id: integer('report_id')
      .notNull()
      .references(() => power_hour_reports.id),
    operator_number: text('operator_number').notNull(),
    value: integer('value').notNull(),
  },
  (t) => [uniqueIndex('power_hour_operator_per_report').on(t.report_id, t.operator_number)],
);
