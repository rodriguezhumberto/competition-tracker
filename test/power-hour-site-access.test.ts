import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';

const directory = mkdtempSync(join(tmpdir(), 'rally-power-hour-access-'));
process.env.DATABASE_PATH = join(directory, 'site.sqlite');
process.env.ADMIN_PASSCODE = 'power-hour-access-admin';
const { sqlite, withDatabase, withDemoRequest } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const store = await import('../src/lib/store.ts');
const access = await import('../src/lib/site-access.ts');
const { newSession, PARTICIPANT_COOKIE } = await import('../src/lib/auth.ts');
const { POST } = await import('../src/pages/api/power-hour/join.ts');
const sharedPassword = 'power-hour-password';

beforeEach(() => {
  store.archiveSession();
  access.updateSitePrivacy(false);
});
after(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

function startProtected() {
  access.updateSitePrivacy(true, 'site-viewer-password');
  const session = store.startSession({ name: 'Protected Power Hour', password: sharedPassword });
  const cookie = `site_viewer=${access.newViewerSession()}`;
  return { session, cookie };
}

test('authenticated viewers and admins join by name and retain participant credentials', () => {
  const { session, cookie } = startProtected();
  const viewer = store.joinSessionWithSiteAccess(session.id, '  Zoë  Rivera ', null, cookie);
  assert.equal(viewer.name, 'Zoë Rivera');
  assert.match(viewer.token, /^[a-f0-9]{64}$/);
  assert.equal(store.participantForToken(viewer.token, session.id)?.userId, viewer.userId);
  const admin = store.joinSessionWithSiteAccess(
    session.id,
    'Organizer',
    null,
    `admin=${newSession()}`,
  );
  assert.notEqual(admin.userId, viewer.userId);
  assert.equal(store.sessionScores(session.id).length, 2);
  assert.throws(() => store.joinSession(session.id, undefined, 'Other Visitor'), /password/i);
});

test('anonymous, forged, demo and revoked cookies cannot bypass the Power Hour password', () => {
  const { session, cookie } = startProtected();
  for (const denied of [
    undefined,
    'site_viewer=forged',
    'admin=forged',
    'rally_demo_owner=demo.owner',
    'rally_demo_participant=demo.participant',
    `admin=${cookie.slice('site_viewer='.length)}`,
  ]) {
    assert.throws(() => store.joinSessionWithSiteAccess(session.id, 'Visitor', null, denied));
  }
  access.revokeViewerSessions();
  assert.throws(() => store.joinSessionWithSiteAccess(session.id, 'Visitor', null, cookie));
  assert.equal(store.sessionScores(session.id).length, 0);
});

test('expired site sessions cannot admit participants', (t) => {
  access.updateSitePrivacy(true, 'site-viewer-password');
  const cookie = `site_viewer=${access.newViewerSession()}`;
  const later = Date.now() + 12 * 3600000 + 1000;
  t.mock.method(Date, 'now', () => later);
  const session = store.startSession({ name: 'Later session', password: sharedPassword });
  assert.throws(() => store.joinSessionWithSiteAccess(session.id, 'Visitor', null, cookie));
  assert.equal(store.sessionScores(session.id).length, 0);
});

test('disabling protection requires the Power Hour password, including for admins', () => {
  const { session, cookie } = startProtected();
  store.joinSessionWithSiteAccess(session.id, 'First Visitor', null, cookie);
  access.updateSitePrivacy(false);
  for (const header of [undefined, cookie, `admin=${newSession()}`]) {
    assert.throws(() => store.joinSessionWithSiteAccess(session.id, 'Next Visitor', null, header));
  }
  assert.throws(() => store.joinSession(session.id, 'wrong-password', 'Next Visitor'), /password/i);
  const participant = store.joinSession(session.id, sharedPassword, 'Next Visitor');
  assert.ok(participant.userId);
  access.updateSitePrivacy(true);
  assert.throws(() => store.joinSessionWithSiteAccess(session.id, 'Third Visitor', null, cookie));
});

test('name-only admission preserves validation, duplicate names, browser identity, capacity and ended checks', () => {
  const { session, cookie } = startProtected();
  const admit = (name: unknown, token: unknown = null) =>
    store.joinSessionWithSiteAccess(session.id, name, token, cookie);
  for (const name of ['Admin', '<script>', 'Bad\nName', 'A'.repeat(21), null]) {
    assert.throws(() => admit(name));
  }
  assert.equal(store.sessionScores(session.id).length, 0);
  const first = admit('Person 0');
  assert.throws(() => admit('person 0'), /already in use/);
  assert.throws(() => admit('Someone Else', first.token), /already joined/);
  for (let index = 1; index < 20; index++) admit(`Person ${index}`);
  assert.throws(() => admit('Extra Visitor'), /20 participants/);
  assert.equal(admit('person 0', first.token).userId, first.userId);
  store.archiveSession();
  assert.throws(() => admit('Late Visitor'), /ended/);
});

test('demo database and request scopes cannot use production site access for admission', () => {
  const { session, cookie } = startProtected();
  const workspace = new Database(':memory:');
  try {
    migrateDatabase(workspace);
    for (const run of [
      (fn: () => void) => withDemoRequest(fn),
      (fn: () => void) => withDatabase(workspace, fn),
    ]) {
      assert.throws(() =>
        run(() => store.joinSessionWithSiteAccess(session.id, 'Demo Visitor', null, cookie)),
      );
    }
    assert.equal(store.sessionScores(session.id).length, 0);
  } finally {
    workspace.close();
  }
});

async function joinViaApi(sessionId: number, name: string, cookie?: string, password?: string) {
  const form = new URLSearchParams({ sessionId: String(sessionId), name, skipPassword: 'true' });
  if (password !== undefined) form.set('password', password);
  const written: { name: string; value: string; options: unknown }[] = [];
  const request = new Request('http://site.local/api/power-hour/join', {
    method: 'POST',
    headers: { Origin: 'http://site.local', ...(cookie ? { Cookie: cookie } : {}) },
    body: form,
  });
  const response = await POST({
    request,
    clientAddress: '127.0.0.1',
    cookies: {
      get: () => undefined,
      set: (name: string, value: string, options: unknown) =>
        written.push({ name, value, options }),
    },
  } as unknown as Parameters<typeof POST>[0]);
  return { response, written };
}

test('join API chooses admission on the server and sets a participant cookie only after joining', async () => {
  const { session, cookie } = startProtected();
  const viewer = await joinViaApi(session.id, 'Viewer', cookie);
  assert.equal(viewer.response.status, 200);
  assert.equal(viewer.response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(viewer.written[0]?.name, PARTICIPANT_COOKIE);
  assert.match(viewer.written[0]?.value || '', /^[a-f0-9]{64}$/);
  assert.equal((await viewer.response.json()).name, 'Viewer');
  for (const header of [undefined, 'rally_demo_owner=demo.owner', 'site_viewer=forged']) {
    const denied = await joinViaApi(session.id, 'Denied Visitor', header);
    assert.ok(denied.response.status >= 400);
    assert.deepEqual(denied.written, []);
  }
  access.updateSitePrivacy(false);
  const denied = await joinViaApi(session.id, 'Public Visitor', `admin=${newSession()}`);
  assert.ok(denied.response.status >= 400);
  assert.deepEqual(denied.written, []);
  const admitted = await joinViaApi(session.id, 'Public Visitor', undefined, sharedPassword);
  assert.equal(admitted.response.status, 200);
  assert.equal(admitted.written[0]?.name, PARTICIPANT_COOKIE);
});

test('live admission mode reflects initial privacy and changes during a running Power Hour', async () => {
  store.startSession({ name: 'Live admission', password: sharedPassword });
  const { attachRealtime } = await import('../src/lib/realtime.ts');
  const server = createServer();
  const wss = attachRealtime(server);
  let socket: WebSocket | undefined;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
      origin,
      headers: { Cookie: `admin=${newSession()}` },
    });
    const nextState = async () => {
      const [raw] = await once(socket!, 'message', { signal: AbortSignal.timeout(3000) });
      return JSON.parse(raw.toString());
    };
    assert.equal((await nextState()).requiresPowerHourPassword, true);
    const protectedState = nextState();
    access.updateSitePrivacy(true, 'site-viewer-password');
    assert.equal((await protectedState).requiresPowerHourPassword, false);
    const publicState = nextState();
    access.updateSitePrivacy(false);
    assert.equal((await publicState).requiresPowerHourPassword, true);
  } finally {
    socket?.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
