import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AstroCookies } from 'astro';

const directory = mkdtempSync(join(tmpdir(), 'rally-auth-'));
process.env.DATABASE_PATH = join(directory, 'auth.sqlite');
const originalEnvironment = process.env.NODE_ENV;
const strongPasscode = 'jA8Xy6kP2qV9mN4sW7rT3bH5';
const { sqlite, withDemoRequest } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const auth = await import('../src/lib/auth.ts');
const adminApi = await import('../src/pages/api/admin.ts');

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  process.env.ADMIN_PASSCODE = strongPasscode;
  sqlite.prepare('DELETE FROM admin_sessions').run();
});
after(() => {
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

test('admin credentials are random, stored only as hashes, and reject forged legacy cookies', () => {
  const first = auth.newSession();
  const second = auth.newSession();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  const rows = sqlite.prepare('SELECT * FROM admin_sessions').all();
  assert.equal(rows.length, 2);
  assert(!JSON.stringify(rows).includes(first));
  assert.equal(auth.isAdminCookieHeader(`admin=${first}`), true);
  for (const value of [
    '',
    'abc',
    first.slice(0, -1),
    `${first}.extra`,
    '0'.repeat(64),
    `${Date.now() + 3600000}.forged`,
  ])
    assert.equal(auth.isAdminCookieHeader(`admin=${value}`), false);
  assert.equal(auth.isAdminCookieHeader(`other_admin=${first}`), false);
  assert.throws(() => withDemoRequest(() => auth.newSession()), /Production settings/);
});

test('logout invalidates a copied cookie without affecting another admin session', async () => {
  const token = auth.newSession();
  const other = auth.newSession();
  let deleted = false;
  const cookies = {
    get: (name: string) => (name === 'admin' ? { value: token } : undefined),
    delete: () => {
      deleted = true;
    },
  } as unknown as AstroCookies;
  const response = await adminApi.POST({
    request: new Request('https://competition.example.com/api/admin', {
      method: 'POST',
      headers: { Origin: 'https://competition.example.com' },
      body: new URLSearchParams({ action: 'logout' }),
    }),
    cookies,
    redirect: (location: string, status: number) =>
      new Response(null, { status, headers: { Location: location } }),
  } as Parameters<typeof adminApi.POST>[0]);
  assert.equal(response.status, 303);
  assert.equal(deleted, true);
  assert.equal(auth.isAdminCookieHeader(`admin=${token}`), false);
  assert.equal(auth.isAdminCookieHeader(`admin=${other}`), true);
});

test('expired sessions cannot authenticate and new logins clean expired records', (t) => {
  const token = auth.newSession();
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 12 * 3600000 + 1000);
  assert.equal(auth.isAdminCookieHeader(`admin=${token}`), false);
  auth.newSession();
  assert.equal(
    (sqlite.prepare('SELECT count(*) AS n FROM admin_sessions').get() as { n: number }).n,
    1,
  );
});

test('passcode rotation invalidates sessions and a new login clears prior credential records', () => {
  const first = auth.newSession();
  const second = auth.newSession();
  process.env.ADMIN_PASSCODE = 'qT7Xw4mK8sB6nV2pJ9rL5aD3';
  assert.equal(auth.isAdminCookieHeader(`admin=${first}`), false);
  const current = auth.newSession();
  assert.equal(auth.isAdminCookieHeader(`admin=${second}`), false);
  assert.equal(auth.isAdminCookieHeader(`admin=${current}`), true);
  assert.equal(
    (sqlite.prepare('SELECT count(*) AS n FROM admin_sessions').get() as { n: number }).n,
    1,
  );
});

test('admin sessions survive server process restart and revocation remains effective across processes', () => {
  const token = auth.newSession();
  const run = () =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const auth = await import('./src/lib/auth.ts'); console.log(auth.isAdminCookieHeader('admin=' + process.env.TEST_ADMIN_TOKEN));",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, TEST_ADMIN_TOKEN: token },
        encoding: 'utf8',
      },
    );
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'true');
  auth.revokeAdminSession(token);
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'false');
});

test('production rejects missing, weak, control-containing and checked-in example passcodes', () => {
  for (const value of [
    '',
    'short',
    'a'.repeat(32),
    'passwordpassword123',
    'change-this-to-a-long-private-passcode',
    'browser-test-passcode',
    'replace-me-with-private-value',
    ` ${strongPasscode}`,
    `${strongPasscode}\n`,
    'abcdabcdabcdabcd',
  ]) {
    process.env.ADMIN_PASSCODE = value;
    assert.equal(auth.passcodeMatches(value), false, value);
    assert.throws(() => auth.assertProductionAdminPasscode(), /Production ADMIN_PASSCODE/);
    assert.throws(() => auth.newSession(), /securely/);
  }
  process.env.ADMIN_PASSCODE = strongPasscode;
  assert.doesNotThrow(() => auth.assertProductionAdminPasscode());
  assert.equal(auth.passcodeMatches(strongPasscode), true);
  process.env.NODE_ENV = 'development';
  process.env.ADMIN_PASSCODE = 'short-test-only';
  assert.doesNotThrow(() => auth.assertProductionAdminPasscode());
  assert.equal(auth.passcodeMatches('short-test-only'), true);
});

test('standalone startup defaults to production and fails before listening without printing the passcode', () => {
  const unsafePasscode = 'shortPrivate';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ADMIN_PASSCODE: unsafePasscode,
    DATABASE_PATH: join(directory, 'startup.sqlite'),
  };
  delete env.NODE_ENV;
  const result = spawnSync(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Production ADMIN_PASSCODE/);
  assert(!result.stderr.includes(unsafePasscode));
});

test('startup cleanup removes rotated credentials permanently without requiring a new login', () => {
  const token = auth.newSession();
  const env = {
    ...process.env,
    ADMIN_PASSCODE: 'qT7Xw4mK8sB6nV2pJ9rL5aD3',
  };
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const auth = await import('./src/lib/auth.ts'); auth.assertProductionAdminPasscode(); auth.cleanupAdminSessions();",
    ],
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  // The current process still has the original credential; reverting cannot restore the token.
  assert.equal(process.env.ADMIN_PASSCODE, strongPasscode);
  assert.equal(auth.isAdminCookieHeader(`admin=${token}`), false);
  assert.equal(
    (sqlite.prepare('SELECT count(*) AS n FROM admin_sessions').get() as { n: number }).n,
    0,
  );
});
