import type { APIRoute } from 'astro';
import { isAdmin, sameOrigin } from '../../lib/auth.ts';
import { limitedFormData } from '../../lib/http.ts';
import { readReportImage } from '../../lib/report-upload.ts';
import { detectReportOrientation } from '../../lib/report-orientation.ts';

let busy = false;
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return Response.json({ error: 'Unauthorized.' }, { status: 403 });
  if (busy)
    return Response.json(
      { error: 'Orientation detection is busy. Rotate manually or try again.' },
      { status: 429 },
    );
  busy = true;
  try {
    const form = await limitedFormData(request, 6 * 1024 * 1024);
    const image = await readReportImage(form.get('report'));
    const orientation = await detectReportOrientation(image.bytes, request.signal);
    return Response.json(orientation, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to detect report orientation.' },
      { status: 400 },
    );
  } finally {
    busy = false;
  }
};
