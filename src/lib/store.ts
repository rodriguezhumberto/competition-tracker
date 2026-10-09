import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { db, sqlite } from '../db/index.ts';
import {
  users,
  power_hour_sessions,
  power_hour_scores,
  power_hour_participants,
  competition_metrics,
} from '../db/schema.ts';
import { ensure, label, participantName } from './validation.ts';
import {
  hashParticipantToken,
  hashPowerHourPassword,
  newParticipantToken,
  validParticipantToken,
  validPowerHourPassword,
  verifyPowerHourPassword,
} from './auth.ts';
import { events } from './events.ts';
import {
  preparePowerHourReport,
  insertPowerHourReport,
  reportSessionScores,
} from './power-hour-reports.ts';
import { getSitePrivacy, siteAccessAllowed } from './site-access.ts';

export {
  getCompetitions,
  currentCompetition,
  addCompetition,
  activateCompetition,
  recentEntries,
} from './competition-store.ts';
export function expireSessions() {
  return db
    .update(power_hour_sessions)
    .set({ status: 'archived' })
    .where(
      and(
        eq(power_hour_sessions.status, 'active'),
        lte(power_hour_sessions.ends_at, new Date().toISOString()),
      ),
    )
    .returning()
    .all();
}
export function activeSession() {
  expireSessions();
  return (
    db.select().from(power_hour_sessions).where(eq(power_hour_sessions.status, 'active')).get() ||
    null
  );
}
export function sessionScores(sessionId: number) {
  const session = db
    .select()
    .from(power_hour_sessions)
    .where(eq(power_hour_sessions.id, sessionId))
    .get();
  if (session?.report_mode) return reportSessionScores(sessionId, session.report_metric_precision);
  return db
    .select({
      userId: users.id,
      name: users.name,
      clicks: sql<number>`coalesce(${power_hour_scores.clicks},0)`.mapWith(Number),
      flagged: sql<number>`coalesce(${power_hour_scores.flagged},0)`.mapWith(Boolean),
    })
    .from(power_hour_participants)
    .innerJoin(users, eq(users.id, power_hour_participants.user_id))
    .leftJoin(
      power_hour_scores,
      and(eq(power_hour_scores.user_id, users.id), eq(power_hour_scores.session_id, sessionId)),
    )
    .where(eq(power_hour_participants.session_id, sessionId))
    .orderBy(desc(sql`coalesce(${power_hour_scores.clicks},0)`), asc(users.name))
    .all();
}
const RESULTS_WINDOW_MS = 2 * 60000;
// Ended sessions remain readable in the lobby, while writes still require activeSession().
function lobbySession() {
  const active = activeSession();
  if (active) return active;
  const latest = db
    .select()
    .from(power_hour_sessions)
    .where(eq(power_hour_sessions.status, 'archived'))
    .orderBy(desc(power_hour_sessions.id))
    .get();
  if (!latest) return null;
  const endedAt = Date.parse(latest.ends_at);
  const now = Date.now();
  return endedAt <= now && now < endedAt + RESULTS_WINDOW_MS ? latest : null;
}
function publicSession(session: NonNullable<ReturnType<typeof lobbySession>>) {
  const endsAt = session.ends_at;
  return {
    id: session.id,
    name: session.name,
    metric_label: session.metric_label || 'points',
    report_mode: session.report_mode,
    report_metric:
      session.report_mode && session.report_metric_id
        ? (db
            .select({
              precision: competition_metrics.precision,
              type: competition_metrics.type,
              currency: competition_metrics.currency,
            })
            .from(competition_metrics)
            .where(eq(competition_metrics.id, session.report_metric_id))
            .get() ?? null)
        : null,
    created_at: session.created_at,
    ends_at: endsAt,
    status: session.status === 'active' ? 'active' : 'ended',
    results_until: new Date(Date.parse(endsAt) + RESULTS_WINDOW_MS).toISOString(),
  };
}
// Session reconciliation does not need scores. Realtime uses this for its expiry timer.
export function sessionState() {
  const session = lobbySession();
  return session ? publicSession(session) : null;
}
export function snapshot() {
  const session = sessionState();
  return { session, scores: session ? sessionScores(session.id) : [] };
}
export function publicSnapshot() {
  const session = sessionState();
  return { session, scores: session?.report_mode ? sessionScores(session.id) : [] };
}
export function sessionParticipants(sessionId: number) {
  return db
    .select({
      userId: power_hour_participants.user_id,
      name: users.name,
      sessionId: power_hour_participants.session_id,
      credentialHash: power_hour_participants.credential_hash,
    })
    .from(power_hour_participants)
    .innerJoin(users, eq(users.id, power_hour_participants.user_id))
    .where(eq(power_hour_participants.session_id, sessionId))
    .all();
}
function durationMinutes(value: unknown) {
  const minutes = Number(value);
  ensure(
    typeof value === 'string' || typeof value === 'number',
    'Duration must be a whole number of minutes.',
  );
  ensure(
    Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 1440,
    'Duration must be 1–1440 whole minutes.',
  );
  return minutes;
}
export function startSession(input: Record<string, unknown>) {
  const reportMode = input.report_mode === 'on' || input.report_mode === true;
  let passwordHash: string | null = null;
  if (!reportMode) {
    ensure(
      validPowerHourPassword(input.password),
      'Shared password must contain 8–128 characters.',
    );
    passwordHash = hashPowerHourPassword(input.password);
  }
  const minutes = durationMinutes(input.duration_minutes ?? 60);
  const session = sqlite
    .transaction(() => {
      ensure(!activeSession(), 'A Power Hour is already running.');
      const prepared = reportMode ? preparePowerHourReport(input, true) : null;
      const metric = prepared?.competition.metrics.find(
        (m) => m.id === Number(input.report_metric_id),
      );
      if (reportMode) {
        ensure(metric?.public, 'Choose a public report metric.');
        ensure(
          metric.mode !== 'additive',
          'Choose a running-total or latest-value metric. Additive report amounts cannot be compared to a baseline.',
        );
      }
      const now = prepared ? Date.parse(prepared.report.timestamp) : Date.now();
      ensure(
        now + minutes * 60000 > Date.now(),
        'The baseline is too old for this duration. Upload a newer baseline or increase the duration.',
      );
      const saved = db
        .insert(power_hour_sessions)
        .values({
          name: label(input.name || 'Power Hour', 'Session name'),
          metric_label: metric?.label ?? label(input.metric_label || 'points', 'Tracked metric'),
          report_mode: reportMode,
          competition_id: prepared?.competition.id,
          report_metric_id: metric?.id,
          report_metric_precision: metric?.precision ?? 0,
          report_schema_version: prepared?.competition.schema_version,
          report_profile_version: prepared?.competition.profile_version,
          status: 'active',
          created_at: new Date(now).toISOString(),
          ends_at: new Date(now + minutes * 60000).toISOString(),
          password_hash: passwordHash,
        })
        .returning()
        .get();
      if (prepared && metric) insertPowerHourReport(saved.id, prepared, metric.id);
      return saved;
    })
    .immediate();
  events.emit('power-hour-change');
  return session;
}
export function extendSession(input: Record<string, unknown>) {
  const minutes = durationMinutes(input.duration_minutes);
  const session = sqlite
    .transaction(() => {
      const current = activeSession();
      ensure(current, 'No Power Hour is active.');
      const endsAt = new Date(Date.parse(current.ends_at) + minutes * 60000).toISOString();
      return db
        .update(power_hour_sessions)
        .set({ ends_at: endsAt })
        .where(eq(power_hour_sessions.id, current.id))
        .returning()
        .get();
    })
    .immediate();
  events.emit('power-hour-change');
  return session;
}
export function participantForToken(token: unknown, sessionId: number | null = null) {
  if (!validParticipantToken(token)) return null;
  sessionId ??= lobbySession()?.id ?? null;
  if (!sessionId) return null;
  return (
    db
      .select({
        userId: power_hour_participants.user_id,
        name: users.name,
        sessionId: power_hour_participants.session_id,
      })
      .from(power_hour_participants)
      .innerJoin(users, eq(users.id, power_hour_participants.user_id))
      .where(
        and(
          eq(power_hour_participants.session_id, sessionId),
          eq(power_hour_participants.credential_hash, hashParticipantToken(token)),
        ),
      )
      .get() || null
  );
}
export function joinSession(
  sessionId: number,
  password: unknown,
  rawName: unknown,
  existingToken: unknown = null,
) {
  return registerParticipant(sessionId, rawName, existingToken, (session) => {
    ensure(verifyPowerHourPassword(password, session.password_hash), 'Incorrect shared password.');
  });
}

