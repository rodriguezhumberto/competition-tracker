import { events } from '../../../lib/events.ts';
import type { APIRoute } from 'astro';
import { allowAttempt, PARTICIPANT_COOKIE, sameOrigin } from '../../../lib/auth.ts';
import { limitedFormData } from '../../../lib/http.ts';
import { joinSession, joinSessionWithSiteAccess } from '../../../lib/store.ts';
import { positiveId } from '../../../lib/validation.ts';
import { getSitePrivacy, siteAccessAllowed } from '../../../lib/site-access.ts';

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  if (!sameOrigin(request)) return Response.json({ error: 'Invalid origin.' }, { status: 403 });
  if (!allowAttempt(`power-hour-join:${clientAddress}`, 30))
    return Response.json(
      { error: 'Too many join attempts. Try again in 10 minutes.' },
      { status: 429 },
    );
  try {
    const form = await limitedFormData(request, 4096);
    const header = request.headers.get('cookie') || undefined;
    if (!siteAccessAllowed(header))
      return Response.json(
        { error: 'Sign in to view this site.' },
        {
          status: 401,
          headers: { 'Cache-Control': 'private, no-store' },
        },
      );
    const sessionId = positiveId(form.get('sessionId'));
    const token = cookies.get(PARTICIPANT_COOKIE)?.value;
    const member = getSitePrivacy().enabled
      ? joinSessionWithSiteAccess(sessionId, form.get('name'), token, header)
      : joinSession(sessionId, form.get('password'), form.get('name'), token);
    cookies.set(PARTICIPANT_COOKIE, member.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: new URL(request.url).protocol === 'https:',
      path: '/',
    });
    events.emit('power-hour-change');
    return Response.json(
      { userId: member.userId, name: member.name },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to join.' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
};
