import { reportCrop } from '../../lib/report-crop.ts';
import type { APIRoute } from 'astro';
import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isAdmin, sameOrigin } from '../../lib/auth.ts';
import { limitedFormData } from '../../lib/http.ts';
import { extractMetricReport } from '../../lib/vision.ts';
import { getCompetition } from '../../lib/competition-store.ts';
import {
  preprocessReportImage,
  reportRotation,
  reportImageArtifacts,
} from '../../lib/report-image.ts';
import { readReportImage } from '../../lib/report-upload.ts';
import { ensure } from '../../lib/validation.ts';
import { createDraft } from '../../lib/draft-store.ts';
let busy = false;
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return Response.json({ error: 'Unauthorized.' }, { status: 403 });
  if (busy)
    return Response.json(
      { error: 'A report is already processing. Try again shortly.' },
      { status: 429 },
    );
  busy = true;
  const savedPaths: string[] = [];
  let failedArtifacts:
    | { competition: ReturnType<typeof getCompetition>; report: unknown; filename: string }
    | undefined;
  try {
    const form = await limitedFormData(request, 6 * 1024 * 1024);
    const c = getCompetition(form.get('competition_id'));
    const file = await readReportImage(form.get('report'));
    const image = await preprocessReportImage(
      file.bytes,
      reportRotation(form.get('rotation')),
      reportCrop(form.get('crop')),
    );
    const report = await extractMetricReport(image.bytes, image.mimeType, c);
    const current = getCompetition(c.id);
    ensure(
      current.schema_version === c.schema_version && current.profile_version === c.profile_version,
      'Competition settings changed during extraction. Scan the report again.',
    );
    const directory = resolve(process.env.UPLOAD_DIR || './data/proofs');
    await mkdir(directory, { recursive: true });
    const filename = `${randomUUID()}.${file.extension}`;
    failedArtifacts = { competition: c, report, filename };
    const artifacts = reportImageArtifacts(filename);
    for (const [name, bytes] of [
      [filename, file.bytes],
      [artifacts.processed, image.bytes],
      [artifacts.metadata, JSON.stringify(image.processing)],
    ] as const) {
      const path = resolve(directory, name);
      const handle = await open(path, 'wx', 0o600);
      savedPaths.push(path);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    }
    const draft = createDraft(c, report, filename);
    savedPaths.length = 0;
    return Response.json(
      {
        token: draft.token,
        revision: draft.revision,
        expiresAt: draft.expires_at,
        originalReport: report,
        schemaChanged: false,
        report,
        processing: image.processing,
        multipleItems: c.multiple_items,
        itemLabel: c.item_label,
        items: c.items,
        metrics: c.metrics,
        identifierLabel: c.profile.identifier_label,
        timezone: c.timezone,
        message: 'Review every row against the image. Nothing has been added to the leaderboard.',
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    const removed = await Promise.allSettled(savedPaths.map((path) => unlink(path)));
    if (
      failedArtifacts &&
      removed.some(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as NodeJS.ErrnoException).code !== 'ENOENT',
      )
    ) {
      // Keep failed file deletions in the same durable retry queue as expired drafts.
      try {
        createDraft(failedArtifacts.competition, failedArtifacts.report, failedArtifacts.filename, {
          status: 'discarded',
        });
      } catch (queueError) {
        console.error('Unable to queue failed upload artifacts for cleanup:', {
          filename: failedArtifacts.filename,
          error: queueError,
        });
      }
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to read report.' },
      { status: 400 },
    );
  } finally {
    busy = false;
  }
};
