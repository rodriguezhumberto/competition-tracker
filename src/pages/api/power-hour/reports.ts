import type { APIRoute } from 'astro';
import { isAdmin, sameOrigin } from '../../../lib/auth.ts';
import { limitedFormData } from '../../../lib/http.ts';
import { savePowerHourReport } from '../../../lib/power-hour-reports.ts';
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return Response.json({ error: 'Unauthorized.' }, { status: 403 });
  try {
    const form = await limitedFormData(request, 256 * 1024);
    const input = JSON.parse(String(form.get('payload')));
    const saved = savePowerHourReport(input);
    return Response.json({
      message: saved.is_baseline ? 'Item baseline saved.' : 'Power Hour report saved.',
      is_baseline: saved.is_baseline,
      timestamp: saved.timestamp,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to save report.' },
      { status: 400 },
    );
  }
};
