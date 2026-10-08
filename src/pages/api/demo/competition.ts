import type { APIRoute } from 'astro';
import { sameOrigin } from '../../../lib/auth.ts';
import { limitedFormData } from '../../../lib/http.ts';
import {
  addCompetition,
  updateCompetition,
  getCompetitions,
} from '../../../lib/competition-store.ts';
import { access } from '../../../lib/demo-access.ts';
import { withDemo } from '../../../lib/demo-workspaces.ts';
import { sqlite } from '../../../db/index.ts';
import { ensure } from '../../../lib/validation.ts';
const headers = { 'Cache-Control': 'private, no-store' };

export const POST: APIRoute = async ({ request, cookies, url }) => {
  if (process.env.DEMO_ENABLED === 'false')
    return new Response('Not found.', { status: 404, headers });
  if (!sameOrigin(request))
    return Response.json({ error: 'Unauthorized.' }, { status: 403, headers });
  let workspaceId: string;
  try {
    const room = access(cookies, url.searchParams.get('room'), url.searchParams.get('invite'));
    ensure(room.owner, 'Only the demo owner can manage competitions.');
    workspaceId = room.id;
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unauthorized.' },
      { status: 403, headers },
    );
  }
  try {
    const form = await limitedFormData(request, 128 * 1024);
    const input = JSON.parse(String(form.get('payload')));
    const competition = withDemo(workspaceId, () =>
      sqlite
        .transaction(() => {
          ensure(
            input && typeof input === 'object' && !Array.isArray(input),
            'Invalid competition.',
          );
          if (input.competition_id) return updateCompetition(input);
          ensure(
            getCompetitions().length < 20,
            'This demo already has 20 competitions. Reset the demo to start again.',
          );
          return addCompetition(input);
        })
        .immediate(),
    );
    return Response.json({ id: competition.id }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to save competition.' },
      { status: 400, headers },
    );
  }
};
