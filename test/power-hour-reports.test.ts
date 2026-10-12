import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'rally-report-power-hour-'));
process.env.DATABASE_PATH = join(directory, 'test.sqlite');
const { sqlite } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const store = await import('../src/lib/store.ts');
const { addCompetition, getCompetition } = await import('../src/lib/competition-config.ts');
const { createDraft } = await import('../src/lib/draft-store.ts');
const { savePowerHourReport, powerHourReportHistory } =
  await import('../src/lib/power-hour-reports.ts');
const start = Date.now() - 30 * 60000;
const today = new Date(start).toISOString().slice(0, 10);
const c = getCompetition(
  addCompetition({
    name: 'Report format',
    start_date: today,
    end_date: today,
    timezone: 'UTC',
    metrics: [
      {
        key: 'sales',
        label: 'Sales',
        type: 'decimal',
        precision: 2,
        currency: 'USD',
        mode: 'daily',
        required: true,
        public: true,
        direction: 'desc',
        minimum: null,
        maximum: null,
      },
    ],
  }).id,
);
const metric = c.metrics[0];
function report(
  offset: number,
  rows: [string, string][] = [
    ['001', '100.00'],
    ['002', '200.00'],
  ],
) {
  return {
    generated_at: new Date(start + offset * 60000).toISOString(),
    period_start: today,
    period_end: today,
    rows: rows.map(([participant_id, value]) => ({ participant_id, values: { sales: value } })),
  };
}
function draft(raw: ReturnType<typeof report>) {
  return createDraft(c, raw, 'test-proof.png');
}
function startReportSession() {
  const raw = report(0),
    baseline = draft(raw);
  return store.startSession({
    report_mode: true,
    confirmed: true,
    baseline_token: baseline.token,
    baseline_revision: baseline.revision,
    baseline_report: raw,
    report_metric_id: metric.id,
    duration_minutes: 60,
  });
}
function update(sessionId: number, offset: number, rows?: [string, string][]) {
  const raw = report(offset, rows),
    preview = draft(raw);
  return savePowerHourReport({
    session_id: sessionId,
    confirmed: true,
    token: preview.token,
    revision: preview.revision,
    report: raw,
  });
}
beforeEach(() => sqlite.prepare("UPDATE power_hour_sessions SET status = 'archived'").run());
after(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

test('reviewed baseline starts report mode without password and isolates competition standings', () => {
  assert.throws(() => store.startSession({ report_mode: true }), /review|confirm/i);
  const session = startReportSession();
  assert.equal(session.password_hash, null);
  assert.equal(session.created_at, new Date(start).toISOString());
  assert.deepEqual(store.sessionScores(session.id), []);
  assert.deepEqual(store.publicSnapshot().scores, []);
  assert.equal(
    (sqlite.prepare('SELECT count(*) AS count FROM entries').get() as { count: number }).count,
    0,
  );
  assert.throws(() => store.joinSession(session.id, '', 'Viewer'), /view-only/);
  assert.throws(() => store.incrementScore(1, session.id), /view-only/);
});

test('repeated snapshots calculate net gains, preserve absent and unchanged operators and stable identity', () => {
  const session = startReportSession();
  update(session.id, 1, [
    ['001', '103.25'],
    ['002', '200.00'],
  ]);
  const first = store.sessionScores(session.id);
  assert.equal(first.length, 1);
  assert.equal(first[0].name, '001');
  assert.equal(first[0].clicks, 3.25);
  update(session.id, 2, [['001', '103.25']]);
  assert.deepEqual(store.sessionScores(session.id), first);
  update(session.id, 3, [['002', '202.00']]);
  assert.equal(store.sessionScores(session.id)[0].userId, first[0].userId);
  update(session.id, 4, [['001', '108.00']]);
  assert.equal(store.sessionScores(session.id)[0].clicks, 8);
  assert.equal(powerHourReportHistory(session.id).length, 5);
  assert.deepEqual(store.publicSnapshot().scores, store.sessionScores(session.id));
});

test('timestamps serialize, stale drafts and counter resets cannot alter accepted results', () => {
  const session = startReportSession();
  update(session.id, 2, [['001', '103.00']]);
  assert.throws(() => update(session.id, 2), /newer/);
  assert.throws(() => update(session.id, 1), /newer/);
  assert.throws(() => update(session.id, 3, [['001', '102.00']]), /decreased/);
  const raw = report(3),
    preview = draft(raw);
  assert.throws(
    () =>
      savePowerHourReport({
        session_id: session.id,
        token: preview.token,
        revision: 2,
        report: raw,
        confirmed: true,
      }),
    /another tab/,
  );
  assert.equal(powerHourReportHistory(session.id).length, 2);
});

test('extensions move the report cutoff repeatedly and late reports within the grace period are accepted', (t) => {
  const session = startReportSession();
  t.mock.method(Date, 'now', () => start + 30 * 60000);
  store.extendSession({ duration_minutes: 15 });
  store.extendSession({ duration_minutes: 15 });
  assert.equal(store.activeSession()?.ends_at, new Date(start + 90 * 60000).toISOString());
  t.mock.method(Date, 'now', () => start + 100 * 60000);
  assert.equal(update(session.id, 91, [['001', '105.00']]).warning, null);
  assert.equal(store.sessionScores(session.id)[0].clicks, 5);
});

test('draft cleanup preserves proofs retained by separate Power Hour report history', async () => {
  const session = startReportSession();
  const raw = report(1),
    redundant = draft(raw);
  sqlite
    .prepare("UPDATE report_drafts SET status = 'discarded' WHERE token = ?")
    .run(redundant.token);
  const { cleanupDrafts } = await import('../src/lib/draft-cleanup.ts');
  const removed: string[] = [];
  await cleanupDrafts({
    remove: async (path) => {
      removed.push(path);
    },
  });
  assert.deepEqual(removed, []);
  assert.equal(powerHourReportHistory(session.id)[0].proof_image_path, 'test-proof.png');
});

test('report mode broadcasts standings to viewers without participant credentials and rejects taps', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { WebSocket } = await import('ws');
  const { attachRealtime } = await import('../src/lib/realtime.ts');
  const session = startReportSession();
  update(session.id, 1, [['001', '103.25']]);
  const server = createServer();
  const wss = attachRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin });
  try {
    const next = async () => {
      const [raw] = await once(socket, 'message', { signal: AbortSignal.timeout(3000) });
      return JSON.parse(raw.toString());
    };
    const initial = await next();
    assert.equal(initial.requiresPowerHourPassword, false);
    assert.equal(initial.participant, false);
    assert.equal(initial.scores[0].clicks, 3.25);
    const changed = next();
    update(session.id, 2, [['001', '108.00']]);
    assert.equal((await changed).scores[0].clicks, 8);
    const rejected = next();
    socket.send(JSON.stringify({ action: 'increment', sessionId: session.id }));
    assert.match((await rejected).message, /view-only/);
    assert.equal(store.sessionScores(session.id)[0].clicks, 8);
  } finally {
    socket.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('live report configurations and saved metric units cannot change beneath the Power Hour', async () => {
  const { updateCompetition, getCompetitionForEditing } =
    await import('../src/lib/competition-config.ts');
  startReportSession();
  const settings = getCompetitionForEditing(c.id);
  assert.ok(settings.lockedMetricKeys.includes(metric.key));
  assert.equal(settings.hasReports, true);
  const input = {
    ...settings,
    competition_id: c.id,
    profile: settings.profile,
    items: settings.items,
  };
  assert.throws(() => updateCompetition(input), /live Power Hour/);
  store.archiveSession();
  store.publishReportResults(store.openSession()!.id);
  assert.throws(
    () =>
      updateCompetition({
        ...input,
        metrics: settings.metrics.map((metric) => ({ ...metric, precision: 3 })),
      }),
    /locked after values exist/,
  );
});

function pluSession() {
  const competition = getCompetition(
    addCompetition({
      name: 'PLU report format',
      start_date: today,
      end_date: today,
      timezone: 'UTC',
      multiple_items: true,
      items: [
        { code: '00100', name: 'First item' },
        { code: '00200', name: 'Second item' },
        { code: '00300', name: 'Third item' },
      ],
      metrics: c.metrics,
    }).id,
  );
  const raw = { ...report(0), item_code: '00100' };
  const baseline = createDraft(competition, raw, 'plu-proof.png');
  const session = store.startSession({
    report_mode: true,
    confirmed: true,
    baseline_token: baseline.token,
    baseline_revision: baseline.revision,
    baseline_report: raw,
    report_metric_id: competition.metrics[0].id,
    duration_minutes: 60,
  });
  const upload = (code: string, offset: number, rows: [string, string][]) => {
    const raw = { ...report(offset, rows), item_code: code };
    const preview = createDraft(competition, raw, 'plu-proof.png');
    return savePowerHourReport({
      session_id: session.id,
      token: preview.token,
      revision: preview.revision,
      report: raw,
      confirmed: true,
    });
  };
  return { session, upload };
}

test('PLUs establish independent baselines, accept independently ordered timestamps and aggregate operator gains', () => {
  const { session, upload } = pluSession();
  upload('00100', 5, [['001', '108.25']]);
  const original = store.sessionScores(session.id)[0];
  assert.equal(original.clicks, 8.25);
  assert.equal(upload('00200', 2, [['001', '50.00']]).is_baseline, true);
  assert.deepEqual(store.sessionScores(session.id), [original]);
  assert.equal(upload('00200', 3, [['001', '54.00']]).is_baseline, false);
  assert.equal(store.sessionScores(session.id)[0].clicks, 12.25);
  assert.equal(store.sessionScores(session.id)[0].userId, original.userId);
  // Same printed timestamp on another PLU is valid and still awards no points.
  upload('00300', 3, [
    ['001', '500.00'],
    ['003', '10.00'],
  ]);
  assert.equal(store.sessionScores(session.id)[0].clicks, 12.25);
  upload('00300', 4, [
    ['001', '501.00'],
    ['003', '20.00'],
  ]);
  assert.deepEqual(
    store.sessionScores(session.id).map((row) => [row.name, row.clicks]),
    [
      ['001', 13.25],
      ['003', 10],
    ],
  );
  upload('00200', 4, [['001', '54.00']]);
  assert.equal(store.sessionScores(session.id)[0].clicks, 13.25);
  upload('00300', 6, [['003', '21.00']]);
  assert.deepEqual(
    store.sessionScores(session.id).map((row) => [row.name, row.clicks]),
    [
      ['001', 13.25],
      ['003', 11],
    ],
  );
  assert.equal(store.sessionScores(session.id)[0].userId, original.userId);
});

test('PLU duplicate/older reports and decreases are checked within the item', () => {
  const { session, upload } = pluSession();
  upload('00100', 5, [['001', '108.00']]);
  upload('00200', 2, [['001', '50.00']]);
  upload('00200', 3, [['001', '54.00']]);
  assert.throws(() => upload('00200', 3, [['001', '55.00']]), /newer/);
  assert.throws(() => upload('00200', 1, [['001', '55.00']]), /newer/);
  assert.throws(() => upload('00100', 4, [['001', '109.00']]), /newer/);
  assert.throws(() => upload('00200', 4, [['001', '53.00']]), /decreased/);
  upload('00200', 4, [['002', '205.00']]);
  assert.equal(store.sessionScores(session.id).find((row) => row.name === '002')?.clicks, 205);
  assert.equal(store.sessionScores(session.id).find((row) => row.name === '001')?.clicks, 12);
  assert.equal(powerHourReportHistory(session.id).length, 5);
});

test('operators missing from the baseline start at zero and retain subsequent progress', () => {
  const session = startReportSession();
  update(session.id, 1, [
    ['003', '5.00'],
    ['004', '0.00'],
  ]);
  assert.equal(store.sessionScores(session.id).find((row) => row.name === '003')?.clicks, 5);
  assert.equal(
    store.sessionScores(session.id).some((row) => row.name === '004'),
    false,
  );
  update(session.id, 2, [['001', '103.00']]);
  update(session.id, 3, [
    ['003', '8.00'],
    ['004', '2.00'],
  ]);
  assert.deepEqual(
    store.sessionScores(session.id).map((row) => [row.name, row.clicks]),
    [
      ['003', 8],
      ['001', 3],
      ['004', 2],
    ],
  );
  assert.throws(() => update(session.id, 4, [['003', '7.00']]), /decreased/);
  assert.throws(() => update(session.id, 4, [['005', '-1.00']]), /decreased/);
});

test('later Power Hour reports reuse the reviewed period even when extracted dates are wrong or missing', () => {
  const { session } = pluSession();
  for (const [index, code] of ['00100', '00200'].entries()) {
    const raw = {
      ...report(index + 1, [['001', '105.00']]),
      item_code: code,
      period_start: index ? '' : '1900-01-01',
      period_end: 'unreadable',
    };
    const preview = createDraft(getCompetition(session.competition_id!), raw, 'plu-proof.png');
    const saved = savePowerHourReport({
      session_id: session.id,
      token: preview.token,
      revision: preview.revision,
      report: raw,
      confirmed: true,
    });
    assert.equal(saved.period_start, today);
    assert.equal(saved.period_end, today);
    assert.equal(saved.timestamp, raw.generated_at);
    assert.equal(saved.is_baseline, index === 1);
  }
});

test('additional PLU baselines can precede the start while scored updates stay within the session', (t) => {
  const { session, upload } = pluSession();
  assert.equal(upload('00200', -2, [['001', '50.00']]).is_baseline, true);
  assert.equal(upload('00300', -1, [['001', '25.00']]).is_baseline, true);
  assert.equal(store.sessionScores(session.id).length, 0);
  assert.equal(store.openSession()?.created_at, new Date(start).toISOString());
  assert.throws(() => upload('00200', -2, [['001', '50.00']]), /newer/);
  assert.throws(() => upload('00200', -1, [['001', '51.00']]), /before the Power Hour start/);
  upload('00200', 1, [['001', '55.00']]);
  upload('00300', 2, [['001', '28.00']]);
  assert.equal(store.sessionScores(session.id)[0].clicks, 8);
  t.mock.method(Date, 'now', () => start + 100 * 60000);
  assert.equal(upload('00200', 61, [['001', '55.00']]).warning, null);
  assert.match(upload('00200', 66, [['001', '56.00']]).warning!, /more than 5 minutes/);
  assert.equal(powerHourReportHistory(session.id).length, 7);
});

test('report mode waits indefinitely for final reports, then publishes and freezes results', (t) => {
  const session = startReportSession();
  t.mock.timers.enable({ apis: ['Date'], now: start + 61 * 60000 });
  assert.equal(store.activeSession(), null);
  assert.equal(store.openSession()?.status, 'processing');
  assert.equal(store.publicSnapshot().session?.status, 'processing');
  assert.equal(store.publicSnapshot().session?.results_until, null);
  assert.throws(() => startReportSession(), /awaiting final reports/);
  assert.equal(update(session.id, 61, [['001', '105.00']]).warning, null);
  t.mock.timers.setTime(start + 90 * 60000);
  assert.equal(store.publicSnapshot().session?.id, session.id);
  assert.match(update(session.id, 66, [['001', '108.00']]).warning!, /more than 5 minutes/);
  assert.equal(store.sessionScores(session.id)[0].clicks, 8);
  assert.throws(() => store.publishReportResults(session.id + 1), /not awaiting/);
  store.publishReportResults(session.id);
  const results = store.publicSnapshot().session!;
  assert.equal(results.status, 'ended');
  assert.equal(Date.parse(results.results_until!), Date.now() + 120000);
  assert.throws(() => update(session.id, 67, [['001', '109.00']]), /already been published/);
  t.mock.timers.setTime(start + 93 * 60000);
  assert.equal(store.publicSnapshot().session, null);
});

test('the five-minute final-report boundary uses the printed timestamp rather than upload time', (t) => {
  const session = startReportSession();
  t.mock.timers.enable({ apis: ['Date'], now: start + 120 * 60000 });
  assert.equal(update(session.id, 60, [['001', '101.00']]).warning, null);
  assert.equal(update(session.id, 65, [['001', '102.00']]).warning, null);
  assert.match(update(session.id, 65.01, [['001', '103.00']]).warning!, /more than 5 minutes/);
  assert.equal(store.sessionScores(session.id)[0].clicks, 3);
});
