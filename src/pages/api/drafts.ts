import type { APIRoute } from 'astro';
import { isAdmin, sameOrigin } from '../../lib/auth.ts';
import { limitedFormData } from '../../lib/http.ts';
import {
  addDraftItem,
  discardDraft,
  draftView,
  listPendingDrafts,
  saveDraftEdits,
} from '../../lib/draft-store.ts';
import { ensure } from '../../lib/assertions.ts';

const headers = { 'Cache-Control': 'private, no-store' };
export const GET: APIRoute = ({ cookies, url }) => {
  if (!isAdmin(cookies)) return Response.json({ error: 'Unauthorized.' }, { status: 403, headers });
  try {
    const token = url.searchParams.get('token');
    return Response.json(token ? draftView(token) : { drafts: listPendingDrafts() }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Draft unavailable.' },
      { status: 404, headers },
    );
  }
};

export const POST: APIRoute = async ({ cookies, request }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return Response.json({ error: 'Unauthorized.' }, { status: 403, headers });
  try {
    const form = await limitedFormData(request, 256 * 1024);
    const input = JSON.parse(String(form.get('payload')));
    if (input.action === 'add_item') {
      return Response.json(
        {
          ...addDraftItem(input.token, input.revision, input.item, input.report),
          message: 'Item added to the competition. Review this report again before confirming.',
        },
        { headers },
      );
    }
    if (input.action === 'save') {
      return Response.json(
        {
          ...saveDraftEdits(input.token, input.revision, input.report),
          message: 'Draft saved. No scores have changed.',
        },
        { headers },
      );
    }
    ensure(input.action === 'discard', 'Unknown draft action.');
    discardDraft(input.token, input.revision);
    return Response.json({ message: 'Draft discarded.' }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to update draft.' },
      { status: 400, headers },
    );
  }
};
