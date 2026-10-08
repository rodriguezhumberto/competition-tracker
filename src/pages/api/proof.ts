import type { APIRoute } from 'astro';
import { reportImageArtifacts } from '../../lib/report-image.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { isAdmin } from '../../lib/auth.ts';
import { db } from '../../db/index.ts';
import { competitions, entries, report_drafts } from '../../db/schema.ts';
import {
  competitionEndsAt,
  PROOF_RETENTION_DAYS,
  RESULTS_RETENTION_DAYS,
} from '../../lib/retention.ts';

export const GET: APIRoute = async ({ url, cookies }) => {
  if (!isAdmin(cookies)) return new Response('Unauthorized', { status: 403 });
  const token = url.searchParams.get('draft');
  const now = Date.now();
  let filename: string | null | undefined;
  let competition: { end_date: string; timezone: string } | undefined;
  if (token) {
    const result = db
      .select()
      .from(report_drafts)
      .innerJoin(competitions, eq(report_drafts.competition_id, competitions.id))
      .where(eq(report_drafts.token, token))
      .get();
    const draft = result?.report_drafts;
    if (!draft || draft.status !== 'reviewable' || draft.expires_at <= now)
      return new Response('Not found', { status: 404 });
    filename = draft.proof_image_path;
    competition = result?.competitions;
  } else {
    const id = Number(url.searchParams.get('id'));
    if (!Number.isSafeInteger(id)) return new Response('Not found', { status: 404 });
    const result = db
      .select()
      .from(entries)
      .innerJoin(competitions, eq(entries.competition_id, competitions.id))
      .where(eq(entries.id, id))
      .get();
    filename = result?.entries.proof_image_path;
    competition = result?.competitions;
  }
  // Deny access at the deadline even if background deletion is delayed or fails.
  const retentionDays = token ? RESULTS_RETENTION_DAYS : PROOF_RETENTION_DAYS;
  if (
    !competition ||
    now >=
      competitionEndsAt(competition.end_date, competition.timezone) + retentionDays * 86_400_000
  )
    return new Response('Not found', { status: 404 });
  if (!filename || !/^[\w-]+\.(png|jpg|webp)$/.test(filename))
    return new Response('Not found', { status: 404 });
  const directory = resolve(process.env.UPLOAD_DIR || './data/proofs');
  try {
    let bytes: Buffer | undefined;
    let mimeType = filename.endsWith('.jpg')
      ? 'image/jpeg'
      : filename.endsWith('.png')
        ? 'image/png'
        : 'image/webp';
    if (url.searchParams.get('variant') === 'processed') {
      try {
        bytes = await readFile(resolve(directory, reportImageArtifacts(filename).processed));
        mimeType = 'image/png';
      } catch (error) {
        // Reports uploaded before preprocessing used the original for extraction.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    bytes ??= await readFile(resolve(directory, filename));
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
};
