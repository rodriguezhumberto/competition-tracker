import type { APIRoute } from 'astro';
import { isAdmin, sameOrigin } from '../../../lib/auth.ts';
import { limitedFormData } from '../../../lib/http.ts';
import { startSession } from '../../../lib/store.ts';
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return Response.json({ error: 'Unauthorized.' }, { status: 403 });
  try {
    const form = await limitedFormData(request, 256 * 1024);
    const input = JSON.parse(String(form.get('payload')));
    input.report_mode = true;
    const session = startSession(input);
    return Response.json({
      message: 'Baseline confirmed. Power Hour started.',
      session_id: session.id,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to start Power Hour.' },
      { status: 400 },
    );
  }
};
