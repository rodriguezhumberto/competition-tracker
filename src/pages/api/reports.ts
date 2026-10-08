import type { APIRoute } from 'astro';
import { isAdmin, sameOrigin } from '../../lib/auth.ts';
import { limitedFormData } from '../../lib/http.ts';
import { saveReport } from '../../lib/competition-store.ts';
import { sqlite } from '../../db/index.ts';
import { reviewableDraft } from '../../lib/draft-store.ts';
import { ensure } from '../../lib/validation.ts';
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies) || !sameOrigin(request))
    return Response.json({ error: 'Unauthorized.' }, { status: 403 });
  try {
    const form = await limitedFormData(request, 256 * 1024);
    const input = JSON.parse(String(form.get('payload')));
    ensure(input.confirmed === true, 'Review the report and confirm before saving.');
    const saved = sqlite
      .transaction(() => {
        if (input.token) {
          const draft = reviewableDraft(input.token);
          return saveReport(draft.competition_id, input.report, {
            schemaVersion: draft.schema_version,
            profileVersion: draft.profile_version,
            proof: draft.proof_image_path,
            draftToken: draft.token,
            draftRevision: input.revision,
          });
        }
        ensure(
          Number.isSafeInteger(input.schema_version),
          'Reload the competition before entering values.',
        );
        return saveReport(input.competition_id, input.report, {
          schemaVersion: input.schema_version,
        });
      })
      .immediate();
    return Response.json({
      message: `Report saved. Updated ${saved.length} participant${saved.length === 1 ? '' : 's'}.`,
      count: saved.length,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to save report.' },
      { status: 400 },
    );
  }
};
