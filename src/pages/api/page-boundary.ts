import type { APIRoute } from 'astro';
import { isAdmin, sameOrigin } from '../../lib/auth.ts';
import { limitedFormData } from '../../lib/http.ts';
import { readReportImage } from '../../lib/report-upload.ts';
import { reportRotation } from '../../lib/report-image.ts';
import { suggestPageBoundary } from '../../lib/page-boundary.ts';

let busy = false;
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return Response.json({ error: 'Unauthorized.' }, { status: 403 });
  if (busy)
    return Response.json(
      { error: 'Page detection is busy. Crop manually or try again.' },
      { status: 429 },
    );
  busy = true;
  try {
    const form = await limitedFormData(request, 6 * 1024 * 1024);
    const image = await readReportImage(form.get('report'));
    return Response.json(
      await suggestPageBoundary(image.bytes, reportRotation(form.get('rotation'))),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to detect page boundaries.' },
      { status: 400 },
    );
  } finally {
    busy = false;
  }
};