export function joinSessionWithSiteAccess(
  sessionId: number,
  rawName: unknown,
  existingToken: unknown = null,
  cookieHeader: string | undefined = undefined,
) {
  return registerParticipant(sessionId, rawName, existingToken, () => {
    ensure(getSitePrivacy().enabled, 'Enter the shared Power Hour password to join.');
    ensure(siteAccessAllowed(cookieHeader), 'Sign in to view this site.');
  });
}

function registerParticipant(
  sessionId: number,
  rawName: unknown,
  existingToken: unknown,
  admit: (session: NonNullable<ReturnType<typeof activeSession>>) => void,
) {
  const name = participantName(rawName);
  const nameKey = name.toLocaleLowerCase('en-US');
  return sqlite
    .transaction(() => {
      const session = activeSession();
      ensure(session?.id === sessionId, 'This Power Hour has ended.');
      ensure(!session.report_mode, 'Report-driven Power Hours are view-only.');
      ensure(!session.report_mode, 'Report-driven Power Hours are view-only.');
      admit(session);
      const member = participantForToken(existingToken, session.id);
      if (member) {
        ensure(
          member.name.toLocaleLowerCase('en-US') === nameKey,
          `This browser is already joined as ${member.name}.`,
        );
        return { ...member, token: existingToken as string };
      }
      const existing = db
        .select({ userId: power_hour_participants.user_id })
        .from(power_hour_participants)
        .where(
          and(
            eq(power_hour_participants.session_id, sessionId),
            eq(power_hour_participants.name_key, nameKey),
          ),
        )
        .get();
      ensure(!existing, 'That name is already in use for this Power Hour.');
      const count =
        db
          .select({ count: sql<number>`count(*)`.mapWith(Number) })
          .from(power_hour_participants)
          .where(eq(power_hour_participants.session_id, sessionId))
          .get()?.count || 0;
      ensure(count < 20, 'This Power Hour already has 20 participants.');
      const user = db.insert(users).values({ name }).returning({ id: users.id }).get();
      const token = newParticipantToken();
      db.insert(power_hour_participants)
        .values({
          session_id: sessionId,
          user_id: user.id,
          name_key: nameKey,
          credential_hash: hashParticipantToken(token),
        })
        .run();
      return { userId: user.id, name, sessionId, token };
    })
    .immediate();
}
export function archiveSession() {
  db.update(power_hour_sessions)
    .set({
      status: 'archived',
      ends_at: sql`min(${power_hour_sessions.ends_at}, ${new Date().toISOString()})`,
    })
    .where(eq(power_hour_sessions.status, 'active'))
    .run();
  events.emit('power-hour-change');
}
export function incrementScore(userId: number, sessionId: number, flagged = false) {
  sqlite
    .transaction(() => {
      const session = activeSession();
      ensure(session?.id === sessionId, 'This Power Hour has ended.');
      ensure(!session.report_mode, 'Report-driven Power Hours are view-only.');
      ensure(
        db
          .select({ id: power_hour_participants.id })
          .from(power_hour_participants)
          .where(
            and(
              eq(power_hour_participants.session_id, sessionId),
              eq(power_hour_participants.user_id, userId),
            ),
          )
          .get(),
        'Participant not found in this Power Hour.',
      );
      db.insert(power_hour_scores)
        .values({ session_id: sessionId, user_id: userId, clicks: 1, flagged })
        .onConflictDoUpdate({
          target: [power_hour_scores.session_id, power_hour_scores.user_id],
          set: {
            clicks: sql`${power_hour_scores.clicks} + 1`,
            flagged: sql`${power_hour_scores.flagged} OR ${flagged ? 1 : 0}`,
          },
        })
        .run();
    })
    .immediate();
}
export function getArchives() {
  return db
    .select()
    .from(power_hour_sessions)
    .where(eq(power_hour_sessions.status, 'archived'))
    .orderBy(desc(power_hour_sessions.id))
    .all();
}
export function getArchivedSession(id: number) {
  return db
    .select()
    .from(power_hour_sessions)
    .where(and(eq(power_hour_sessions.id, id), eq(power_hour_sessions.status, 'archived')))
    .get();
}
