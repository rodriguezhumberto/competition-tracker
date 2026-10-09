import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { entries, reports, report_drafts, power_hour_reports } from '../db/schema.ts';
import { claimExpiredDrafts } from './draft-store.ts';
import { reportImageArtifacts } from './report-image.ts';

export async function cleanupDrafts(
  options: {
    now?: number;
    remove?: (path: string) => Promise<unknown>;
    onError?: (error: unknown) => void;
  } = {},
) {
  const remove = options.remove ?? unlink;
  const onError = options.onError ?? ((error) => console.error('Draft cleanup will retry:', error));
  claimExpiredDrafts(options.now ?? Date.now());
  const queued = db
    .select()
    .from(report_drafts)
    .where(ne(report_drafts.status, 'reviewable'))
    .orderBy(asc(report_drafts.cleanup_attempts), asc(report_drafts.created_at))
    .limit(100)
    .all();
  const directory = resolve(process.env.UPLOAD_DIR || './data/proofs');
  for (const draft of queued) {
    try {
      if (!/^[\w-]+\.(png|jpg|webp)$/.test(draft.proof_image_path))
        throw new Error('Invalid proof filename in cleanup queue.');
      // Protect permanent proofs even for historical data that reused a filename.
      const retained =
        db
          .select({ id: power_hour_reports.id })
          .from(power_hour_reports)
          .where(eq(power_hour_reports.proof_image_path, draft.proof_image_path))
          .limit(1)
          .get() ||
        db
          .select({ id: reports.id })
          .from(reports)
          .where(eq(reports.proof_image_path, draft.proof_image_path))
          .limit(1)
          .get() ||
        db
          .select({ id: entries.id })
          .from(entries)
          .where(eq(entries.proof_image_path, draft.proof_image_path))
          .limit(1)
          .get() ||
        db
          .select({ token: report_drafts.token })
          .from(report_drafts)
          .where(
            and(
              eq(report_drafts.proof_image_path, draft.proof_image_path),
              eq(report_drafts.status, 'reviewable'),
              ne(report_drafts.token, draft.token),
            ),
          )
          .limit(1)
          .get();
      if (!retained) {
        const artifacts = reportImageArtifacts(draft.proof_image_path);
        for (const name of [draft.proof_image_path, artifacts.processed, artifacts.metadata]) {
          try {
            await remove(resolve(directory, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
      db.delete(report_drafts)
        .where(and(eq(report_drafts.token, draft.token), ne(report_drafts.status, 'reviewable')))
        .run();
    } catch (error) {
      db.update(report_drafts)
        .set({
          cleanup_attempts: sql`${report_drafts.cleanup_attempts} + 1`,
          cleanup_error:
            error instanceof Error ? error.message : 'Unable to delete proof artifacts.',
        })
        .where(
          and(
            eq(report_drafts.token, draft.token),
            or(eq(report_drafts.status, 'discarded'), eq(report_drafts.status, 'expired')),
          ),
        )
        .run();
      onError(error);
    }
  }
}

// The symbol coordinates development hot reloads and separately bundled SSR modules.
const key = Symbol.for('rally.draft-cleanup');
type CleanupJob = { stop: () => void };
const shared = globalThis as typeof globalThis & { [key]?: CleanupJob };
export function startDraftCleanup() {
  if (shared[key]) return shared[key].stop;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupDrafts();
    } catch (error) {
      console.error('Draft cleanup will retry:', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void run();
  }, 60_000);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    delete shared[key];
  };
  shared[key] = { stop };
  void run();
  return stop;
}
