import type { AstroCookies } from 'astro';
import { demoInviteUrl } from './demo-invite.ts';
import { allowAttempt } from './auth.ts';
import { ensure } from './validation.ts';
import { sqlite, hasDatabaseContext } from '../db/index.ts';
import {
  createDemoWorkspace,
  getDemoWorkspace,
  authorizeDemoOwner,
  authorizeDemoShare,
  withDemo,
  touchDemoWorkspace,
} from './demo-workspaces.ts';
import { advanceDemoSimulation, demoSimulationState } from './demo-simulation.ts';
import { sessionState, sessionScores, participantForToken, getArchives } from './store.ts';
import { currentCompetition, leaderboard } from './competition-store.ts';

export const OWNER_COOKIE = 'rally_demo_owner';
export const PARTICIPANT_COOKIE = 'rally_demo_participant';
export const cookieOptions = (url: URL) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: url.protocol === 'https:',
  maxAge: 86400,
});

export function preferences(mode?: 'public' | 'presenter') {
  ensure(hasDatabaseContext(), 'Demo preferences require a validated workspace.');
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS demo_preferences (id INTEGER PRIMARY KEY, mode TEXT NOT NULL)',
  );
  if (mode) sqlite.prepare('INSERT OR REPLACE INTO demo_preferences VALUES (1, ?)').run(mode);
  return (
    (
      sqlite.prepare('SELECT mode FROM demo_preferences WHERE id = 1').get() as
        { mode: 'public' | 'presenter' } | undefined
    )?.mode || 'public'
  );
}

export function access(cookies: AstroCookies, room: unknown, invite: unknown) {
  if (room != null || invite != null) {
    ensure(
      typeof room === 'string' && !!room && typeof invite === 'string' && !!invite,
      'This demo invite is invalid or expired.',
    );
  }
  const credential = cookies.get(OWNER_COOKIE)?.value || '';
  const [ownedId, ownerToken] = credential.split('.');
  const id = typeof room === 'string' && room ? room : ownedId;
  ensure(id && getDemoWorkspace(id), 'This demo has expired. Start a new demo.');
  const owner = id === ownedId && authorizeDemoOwner(id, ownerToken);
  ensure(
    owner || (typeof invite === 'string' && authorizeDemoShare(id, invite)),
    'This demo invite is invalid or expired.',
  );
  touchDemoWorkspace(id);
  return { id, owner };
}

export function participantToken(cookies: AstroCookies, id: string) {
  const [room, token] = (cookies.get(PARTICIPANT_COOKIE)?.value || '').split('.');
  return room === id ? token : undefined;
}

export function demoState(id: string, owner: boolean, cookies: AstroCookies, url: URL) {
  advanceDemoSimulation(id);
  return withDemo(id, () => {
    const competition = currentCompetition();
    ensure(competition, 'Demo sample data is unavailable. Reset your demo.');
    const session = sessionState();
    const participant = session
      ? participantForToken(participantToken(cookies, id), session.id)
      : null;
    return {
      workspaceId: id,
      role: owner ? ('owner' as const) : ('audience' as const),
      mode: preferences(),
      ...(owner
        ? {
            shareToken: getDemoWorkspace(id)!.shareToken,
            shareUrl: demoInviteUrl(url, id, getDemoWorkspace(id)!.shareToken),
          }
        : {}),
      board: leaderboard(competition.id, {
        metric: url.searchParams.get('metric'),
        period: url.searchParams.get('period'),
        item: url.searchParams.get('item'),
        activityLimit: 20,
      }),
      session,
      scores: session ? sessionScores(session.id) : [],
      participant: participant ? { userId: participant.userId, name: participant.name } : null,
      simulation: demoSimulationState(id),
      archives: getArchives()
        .slice(0, 10)
        .map((archive) => ({
          id: archive.id,
          name: archive.name,
          metric_label: archive.metric_label,
          ends_at: archive.ends_at,
          scores: sessionScores(archive.id),
        })),
    };
  });
}

export type DemoState = ReturnType<typeof demoState>;

export function requireDemo(
  cookies: AstroCookies,
  url: URL,
  clientAddress: string,
  create = false,
) {
  ensure(process.env.DEMO_ENABLED !== 'false', 'Demo is disabled.');
  try {
    return access(cookies, url.searchParams.get('room'), url.searchParams.get('invite'));
  } catch (error) {
    if (!create || url.searchParams.has('room') || url.searchParams.has('invite')) throw error;
    ensure(
      allowAttempt(`demo-create:${clientAddress}`, 10),
      'Too many new demos. Try again later.',
    );
    const workspace = createDemoWorkspace();
    cookies.set(OWNER_COOKIE, `${workspace.id}.${workspace.ownerToken}`, cookieOptions(url));
    cookies.delete(PARTICIPANT_COOKIE, { path: '/' });
    withDemo(workspace.id, () => preferences('public'));
    return { id: workspace.id, owner: true };
  }
}

export function demoLink(path: string, url: URL) {
  const target = new URL(path, url.origin);
  for (const key of ['room', 'invite']) {
    const value = url.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  return target.pathname + target.search + target.hash;
}
