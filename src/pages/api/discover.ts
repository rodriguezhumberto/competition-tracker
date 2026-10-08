import { reportCrop } from '../../lib/report-crop.ts';
import type { APIRoute } from 'astro';
import { isAdmin, sameOrigin } from '../../lib/auth.ts';
import { limitedFormData } from '../../lib/http.ts';
import { discoverReport } from '../../lib/vision.ts';
import { preprocessReportImage, reportRotation } from '../../lib/report-image.ts';
import { readReportImage } from '../../lib/report-upload.ts';
let busy = false;
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return Response.json({ error: 'Unauthorized.' }, { status: 403 });
  if (busy)
    return Response.json(
      { error: 'A sample is already processing. Try again shortly.' },
      { status: 429 },
    );
  busy = true;
  try {
    const form = await limitedFormData(request, 6 * 1024 * 1024),
      image = await readReportImage(form.get('report'));
    const processed = await preprocessReportImage(
      image.bytes,
      reportRotation(form.get('rotation')),
      reportCrop(form.get('crop')),
    );
    return Response.json(
      {
        ...(await discoverReport(processed.bytes, processed.mimeType)),
        processing: processed.processing,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to read sample.' },
      { status: 400 },
    );
  } finally {
    busy = false;
  }
};
