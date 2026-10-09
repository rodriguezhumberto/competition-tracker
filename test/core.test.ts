import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { eq } from 'drizzle-orm';
const temp = mkdtempSync(join(tmpdir(), 'rally-test-'));
process.env.DATABASE_PATH = join(temp, 'test.db');
process.env.ADMIN_PASSCODE = 'test-passcode';
const { db, sqlite } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const store = await import('../src/lib/store.ts');
const { competitions, entries, power_hour_scores, power_hour_sessions, power_hour_participants } =
  await import('../src/db/schema.ts');
const { attachRealtime } = await import('../src/lib/realtime.ts');
const { newMetric } = await import('../src/lib/metrics.ts');
const { saveReport } = await import('../src/lib/report-store.ts');
const { hashPowerHourPassword, verifyPowerHourPassword } = await import('../src/lib/auth.ts');
const { resolveReportTime } = await import('../src/lib/report-time.ts');
const reportTimestamp = (value: unknown) => resolveReportTime(value, 'America/Chicago');
const { centralDate, centralClock, centralWeek, centralReportTime, manualReportTimestamp } =
  await import('../src/lib/central-time.ts');
const now = new Date();
const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
const competition = store.addCompetition({
  name: 'Test',
  metrics: [{ ...newMetric('sales'), label: 'Sales', precision: 6 }],
  start_date: '2020-01-01',
  end_date: tomorrow,
  is_active: 'on',
});
const sharedPassword = 'correct horse battery';
after(() => {
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

test('daily contributions reset each day and preserve signed decimals', () => {
  const firstDay = new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10);
  const secondDay = yesterday;
  const add = (operator: string, day: string, time: string, total: number | string) => {
    const [entry] = saveReport(competition.id, {
      generated_at: `${day}T${time}:00Z`,
      period_start: day,
      period_end: day,
      rows: [{ participant_id: operator, values: { sales: total } }],
    });
    return (
      sqlite.prepare('SELECT contribution FROM report_values WHERE entry_id=?').get(entry.id) as {
        contribution: number;
      }
    ).contribution;
  };
  assert.equal(add('119', firstDay, '10:00', '10.25'), 10250000);
  assert.equal(add('119', firstDay, '11:00', '12.75'), 2500000);
  assert.equal(add('119', firstDay, '12:00', '9.5'), -3250000);
  assert.equal(add('119', secondDay, '10:00', '3.125'), 3125000);
  assert.equal(add('119', secondDay, '11:00', '-1.25'), -4375000);
  assert.equal(add('147', secondDay, '10:00', '-2.5'), -2500000);
  assert.throws(() => add('119', secondDay, '11:00', 0), /newer/);
  assert.throws(() => add('119', firstDay, '13:00', 0), /newer/);
  assert.throws(() => add('119', tomorrow, '10:00', 0), /future/);
  const own = db
    .select()
    .from(entries)
    .all()
    .filter((e) => e.competition_id === competition.id);
  assert.deepEqual(
    own.filter((e) => e.operator_number === '119').map((e) => e.report_date),
    [firstDay, firstDay, firstDay, secondDay, secondDay],
  );
  assert.equal(add('500', firstDay, '10:00', '999999999.99'), 999999999990000);
  assert.equal(add('500', firstDay, '11:00', '1000000000'), 10000);
  for (const invalid of ['NaN', 'Infinity', '1e3', '1.1234567891', '--2'])
    assert.throws(() => add('200', secondDay, '10:00', invalid), /Sales/);
});
test('strict timestamps and salted shared passwords', () => {
  assert.equal(reportTimestamp('2026-01-01T10:00:00-06:00'), '2026-01-01T16:00:00.000Z');
  const west = store.addCompetition({
    name: 'Timezone day',
    metrics: [{ ...newMetric('sales'), label: 'Sales', precision: 6 }],
    start_date: '2026-09-01',
    end_date: '2026-09-30',
  });
  assert.equal(
    saveReport(west.id, {
      generated_at: '2026-09-22T23:30:00-06:00',
      period_start: '2026-09-22',
      period_end: '2026-09-22',
      rows: [{ participant_id: '303', values: { sales: '4' } }],
    })[0].report_date,
    '2026-09-22',
  );
  assert.throws(() => reportTimestamp('2026-02-30T10:00'), /Invalid/);
  assert.equal(reportTimestamp('2026-01-01T10:00'), '2026-01-01T16:00:00.000Z');
  const hash = hashPowerHourPassword('test password');
  assert.notEqual(hash, hashPowerHourPassword('test password'));
  assert(verifyPowerHourPassword('test password', hash));
  assert(!verifyPowerHourPassword('wrong password', hash));
});
test('manual Central clocks and explicit offsets preserve the printed report day', () => {
  assert.equal(
    reportTimestamp(manualReportTimestamp('2026-01-15T10:20', '')),
    '2026-01-15T16:20:00.000Z',
  );
  assert.equal(
    reportTimestamp(manualReportTimestamp('2026-07-15T10:20', '')),
    '2026-07-15T15:20:00.000Z',
  );
  assert.equal(reportTimestamp('2026-07-15T10:20:00+02:00'), '2026-07-15T08:20:00.000Z');
  const late = store.addCompetition({
    name: 'Late Central reports',
    metrics: [{ ...newMetric('sales'), label: 'Sales', precision: 6 }],
    start_date: '2026-01-15',
    end_date: '2026-01-15',
  });
  const [saved] = saveReport(late.id, {
    generated_at: '2026-01-15T23:30',
    period_start: '2026-01-15',
    period_end: '2026-01-15',
    rows: [{ participant_id: '811', values: { sales: '7' } }],
  });
  assert.equal(saved.timestamp_on_report, '2026-01-16T05:30:00.000Z');
  assert.equal(saved.report_date, '2026-01-15');
  assert.throws(
    () =>
      saveReport(late.id, {
        generated_at: '2026-01-15T09:00',
        period_start: '2026-01-16',
        period_end: '2026-01-16',
        rows: [{ participant_id: '812', values: { sales: '1' } }],
      }),
    /competition dates/,
  );
  assert.equal(centralReportTime(saved.timestamp_on_report), '2026-01-15 23:30:00 CST');
  assert.equal(centralReportTime('2026-07-15T15:20:00.000Z'), '2026-07-15 10:20:00 CDT');
  assert.throws(() => manualReportTimestamp('2026-07-15T10:20', '-06:00'), /does not match/);
});
test('Central today and Monday to Sunday week survive UTC midnight and DST', () => {
  assert.equal(centralDate(new Date('2026-01-16T00:30:00Z')), '2026-01-15');
  assert.equal(centralDate(new Date('2026-03-09T04:59:59Z')), '2026-03-08');
  assert.equal(centralDate(new Date('2026-03-09T05:00:00Z')), '2026-03-09');
  assert.deepEqual(centralWeek(centralDate(new Date('2026-03-09T04:59:59Z'))), {
    start: '2026-03-02',
    end: '2026-03-08',
  });
  assert.deepEqual(centralWeek(centralDate(new Date('2026-03-09T05:00:00Z'))), {
    start: '2026-03-09',
    end: '2026-03-15',
  });
  assert.equal(centralDate(new Date('2026-11-02T05:59:59Z')), '2026-11-01');
  assert.equal(centralDate(new Date('2026-11-02T06:00:00Z')), '2026-11-02');
  assert.equal(centralClock(new Date('2026-11-01T06:30:00Z')), '2026-11-01T01:30:00');
  assert.equal(centralClock(new Date('2026-11-01T07:30:00Z')), '2026-11-01T01:30:00');
});
test('spring gaps fail and fall overlaps require a selected offset', () => {
  assert.equal(reportTimestamp('2026-03-08T01:59:59'), '2026-03-08T07:59:59.000Z');
  assert.throws(() => reportTimestamp('2026-03-08T02:30:00'), /does not exist/);
  assert.equal(reportTimestamp('2026-03-08T03:00:00'), '2026-03-08T08:00:00.000Z');
  assert.throws(() => reportTimestamp('2026-11-01T01:30:00'), /occurs twice/);
  assert.equal(
    reportTimestamp(manualReportTimestamp('2026-11-01T01:30', '-05:00')),
    '2026-11-01T06:30:00.000Z',
  );
  assert.equal(
    reportTimestamp(manualReportTimestamp('2026-11-01T01:30', '-06:00')),
    '2026-11-01T07:30:00.000Z',
  );
  assert.equal(centralReportTime('2026-11-01T06:30:00.000Z'), '2026-11-01 01:30:00 CDT');
  assert.equal(centralReportTime('2026-11-01T07:30:00.000Z'), '2026-11-01 01:30:00 CST');
});
test('concurrent increments are atomic and never change permanent entries', async () => {
  const baseline = db.select().from(entries).all();
  const session = store.startSession({ name: 'Concurrent Power Hour', password: sharedPassword });
  const alice = store.joinSession(session.id, sharedPassword, 'Alice');
  assert.throws(
    () => store.startSession({ name: 'Duplicate', password: sharedPassword }),
    /already/,
  );
  store.activateCompetition(competition.id);
  const moduleUrl = new URL('../src/lib/store.ts', import.meta.url).href;
  await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(
            `import { incrementScore } from ${JSON.stringify(moduleUrl)}; for(let i=0;i<100;i++)incrementScore(${alice.userId},${session.id});`,
            { eval: true },
          );
          worker.on('error', reject);
          worker.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)),
          );
        }),
    ),
  );
  assert.equal(store.sessionScores(session.id).find((p) => p.userId === alice.userId)?.clicks, 400);
  assert.deepEqual(db.select().from(entries).all(), baseline);
  store.archiveSession();
  assert.throws(() => store.incrementScore(alice.userId, session.id), /ended/);
  assert.equal(store.getArchives()[0].id, session.id);
});
test('WebSocket participation uses the browser credential, ignores forged user IDs, and retains read-only results until the lobby closes', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  const wss = attachRealtime(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const observer = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin });
  const observed: any[] = [];
  observer.on('message', (data) => observed.push(JSON.parse(data.toString())));
  const waitFor = async (messages: any[], predicate: (m: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const item = messages.find(predicate);
      if (item) return item;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Missing WebSocket event');
  };
  let ws: WebSocket | undefined;
  try {
    await once(observer, 'open');
    await waitFor(observed, (m) => 'session' in m);
    const session = store.startSession({ name: 'Live test', password: sharedPassword });
    await waitFor(observed, (m) => m.event === 'power_hour_started');
    assert.equal(
      'password_hash' in (await waitFor(observed, (m) => m.event === 'power_hour_started')).session,
      false,
    );
    observer.send(JSON.stringify({ action: 'increment', userId: 1, sessionId: session.id }));
    await waitFor(observed, (m) => m.event === 'error' && /browser/.test(m.message));
    assert.throws(
      () => store.joinSession(session.id, 'wrong password', 'Bob'),
      /Incorrect shared password/,
    );
    assert.equal(
      db
        .select()
        .from(power_hour_participants)
        .where(eq(power_hour_participants.session_id, session.id))
        .all().length,
      0,
    );
    const alice = store.joinSession(session.id, sharedPassword, 'Alice');
    const bob = store.joinSession(session.id, sharedPassword, 'Bob');
    assert.notEqual(
      db
        .select()
        .from(power_hour_participants)
        .where(eq(power_hour_participants.user_id, alice.userId))
        .get()?.credential_hash,
      alice.token,
    );
    assert.deepEqual(store.participantForToken(alice.token), {
      userId: alice.userId,
      name: 'Alice',
      sessionId: session.id,
    });
    assert.throws(() => store.joinSession(session.id, sharedPassword, 'Alice'), /already in use/);
    ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin,
      headers: { Cookie: `power_hour_participant=${alice.token}` },
    });
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    await waitFor(messages, (m) => m.event === 'joined' && m.userId === alice.userId);
    ws.send(JSON.stringify({ action: 'increment', userId: bob.userId, sessionId: session.id }));
    const update = await waitFor(
      messages,
      (m) =>
        m.event === 'scores_updated' &&
        m.scores.some((p: any) => p.userId === alice.userId && p.clicks === 1),
    );
    assert.equal(update.session.id, session.id);
    assert.equal(store.sessionScores(session.id).find((p) => p.userId === bob.userId)?.clicks, 0);
    assert(
      observed.some((m) => 'scores' in m) &&
        observed.filter((m) => 'scores' in m).every((m) => m.scores.length === 0),
    );
    store.archiveSession();
    const final = await waitFor(messages, (m) => m.event === 'power_hour_ended');
    assert.equal(final.session.status, 'ended');
    assert.equal(final.scores.find((p: any) => p.userId === alice.userId).clicks, 1);
    assert.equal(store.participantForToken(alice.token)?.userId, alice.userId);
    ws.send(JSON.stringify({ action: 'increment', sessionId: session.id }));
    await waitFor(messages, (m) => m.event === 'error' && /ended/.test(m.message));
    db.update(power_hour_sessions)
      .set({ ends_at: new Date(Date.now() - 120001).toISOString() })
      .where(eq(power_hour_sessions.id, session.id))
      .run();
    const closed = await waitFor(messages, (m) => m.event === 'power_hour_closed');
    assert.equal(closed.session, null);
    assert.equal(store.participantForToken(alice.token), null);
    assert.equal(
      db.select().from(power_hour_scores).where(eq(power_hour_scores.session_id, session.id)).get()
        ?.clicks,
      1,
    );
  } finally {
    ws?.terminate();
    observer.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('a sustained burst flags the score for admin review without rejecting accepted entries', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  const wss = attachRealtime(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = store.startSession({ name: 'Review rate', password: sharedPassword });
  const member = store.joinSession(session.id, sharedPassword, 'Rate Tester');
  const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', {
    origin,
    headers: { Cookie: `power_hour_participant=${member.token}` },
  });
  const updates: any[] = [];
  ws.on('message', (data) => updates.push(JSON.parse(data.toString())));
  const tap = async (expected: number) => {
    ws.send(JSON.stringify({ action: 'increment', sessionId: session.id }));
    for (let i = 0; i < 100; i++) {
      if (
        updates.some(
          (message) => message.event === 'scores_updated' && message.scores[0]?.clicks === expected,
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Missing score ${expected}`);
  };
  try {
    await once(ws, 'open');
    for (let count = 1; count <= 6; count++) await tap(count);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    for (let count = 7; count <= 10; count++) await tap(count);
    assert.equal(store.sessionScores(session.id)[0].flagged, false);
    await tap(11);
    assert.equal(store.sessionScores(session.id)[0].flagged, true);
    assert.equal(store.sessionScores(session.id)[0].clicks, 11);
  } finally {
    ws.terminate();
    store.archiveSession();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('final standings survive expiry and reload for two minutes without accepting writes', () => {
  const session = store.startSession({ name: 'Results window', password: sharedPassword });
  const member = store.joinSession(session.id, sharedPassword, 'Result Viewer');
  store.incrementScore(member.userId, session.id);
  const end = Date.now() - 1000;
  db.update(power_hour_sessions)
    .set({ ends_at: new Date(end).toISOString() })
    .where(eq(power_hour_sessions.id, session.id))
    .run();
  assert.equal(store.activeSession(), null);
  const final = store.snapshot();
  assert.equal(final.session?.id, session.id);
  assert.equal(final.session?.status, 'ended');
  assert.equal(final.session?.results_until, new Date(end + 120000).toISOString());
  assert.equal(final.scores[0].clicks, 1);
  assert.equal(store.publicSnapshot().session?.status, 'ended');
  assert.deepEqual(store.publicSnapshot().scores, []);
  assert.equal(store.participantForToken(member.token)?.userId, member.userId);
  assert.throws(() => store.incrementScore(member.userId, session.id), /ended/);
  assert.throws(() => store.joinSession(session.id, sharedPassword, 'Late Viewer'), /ended/);
  db.update(power_hour_sessions)
    .set({ ends_at: new Date(Date.now() - 119000).toISOString() })
    .where(eq(power_hour_sessions.id, session.id))
    .run();
  assert.equal(store.snapshot().session?.id, session.id);
  // Age every archived session so earlier tests cannot supply another results lobby.
  db.update(power_hour_sessions)
    .set({ ends_at: new Date(Date.now() - 120001).toISOString() })
    .run();
  assert.deepEqual(store.snapshot(), { session: null, scores: [] });
  assert.equal(store.participantForToken(member.token), null);
  assert.equal(store.getArchivedSession(session.id)?.id, session.id);
});
test('ending early starts the results window immediately and a new Power Hour replaces it', () => {
  const session = store.startSession({ name: 'Early end', password: sharedPassword });
  const before = Date.now();
  store.archiveSession();
  const final = store.snapshot().session!;
  assert.equal(final.status, 'ended');
  assert(Date.parse(final.ends_at) >= before && Date.parse(final.ends_at) <= Date.now());
  assert.ok(final.results_until);
  assert.equal(Date.parse(final.results_until) - Date.parse(final.ends_at), 120000);
  const next = store.startSession({ name: 'Next Power Hour', password: sharedPassword });
  assert.equal(store.snapshot().session?.id, next.id);
  assert.equal(store.snapshot().session?.status, 'active');
  assert.equal(store.getArchivedSession(session.id)?.id, session.id);
  store.archiveSession();
});
test('expired sessions archive automatically and group size is enforced', () => {
  const session = store.startSession({ name: 'Expired', password: sharedPassword });
  db.update(power_hour_sessions)
    .set({ ends_at: new Date(Date.now() - 1000).toISOString() })
    .where(eq(power_hour_sessions.id, session.id))
    .run();
  assert.equal(store.activeSession(), null);
  assert.equal(
    db.select().from(power_hour_sessions).where(eq(power_hour_sessions.id, session.id)).get()
      ?.status,
    'archived',
  );
  const next = store.startSession({ name: 'Capacity', password: sharedPassword });
  const first = store.joinSession(next.id, sharedPassword, 'Person 0');
  for (let i = 1; i < 20; i++) store.joinSession(next.id, sharedPassword, `Person ${i}`);
  assert.throws(() => store.joinSession(next.id, sharedPassword, 'Too many'), /20 participants/);
  assert.equal(
    store.joinSession(next.id, sharedPassword, 'person 0', first.token).userId,
    first.userId,
  );
  store.archiveSession();
});
test('admins choose a duration and add time to a live session', () => {
  assert.throws(
    () => store.startSession({ name: 'Invalid', password: sharedPassword, duration_minutes: '0' }),
    /1–1440/,
  );
  assert.throws(
    () =>
      store.startSession({ name: 'Invalid', password: sharedPassword, duration_minutes: '1.5' }),
    /1–1440/,
  );
  const session = store.startSession({
    name: 'Custom duration',
    password: sharedPassword,
    duration_minutes: '25',
  });
  assert.equal(Date.parse(session.ends_at!) - Date.parse(session.created_at), 25 * 60000);
  assert.equal(store.publicSnapshot().session?.ends_at, session.ends_at);
  assert.throws(() => store.extendSession({ duration_minutes: 'bad' }), /1–1440/);
  const extended = store.extendSession({ duration_minutes: '15' });
  assert.equal(Date.parse(extended.ends_at!) - Date.parse(session.ends_at!), 15 * 60000);
  assert.equal(store.snapshot().session?.ends_at, extended.ends_at);
  store.archiveSession();
  assert.throws(() => store.extendSession({ duration_minutes: '10' }), /No Power Hour/);
});
test('participant names are checked before insertion', () => {
  const session = store.startSession({ name: 'Names', password: sharedPassword });
  for (const name of [
    '<script>alert(1)</script>',
    'Bad\nName',
    'https://example.com',
    'A'.repeat(21),
    'Admin',
    'Shit',
    'F.U.C.K',
    's h 1 t',
    'b17ch',
    'f4gg0t',
    'n1gg3r',
    'fuuuck',
    '4ssh0l3',
    'ad min',
  ]) {
    assert.throws(() => store.joinSession(session.id, sharedPassword, name));
  }
  assert.equal(store.sessionScores(session.id).length, 0);
  const member = store.joinSession(session.id, sharedPassword, '  Zoë  Rivera ');
  assert.equal(store.sessionScores(session.id)[0].name, 'Zoë Rivera');
  assert.equal(
    store.joinSession(session.id, sharedPassword, 'zoë rivera', member.token).userId,
    member.userId,
  );
  assert.throws(
    () => store.joinSession(session.id, sharedPassword, 'zoë rivera'),
    /already in use/,
  );
  assert.equal(store.joinSession(session.id, sharedPassword, 'Z'.repeat(20)).userId > 0, true);
  assert.equal(store.joinSession(session.id, sharedPassword, 'Classy Name').userId > 0, true);
  store.archiveSession();
});
test('Power Hours run without an active or in-date competition', () => {
  db.update(competitions).set({ is_active: false }).run();
  const standalone = store.startSession({ name: 'Standalone', password: sharedPassword });
  assert.equal(standalone.competition_id, null);
  const member = store.joinSession(standalone.id, sharedPassword, 'Standalone Member');
  store.incrementScore(member.userId, standalone.id);
  assert.equal(store.sessionScores(standalone.id)[0].clicks, 1);
  const future = store.addCompetition({
    name: 'Future',
    metrics: [{ ...newMetric('sales'), label: 'Sales', precision: 6 }],
    start_date: '2099-01-01',
    end_date: '2099-01-31',
    is_active: 'on',
  });
  assert.equal(store.activeSession()?.id, standalone.id);
  store.archiveSession();
  const outsideDates = store.startSession({ name: 'Outside dates', password: sharedPassword });
  assert.equal(outsideDates.competition_id, null);
  assert.equal(store.currentCompetition()?.id, future.id);
  store.archiveSession();
});
