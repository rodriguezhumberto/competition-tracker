import { randomUUID } from 'node:crypto';
import { sqlite } from '../db/index.ts';
import { resolveReportTime } from './time.ts';
import { cleanupDrafts } from './draft-cleanup.ts';
import { events } from './events.ts';

export const PROOF_RETENTION_DAYS = 15;
export const RESULTS_RETENTION_DAYS = 30;
const DAY = 86_400_000;

// The end date includes the entire final day in the competition's timezone.
export function competitionEndsAt(endDate: string, timezone: string): number {
  const nextDate = new Date(Date.parse(`${endDate}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  return Date.parse(resolveReportTime(`${nextDate}T00:00:00`, timezone));
}

export async function cleanupRetainedData(options: Parameters<typeof cleanupDrafts>[0] = {}) {
  const now = options.now ?? Date.now();
  const changed = sqlite
    .transaction(() => {
      const competitions = sqlite
        .prepare('SELECT id, end_date, timezone FROM competitions')
        .all() as { id: number; end_date: string; timezone: string }[];
      const ends = new Map(
        competitions.map((c) => [c.id, competitionEndsAt(c.end_date, c.timezone)]),
      );
      let changed = false;
      for (const competition of competitions) {
        const ended = ends.get(competition.id)!;
        if (now < ended + PROOF_RETENTION_DAYS * DAY) continue;
        const proofs = sqlite
          .prepare(
            `
        SELECT proof_image_path FROM reports WHERE competition_id = ? AND proof_image_path IS NOT NULL
        UNION SELECT proof_image_path FROM entries WHERE competition_id = ? AND proof_image_path IS NOT NULL
      `,
          )
          .all(competition.id, competition.id) as { proof_image_path: string }[];
        for (const proof of proofs) {
          // Use the durable image cleanup queue. Never retain extracted personal data in it.
          sqlite
            .prepare(
              `INSERT INTO report_drafts
          (token, competition_id, schema_version, profile_version, payload, proof_image_path,
           created_at, expires_at, status)
          VALUES (?, ?, 1, 1, '{}', ?, ?, ?, 'discarded')
        `,
            )
            .run(randomUUID(), competition.id, proof.proof_image_path, now, now);
        }
        sqlite
          .prepare('UPDATE reports SET proof_image_path = NULL WHERE competition_id = ?')
          .run(competition.id);
        sqlite
          .prepare('UPDATE entries SET proof_image_path = NULL WHERE competition_id = ?')
          .run(competition.id);
        if (now < ended + RESULTS_RETENTION_DAYS * DAY) continue;
        sqlite
          .prepare(
            `UPDATE report_drafts SET status = 'discarded', payload = '{}', original_payload = NULL
        WHERE competition_id = ?`,
          )
          .run(competition.id);
        sqlite
          .prepare(
            `DELETE FROM report_values WHERE entry_id IN
        (SELECT id FROM entries WHERE competition_id = ?)`,
          )
          .run(competition.id);
        changed =
          !!sqlite.prepare('DELETE FROM entries WHERE competition_id = ?').run(competition.id)
            .changes || changed;
        sqlite.prepare('DELETE FROM reports WHERE competition_id = ?').run(competition.id);
      }
      const sessions = sqlite
        .prepare('SELECT id, competition_id, ends_at FROM power_hour_sessions')
        .all() as {
        id: number;
        competition_id: number | null;
        ends_at: string;
      }[];
      for (const session of sessions) {
        const ended = Date.parse(session.ends_at);
        const cutoff =
          Math.max(ended, ends.get(session.competition_id!) ?? ended) +
          RESULTS_RETENTION_DAYS * DAY;
        if (!Number.isFinite(cutoff) || now < cutoff) continue;
        sqlite.prepare('DELETE FROM power_hour_scores WHERE session_id = ?').run(session.id);
        sqlite.prepare('DELETE FROM power_hour_participants WHERE session_id = ?').run(session.id);
        sqlite.prepare('DELETE FROM power_hour_sessions WHERE id = ?').run(session.id);
        changed = true;
      }
      // A person may participate in more than one session. Preserve names still in use.
      sqlite
        .prepare(
          `DELETE FROM users WHERE id NOT IN (SELECT user_id FROM power_hour_participants)
      AND id NOT IN (SELECT user_id FROM power_hour_scores)`,
        )
        .run();
      return changed;
    })
    .immediate();
  await cleanupDrafts({ ...options, now });
  if (changed) events.emit('power-hour-change');
}

const key = Symbol.for('rally.retention-cleanup');
const shared = globalThis as typeof globalThis & { [key]?: { stop: () => void } };
export function startRetentionCleanup() {
  if (shared[key]) return shared[key].stop;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupRetainedData();
    } catch (error) {
      console.error('Retention cleanup will retry:', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), 60_000);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    delete shared[key];
  };
  shared[key] = { stop };
  return stop;
}
