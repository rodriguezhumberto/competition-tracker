import { UnknownTrackedItemError } from '../../lib/leaderboard.ts';
import type { APIRoute } from 'astro';
import { allowAttempt, sameOrigin } from '../../lib/auth.ts';
import { ensure, positiveId } from '../../lib/validation.ts';
import { demoPassword } from '../../lib/demo-seed.ts';
import { createDemoWorkspace, resetDemoWorkspace, withDemo } from '../../lib/demo-workspaces.ts';
import {
  startDemoSimulation,
  pauseDemoSimulation,
  triggerDemoReview,
  stopDemoSimulation,
  submitDemoPoint,
  joinDemoParticipant,
} from '../../lib/demo-simulation.ts';
import { participantForToken, extendSession, archiveSession } from '../../lib/store.ts';
import {
  OWNER_COOKIE,
  PARTICIPANT_COOKIE,
  cookieOptions,
  preferences,
  access,
  participantToken,
  demoState,
} from '../../lib/demo-access.ts';

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers });

async function readInput(request: Request): Promise<Record<string, unknown>> {
  ensure(
    request.headers.get('content-type')?.split(';')[0] === 'application/json',
    'Send JSON data.',
  );
  const reader = request.body?.getReader();
  ensure(reader, 'Missing request data.');
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      ensure(length <= 4096, 'Demo request is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString());
  ensure(data && typeof data === 'object' && !Array.isArray(data), 'Invalid demo request.');
  return data as Record<string, unknown>;
}

export const GET: APIRoute = ({ cookies, url }) => {
  if (process.env.DEMO_ENABLED === 'false') return json({ error: 'Demo is disabled.' }, 404);
  try {
    const { id, owner } = access(
      cookies,
      url.searchParams.get('room'),
      url.searchParams.get('invite'),
    );
    return json(demoState(id, owner, cookies, url));
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Unable to load demo.' },
      error instanceof UnknownTrackedItemError ? 400 : 403,
    );
  }
};

export const POST: APIRoute = async ({ request, cookies, url, clientAddress }) => {
  if (process.env.DEMO_ENABLED === 'false') return json({ error: 'Demo is disabled.' }, 404);
  if (!sameOrigin(request)) return json({ error: 'Unauthorized' }, 403);
  try {
    const input = await readInput(request);
    if (input.action === 'create') {
      ensure(
        allowAttempt(`demo-create:${clientAddress}`, 10),
        'Too many new demos. Try again later.',
      );
      const mode = input.mode === 'presenter' ? 'presenter' : 'public';
      const workspace = createDemoWorkspace();
      cookies.set(OWNER_COOKIE, `${workspace.id}.${workspace.ownerToken}`, cookieOptions(url));
      cookies.delete(PARTICIPANT_COOKIE, { path: '/' });
      withDemo(workspace.id, () => preferences(mode));
      return json(demoState(workspace.id, true, cookies, url));
    }
    const { id, owner } = access(cookies, input.room, input.invite);
    for (const key of ['metric', 'period', 'item']) {
      if (typeof input[key] === 'string') url.searchParams.set(key, input[key]);
    }
    const action = input.action;
    ensure(
      owner || action === 'join' || action === 'increment',
      'Only the demo host can use this control.',
    );
    if (action === 'mode') {
      ensure(input.mode === 'public' || input.mode === 'presenter', 'Choose a demo mode.');
      withDemo(id, () => preferences(input.mode as 'public' | 'presenter'));
      if (input.mode === 'public') pauseDemoSimulation(id, false);
    } else if (action === 'reset') {
      const mode = withDemo(id, () => preferences());
      stopDemoSimulation(id);
      resetDemoWorkspace(id);
      withDemo(id, () => preferences(mode));
      cookies.delete(PARTICIPANT_COOKIE, { path: '/' });
    } else if (action === 'start') {
      startDemoSimulation(id);
      cookies.delete(PARTICIPANT_COOKIE, { path: '/' });
    } else if (action === 'pause' || action === 'resume') {
      ensure(
        withDemo(id, () => preferences()) === 'presenter',
        'Switch to presenter mode to use this control.',
      );
      pauseDemoSimulation(id, action === 'pause');
    } else if (action === 'review') {
      triggerDemoReview(id);
    } else if (action === 'end') {
      stopDemoSimulation(id);
      withDemo(id, () => archiveSession());
    } else if (action === 'extend') {
      withDemo(id, () => extendSession({ duration_minutes: input.minutes ?? 1 }));
    } else if (action === 'join') {
      if (input.password !== undefined)
        ensure(input.password === demoPassword, 'Incorrect shared password.');
      ensure(
        allowAttempt(`demo-join:${clientAddress}`, 30),
        'Too many join attempts. Try again later.',
      );
      const sessionId = positiveId(input.sessionId);
      const joined = joinDemoParticipant(id, sessionId, input.name, participantToken(cookies, id));
      cookies.set(PARTICIPANT_COOKIE, `${id}.${joined.token}`, cookieOptions(url));
    } else if (action === 'increment') {
      const sessionId = positiveId(input.sessionId);
      const participant = withDemo(id, () =>
        participantForToken(participantToken(cookies, id), sessionId),
      );
      ensure(participant, 'Join this Power Hour first.');
      submitDemoPoint(id, participant.userId, sessionId);
    } else {
      throw new Error('Unknown demo action.');
    }
    return json(demoState(id, owner, cookies, url));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to update demo.' }, 400);
  }
};
