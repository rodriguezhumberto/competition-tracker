import type { APIRoute } from 'astro';
import { isAdmin, sameOrigin } from '../../lib/auth.ts';
import { limitedFormData } from '../../lib/http.ts';
import { addCompetition, updateCompetition } from '../../lib/competition-store.ts';
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return Response.json({ error: 'Unauthorized.' }, { status: 403 });
  try {
    const form = await limitedFormData(request, 128 * 1024),
      input = JSON.parse(String(form.get('payload')));
    const competition = input.competition_id ? updateCompetition(input) : addCompetition(input);
    return Response.json({ id: competition.id });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to save competition.' },
      { status: 400 },
    );
  }
};
