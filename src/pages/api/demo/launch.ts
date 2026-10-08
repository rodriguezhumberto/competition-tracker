import type { APIRoute } from 'astro';
import { allowAttempt, isAdmin, sameOrigin } from '../../../lib/auth.ts';
import {
  OWNER_COOKIE,
  PARTICIPANT_COOKIE,
  cookieOptions,
  preferences,
} from '../../../lib/demo-access.ts';
import { createDemoWorkspace, withDemo } from '../../../lib/demo-workspaces.ts';

const headers = { 'Cache-Control': 'private, no-store' };

export const POST: APIRoute = ({ request, cookies, url, clientAddress }) => {
  if (process.env.DEMO_ENABLED === 'false')
    return new Response('Not found.', { status: 404, headers });
  if (!isAdmin(cookies) || !sameOrigin(request))
    return new Response('Unauthorized.', { status: 403, headers });
  try {
    if (!allowAttempt(`demo-create:${clientAddress}`, 10))
      throw new Error('Too many new demos. Try again later.');
    const workspace = createDemoWorkspace();
    withDemo(workspace.id, () => preferences('presenter'));
    cookies.set(OWNER_COOKIE, `${workspace.id}.${workspace.ownerToken}`, cookieOptions(url));
    cookies.delete(PARTICIPANT_COOKIE, { path: '/' });
    return new Response(null, {
      status: 303,
      headers: { ...headers, Location: '/demo/admin' },
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'Unable to launch the demo.';
    return new Response(null, {
      status: 303,
      headers: { ...headers, Location: `/admin?error=${encodeURIComponent(error)}` },
    });
  }
};
