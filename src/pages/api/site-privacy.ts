import type { APIRoute } from 'astro';
import { isAdmin, sameOrigin } from '../../lib/auth.ts';
import { limitedFormData } from '../../lib/http.ts';
import { revokeViewerSessions, updateSitePrivacy } from '../../lib/site-access.ts';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return new Response('Unauthorized', { status: 403 });
  try {
    const form = await limitedFormData(request, 4096);
    const action = form.get('action');
    if (action === 'revoke') {
      revokeViewerSessions();
      return redirect('/admin?privacy=revoked#site-privacy', 303);
    }
    if (action !== 'save') throw new Error('Unknown privacy action.');
    const enabled = form.get('enabled');
    const password = form.get('password');
    if ((enabled !== null && enabled !== 'true') || typeof password !== 'string')
      throw new Error('Invalid site privacy settings.');
    updateSitePrivacy(enabled === 'true', password || undefined);
    return redirect('/admin?privacy=saved#site-privacy', 303);
  } catch (error) {
    return redirect(
      `/admin?error=${encodeURIComponent(error instanceof Error ? error.message : 'Unable to save site privacy.')}#site-privacy`,
      303,
    );
  }
};
