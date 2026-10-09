import type { APIRoute } from 'astro';
import { isAdmin, revokeAdminSession, sameOrigin } from '../../lib/auth.ts';
import {
  activateCompetition,
  startSession,
  extendSession,
  archiveSession,
  publishReportResults,
} from '../../lib/store.ts';
import { limitedFormData } from '../../lib/http.ts';
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return new Response('Unauthorized', { status: 403 });
  try {
    const input = Object.fromEntries(await limitedFormData(request, 16384));
    switch (input.action) {
      case 'logout':
        revokeAdminSession(cookies.get('admin')?.value || '');
        cookies.delete('admin', { path: '/' });
        return redirect('/admin/login', 303);
      case 'activate':
        activateCompetition(input.competition_id);
        break;
      case 'start':
        startSession(input);
        break;
      case 'extend':
        extendSession(input);
        break;
      case 'publish_results':
        publishReportResults(Number(input.session_id));
        break;
      case 'archive':
        archiveSession();
        break;
      default:
        throw new Error('Unknown action.');
    }
    return redirect('/admin?success=1', 303);
  } catch (error) {
    return redirect(
      `/admin?error=${encodeURIComponent(error instanceof Error ? error.message : 'Unable to save.')}`,
      303,
    );
  }
};
