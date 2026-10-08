import type { APIRoute } from 'astro';
import { sameOrigin } from '../../lib/auth.ts';
import { VIEWER_COOKIE } from '../../lib/site-access.ts';

export const POST: APIRoute = ({ request, cookies }) => {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!sameOrigin(request)) return new Response('Unauthorized.', { status: 403, headers });
  cookies.delete(VIEWER_COOKIE, { path: '/' });
  return new Response(null, { status: 303, headers: { ...headers, Location: '/login' } });
};
