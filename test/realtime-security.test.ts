import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const directory = mkdtempSync(join(tmpdir(), 'realtime-security-'));
process.env.DATABASE_PATH = join(directory, 'test.sqlite');
process.env.ADMIN_PASSCODE = 'realtime-tests-generated-passcode';
const { sqlite } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const { attachRealtime, realtimeClientIp } = await import('../src/lib/realtime.ts');
const { events } = await import('../src/lib/events.ts');
after(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

async function fixture(limits = {}) {
  const server = createServer();
  const wss = attachRealtime(server, limits);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const clients: WebSocket[] = [];
  return {
    wss,
    async connect(options = {}) {
      const client = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
        origin,
        ...options,
      });
      clients.push(client);
      const firstMessage = once(client, 'message');
      await once(client, 'open');
      await firstMessage;
      return client;
    },
    async reject() {
      const client = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin });
      clients.push(client);
      const closed = once(client, 'close');
      client.on('error', () => {});
      // events.once rejects on an error event; rejection is expected here.
      await closed.catch(() => {});
      assert.notEqual(client.readyState, WebSocket.OPEN);
    },
    async cleanup() {
      for (const client of clients) client.terminate();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('connection quotas enforce per-IP and global limits and release closed slots', async () => {
  for (const limits of [
    { maxConnections: 2, maxConnectionsPerIp: 1 },
    { maxConnections: 1, maxConnectionsPerIp: 2 },
  ]) {
    const app = await fixture(limits);
    try {
      const client = await app.connect();
      await app.reject();
      const closed = once([...app.wss.clients][0], 'close');
      client.terminate();
      await closed;
      await app.connect();
      assert.equal(app.wss.clients.size, 1);
    } finally {
      await app.cleanup();
    }
  }
});

test('repeated malformed messages close abusive clients', async () => {
  const app = await fixture();
  try {
    const malformed = await app.connect();
    const closed = once(malformed, 'close');
    for (let i = 0; i < 5; i++) malformed.send('{');
    assert.equal((await closed)[0], 1008);
  } finally {
    await app.cleanup();
  }
});

test('transport message floods disconnect even when submissions themselves are accepted', async (t) => {
  const store = await import('../src/lib/store.ts');
  const { PowerHourSubmissionTracker } = await import('../src/lib/power-hour-submissions.ts');
  const { PARTICIPANT_COOKIE } = await import('../src/lib/auth.ts');
  // Isolate transport enforcement from the independent 15-tap gameplay limit.
  t.mock.method(PowerHourSubmissionTracker.prototype, 'submit', () => {});
  const session = store.startSession({ name: 'Flood test', password: 'test-password' });
  const participant = store.joinSession(session.id, 'test-password', 'Flood tester');
  const app = await fixture();
  try {
    const client = await app.connect({
      headers: { Cookie: `${PARTICIPANT_COOKIE}=${participant.token}` },
    });
    const closed = once(client, 'close');
    for (let i = 0; i < 31; i++)
      client.send(JSON.stringify({ action: 'increment', sessionId: session.id }));
    const [code, reason] = await closed;
    assert.equal(code, 1008);
    assert.equal(reason.toString(), 'Too many messages.');
  } finally {
    await app.cleanup();
    store.archiveSession();
  }
});

test('heartbeat retains responsive clients and terminates connections that do not pong', async () => {
  const app = await fixture({ heartbeatMs: 30 });
  try {
    const responsive = await app.connect();
    const silent = await app.connect({ autoPong: false });
    const closed = once(silent, 'close');
    assert.equal((await closed)[0], 1006);
    assert.equal(responsive.readyState, WebSocket.OPEN);
  } finally {
    await app.cleanup();
  }
});

test('broadcasts terminate slow consumers before their send buffer grows further', async () => {
  const app = await fixture({ maxBufferedBytes: 2048 });
  try {
    const client = await app.connect();
    const serverClient = [...app.wss.clients][0];
    Object.defineProperty(serverClient, 'bufferedAmount', { value: 2048 });
    const closed = once(client, 'close');
    events.emit('power-hour-change');
    assert.equal((await closed)[0], 1006);
  } finally {
    await app.cleanup();
  }
});

test('revoked admin connections close even when the site remains public', async () => {
  const { newSession, revokeAdminSession } = await import('../src/lib/auth.ts');
  const token = newSession();
  const app = await fixture();
  try {
    const client = await app.connect({ headers: { Cookie: `admin=${token}` } });
    const closed = once(client, 'close');
    revokeAdminSession(token);
    assert.equal((await closed)[0], 1008);
  } finally {
    await app.cleanup();
  }
});

test('forwarded addresses require an explicitly trusted peer and exact production host', () => {
  const oldTrusted = process.env.TRUSTED_PROXY_IPS;
  const oldHost = process.env.PRODUCTION_HOSTNAME;
  const request = {
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: {
      host: 'competition.example.com',
      'x-forwarded-host': 'competition.example.com',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '198.51.100.10',
    },
  } as unknown as IncomingMessage;
  try {
    process.env.PRODUCTION_HOSTNAME = 'competition.example.com';
    delete process.env.TRUSTED_PROXY_IPS;
    assert.equal(realtimeClientIp(request), '127.0.0.1');
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    assert.equal(realtimeClientIp(request), '198.51.100.10');
    request.headers['x-forwarded-for'] = '198.51.100.10, 198.51.100.20';
    assert.equal(realtimeClientIp(request), '127.0.0.1');
    request.headers['x-forwarded-for'] = '198.51.100.10';
    request.headers['x-forwarded-host'] = 'attacker.example';
    assert.equal(realtimeClientIp(request), '127.0.0.1');
  } finally {
    if (oldTrusted === undefined) delete process.env.TRUSTED_PROXY_IPS;
    else process.env.TRUSTED_PROXY_IPS = oldTrusted;
    if (oldHost === undefined) delete process.env.PRODUCTION_HOSTNAME;
    else process.env.PRODUCTION_HOSTNAME = oldHost;
  }
});
