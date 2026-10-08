import { defineMiddleware } from 'astro:middleware';
import { withDemoRequest } from './db/index.ts';
import { isDemoSitePath, isPublicSitePath, siteAccessAllowed } from './lib/site-access.ts';
import { withSecurityHeaders } from './lib/security-headers.ts';

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname.replace(/\/+$/, '') || '/';
  if (isDemoSitePath(path)) return withSecurityHeaders(await withDemoRequest(() => next()));
  if (
    !isPublicSitePath(path) &&
    !siteAccessAllowed(context.request.headers.get('cookie') || undefined)
  ) {
    const headers = { 'Cache-Control': 'private, no-store' };
    if (path.startsWith('/api/') || path === '/ws')
      return withSecurityHeaders(
        Response.json({ error: 'Sign in to view this site.' }, { status: 401, headers }),
      );
    return withSecurityHeaders(
      new Response(null, {
        status: 302,
        headers: {
          ...headers,
          Location: `/login?returnTo=${encodeURIComponent(context.url.pathname + context.url.search)}`,
        },
      }),
    );
  }
  const response = await next();
  response.headers.set('Cache-Control', 'private, no-store');
  return withSecurityHeaders(response);
});
