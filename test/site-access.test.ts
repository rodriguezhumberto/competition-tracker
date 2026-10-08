import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';

const directory = mkdtempSync(join(tmpdir(), 'rally-site-access-'));
process.env.DATABASE_PATH = join(directory, 'site.sqlite');
process.env.ADMIN_PASSCODE = 'site-access-admin-passcode';
const { sqlite, withDatabase, withDemoRequest } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const access = await import('../src/lib/site-access.ts');
const { newSession } = await import('../src/lib/auth.ts');

beforeEach(() => access.updateSitePrivacy(false));
after(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

test('new installations are public and cannot enable protection without a valid password', () => {
  assert.equal(access.getSitePrivacy().enabled, false);
  assert.equal(access.getSitePrivacy().passwordHash, null);
  assert.equal(access.siteAccessAllowed(undefined), true);
  assert.throws(() => access.updateSitePrivacy(true));
  for (const password of ['short', '        ', 'x'.repeat(129), 'test\npassword']) {
    assert.throws(() => access.updateSitePrivacy(true, password));
    assert.equal(access.getSitePrivacy().enabled, false);
    assert.equal(access.getSitePrivacy().passwordHash, null);
  }
});

test('passwords are hashed and shared viewers cannot acquire admin privileges', () => {
  access.updateSitePrivacy(true, 'visitor-password');
  const settings = access.getSitePrivacy();
  assert.equal(settings.enabled, true);
  assert.ok(settings.passwordHash);
  assert.notEqual(settings.passwordHash, 'visitor-password');
  assert.equal(access.viewerPasswordMatches('visitor-password'), true);
  for (const value of [undefined, null, 123, {}, 'wrong-password', 'visitor-password ']) {
    assert.equal(access.viewerPasswordMatches(value), false);
  }
  assert.equal(access.siteAccessAllowed(undefined), false);
  assert.equal(access.siteAccessAllowed('rally_demo_owner=demo.owner-token'), false);
  assert.equal(access.siteAccessAllowed('rally_demo_participant=demo.participant-token'), false);
  assert.equal(access.siteAccessAllowed(`admin=${newSession()}`), true);
  const token = access.newViewerSession();
  assert.equal(access.validViewerSession(token), true);
  assert.equal(access.isViewerCookieHeader(`other=value; site_viewer=${token}`), true);
  assert.equal(access.siteAccessAllowed(`site_viewer=${token}`), true);
  assert.equal(access.siteAccessAllowed(`admin=${token}`), false);
});

test('forged, malformed, tampered and expired viewer sessions cannot read private data', (t) => {
  access.updateSitePrivacy(true, 'visitor-password');
  const token = access.newViewerSession();
  for (const value of ['', 'true', '123.forged', `${token}.extra`, `${token.slice(0, -1)}!`]) {
    assert.equal(access.validViewerSession(value), false);
    assert.equal(access.siteAccessAllowed(`site_viewer=${value}`), false);
  }
  assert.equal(access.isViewerCookieHeader(`fake_site_viewer=${token}`), false);
  assert.equal(
    access.isViewerCookieHeader(`site_viewer=${encodeURIComponent(token + ';')}`),
    false,
  );
  const later = Date.now() + 12 * 3600000 + 1000;
  t.mock.method(Date, 'now', () => later);
  assert.equal(access.validViewerSession(token), false);
  assert.equal(access.siteAccessAllowed(`site_viewer=${token}`), false);
});

test('unchanged settings preserve viewers while password rotation and explicit revocation invalidate them', () => {
  access.updateSitePrivacy(true, 'first-password');
  let token = access.newViewerSession();
  const original = access.getSitePrivacy();
  access.updateSitePrivacy(true, '');
  assert.deepEqual(access.getSitePrivacy(), original);
  assert.equal(access.validViewerSession(token), true);
  access.updateSitePrivacy(true, 'second-password');
  assert.equal(access.validViewerSession(token), false);
  assert.equal(access.viewerPasswordMatches('first-password'), false);
  assert.equal(access.viewerPasswordMatches('second-password'), true);
  token = access.newViewerSession();
  access.revokeViewerSessions();
  assert.equal(access.validViewerSession(token), false);
  assert.equal(access.viewerPasswordMatches('second-password'), true);
  assert.equal(access.siteAccessAllowed(`admin=${newSession()}`), true);
});

test('disabling and re-enabling protection cannot resurrect previous viewer sessions', () => {
  access.updateSitePrivacy(true, 'visitor-password');
  const token = access.newViewerSession();
  const version = access.getSitePrivacy().sessionVersion;
  access.updateSitePrivacy(false);
  assert.notEqual(access.getSitePrivacy().sessionVersion, version);
  assert.equal(access.siteAccessAllowed(undefined), true);
  access.updateSitePrivacy(true);
  assert.equal(access.validViewerSession(token), false);
  assert.equal(access.siteAccessAllowed(undefined), false);
  assert.equal(access.viewerPasswordMatches('visitor-password'), true);
});

test('site settings and viewer sessions survive a new server process', () => {
  access.updateSitePrivacy(true, 'persisted-password');
  const token = access.newViewerSession();
  const script = `
    const access = await import('./src/lib/site-access.ts');
    console.log(JSON.stringify({
      settings: access.getSitePrivacy(),
      password: access.viewerPasswordMatches('persisted-password'),
      session: access.validViewerSession(process.env.TEST_VIEWER_TOKEN),
    }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_VIEWER_TOKEN: token },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.settings, access.getSitePrivacy());
  assert.equal(result.password, true);
  assert.equal(result.session, true);
});

test('return paths stay on the production site and cannot redirect to an external origin', () => {
  for (const value of [
    null,
    '',
    'https://example.com',
    '//example.com',
    '/\\example.com',
    '/\n/example.com',
  ]) {
    assert.equal(access.safeReturnPath(value), '/');
  }
  assert.equal(
    access.safeReturnPath('/competitions/3?metric=sales'),
    '/competitions/3?metric=sales',
  );
  assert.equal(access.safeReturnPath('/archives'), '/archives');
});

test('demo exemptions use route boundaries and never exempt production data endpoints', () => {
  for (const path of [
    '/demo',
    '/demo/admin',
    '/demo/competitions/1',
    '/api/demo',
    '/api/demo/competition',
    '/privacy',
    '/disclaimer',
  ]) {
    assert.equal(access.isPublicSitePath(path), true, path);
  }
  for (const path of [
    '/',
    '/admin',
    '/competitions/1',
    '/archives',
    '/api/state',
    '/api/results',
    '/ws',
    '/demography',
    '/api/demo-fake',
    '/privacy/private-data',
    '/disclaimer-fake',
  ]) {
    assert.equal(access.isPublicSitePath(path), false, path);
  }
});

test('demo requests and selected workspaces cannot read or change production privacy settings', () => {
  const settings = access.getSitePrivacy();
  const workspace = new Database(':memory:');
  try {
    for (const run of [
      (fn: () => void) => withDemoRequest(fn),
      (fn: () => void) => withDatabase(workspace, fn),
      (fn: () => void) => withDemoRequest(() => withDatabase(workspace, fn)),
    ]) {
      assert.throws(() => run(() => access.getSitePrivacy()), /Production settings/);
      assert.throws(
        () => run(() => access.updateSitePrivacy(true, 'demo-password')),
        /Production settings/,
      );
      assert.throws(() => run(() => access.revokeViewerSessions()), /Production settings/);
    }
    assert.deepEqual(access.getSitePrivacy(), settings);
  } finally {
    workspace.close();
  }
});

test('live connections reject demo credentials and close anonymous or revoked viewers', async () => {
  const { attachRealtime } = await import('../src/lib/realtime.ts');
  const server = createServer();
  const sockets: WebSocket[] = [];
  const wss = attachRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const connect = (cookie?: string) => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
      origin,
      headers: cookie ? { Cookie: cookie } : undefined,
    });
    sockets.push(socket);
    return socket;
  };
  const closed = (socket: WebSocket) =>
    once(socket, 'close', { signal: AbortSignal.timeout(3000) });
  try {
    const anonymous = connect();
    await once(anonymous, 'message', { signal: AbortSignal.timeout(3000) });
    const anonymousClosed = closed(anonymous);
    access.updateSitePrivacy(true, 'websocket-password');
    await anonymousClosed;

    for (const cookie of [undefined, 'rally_demo_owner=room.owner', 'site_viewer=forged']) {
      const denied = connect(cookie);
      denied.on('error', () => {});
      const outcome = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Unauthorized socket did not close')),
          3000,
        );
        denied.once('open', () => {
          clearTimeout(timeout);
          resolve('open');
        });
        denied.once('error', () => {
          clearTimeout(timeout);
          resolve('rejected');
        });
      });
      assert.equal(outcome, 'rejected', String(cookie));
    }

    const viewer = connect(`site_viewer=${access.newViewerSession()}`);
    await once(viewer, 'message', { signal: AbortSignal.timeout(3000) });
    const viewerClosed = closed(viewer);
    access.revokeViewerSessions();
    await viewerClosed;
    const admin = connect(`admin=${newSession()}`);
    await once(admin, 'message', { signal: AbortSignal.timeout(3000) });
    access.revokeViewerSessions();
    assert.equal(admin.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
