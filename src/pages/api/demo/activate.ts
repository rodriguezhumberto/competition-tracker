import type { APIRoute } from 'astro';
import { sameOrigin } from '../../../lib/auth.ts';
import { limitedFormData } from '../../../lib/http.ts';
import { activateCompetition } from '../../../lib/competition-store.ts';
import { access, demoLink } from '../../../lib/demo-access.ts';
import { withDemo } from '../../../lib/demo-workspaces.ts';
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
  let destination = '/demo/admin?success=1';
  try {
    const form = await limitedFormData(request, 16 * 1024);
    withDemo(workspaceId, () => activateCompetition(form.get('competition_id')));
  } catch (error) {
    destination = `/demo/admin?error=${encodeURIComponent(error instanceof Error ? error.message : 'Unable to activate competition.')}`;
  }
  return new Response(null, {
    status: 303,
    headers: { ...headers, Location: demoLink(destination, url) },
  });
};
