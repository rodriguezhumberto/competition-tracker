import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
const temp = mkdtempSync(join(tmpdir(), 'rally-metrics-'));
process.env.DATABASE_PATH = join(temp, 'test.db');
const { sqlite, db } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const { addCompetition, getCompetition, updateCompetition, saveReport, leaderboard } =
  await import('../src/lib/competition-store.ts');
const { getCompetitionForEditing, getCompetitionConfigurations } =
  await import('../src/lib/competition-config.ts');
const { newMetric, formatMetric } = await import('../src/lib/metrics.ts');
const { normalizeMetricReport, discoverReport, extractMetricReport } =
  await import('../src/lib/vision.ts');
const { report_values, reports, report_drafts } = await import('../src/db/schema.ts');
const { resolveReportTime } = await import('../src/lib/report-time.ts');
const { resultsCsv, resultsFilename } = await import('../src/lib/results-csv.ts');
after(() => {
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
const metrics = [
  { ...newMetric('units'), label: 'Number Sold', precision: 2 },
  {
    ...newMetric('money'),
    label: 'Private Revenue',
    type: 'currency' as const,
    public: false,
    required: false,
  },
  {
    ...newMetric('calls'),
    label: 'Calls',
    type: 'integer' as const,
    precision: 0,
    mode: 'additive' as const,
  },
  {
    ...newMetric('time'),
    label: 'Latest score',
    mode: 'latest' as const,
    direction: 'asc' as const,
  },
];
function competition() {
  return addCompetition({
    name: 'Metric test',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    metrics,
    official_metric_key: 'units',
  });
}
function input(
  time: string,
  rows: { participant_id: string; values: Record<string, string | null> }[],
) {
  return {
    generated_at: time,
    period_start: time.slice(0, 10),
    period_end: time.slice(0, 10),
    rows,
  };
}
const row = (id: string, units: string, money: string | null, calls = '1', time = '8.00') => ({
  participant_id: id,
  values: { units, money, calls, time },
});

test('configuration query count does not grow with competition count and locks are editing-only', () => {
  const c = competition();
  saveReport(c.id, input('2026-09-01T10:00:00Z', [row('001', '1.00', null)]));
  const original = sqlite.prepare;
  const calls: string[] = [];
  sqlite.prepare = function (this: typeof sqlite, source: string) {
    calls.push(source);
    return original.call(this, source);
  } as typeof sqlite.prepare;
  try {
    getCompetition(c.id);
    assert(!calls.some((query) => query.includes('report_values')));
    calls.length = 0;
    getCompetitionConfigurations();
    const initialQueries = calls.length;
    for (let i = 0; i < 5; i++) competition();
    calls.length = 0;
    const configurations = getCompetitionConfigurations();
    assert.equal(calls.length, initialQueries);
    assert.deepEqual(
      configurations.find((config) => config.id === c.id),
      getCompetition(c.id),
    );
    assert.deepEqual(getCompetitionForEditing(c.id).lockedMetricKeys.sort(), [
      'calls',
      'time',
      'units',
    ]);
  } finally {
    sqlite.prepare = original;
  }
});

test('activity is bounded, paginated and audience-filtered', () => {
  const c = competition();
  saveReport(
    c.id,
    input('2026-09-01T10:00:00Z', [
      row('1', '1.00', '99.00'),
      row('2', '2.00', null),
      row('3', '3.00', null),
    ]),
  );
  saveReport(
    c.id,
    input('2026-09-02T10:00:00Z', [
      row('4', '4.00', null),
      row('5', '5.00', null),
      row('6', '6.00', null),
    ]),
  );
  assert.equal(leaderboard(c.id).updates.length, 4);
  const expanded = leaderboard(c.id, { activityLimit: 20, metric: 'money' });
  assert.equal(expanded.selected.key, 'units');
  assert.deepEqual(
    expanded.updates.map((update) => update.operatorNumber),
    ['6', '5', '4', '3', '2', '1'],
  );
  assert.equal(expanded.updates[0].amount, '6.00');
  assert(!JSON.stringify(expanded).includes('Private Revenue'));
  const page = leaderboard(c.id, { activityLimit: 2, activityOffset: 2 });
  assert.deepEqual(
    page.updates.map((update) => update.operatorNumber),
    ['4', '3'],
  );
  assert.equal(page.hasMoreUpdates, true);
  assert.equal(leaderboard(c.id, { activityLimit: 2, activityOffset: 4 }).hasMoreUpdates, false);
  saveReport(
    c.id,
    input(
      '2026-09-03T10:00:00Z',
      Array.from({ length: 25 }, (_, i) => row(String(i + 10), '1.00', null)),
    ),
  );
  assert.equal(leaderboard(c.id, { activityLimit: 1000 }).updates.length, 20);
});

test('CSV exports ranked admin results, exact numbers, missing cells and safe spreadsheet text', () => {
  const c = competition();
  saveReport(
    c.id,
    input('2026-09-01T10:00:00Z', [row('001', '1.25', '-0.69'), row('A1', '2.50', null)]),
  );
  const board = leaderboard(c.id, { audience: 'admin', metric: 'money' });
  board.metrics[0].label = 'Units, "sold"\ncount';
  board.identifierLabel = '=Participant';
  const csv = resultsCsv(board);
  assert(csv.startsWith('\uFEFF"Rank","\'=Participant","Units, ""sold""\ncount"'));
  assert(csv.includes('"Private Revenue (USD)"'));
  assert(csv.includes('Updated (America/Chicago — CST/CDT)'));
  const winterBoard = {
    ...board,
    rows: [{ ...board.rows[0], updated: '2026-01-02T01:00:00.000Z' }],
  };
  assert(resultsCsv(winterBoard).includes('2026-01-01 19:00:00 CST'));
  assert(csv.includes('1,"001",1.25,-0.69,1,8.00,"2026-09-01 05:00:00 CDT"\r\n'));
  assert(csv.includes(',"A1",2.50,,1,8.00,'));
  assert.equal(resultsFilename(board), `Metric-test-${c.id}-lifetime-money-results.csv`);
  board.rows = [];
  assert.equal(resultsCsv(board), csv.slice(0, csv.indexOf('\r\n') + 2));
});

test('independent exact daily baselines, refunds, missing optional cells, additive amounts and latest values', () => {
  const c = competition();
  saveReport(c.id, input('2026-09-01T10:00:00Z', [row('001', '10.10', '5.05', '2', '8.00')]));
  saveReport(c.id, input('2026-09-01T11:00:00Z', [row('001', '12.30', null, '3', '6.00')]));
  saveReport(c.id, input('2026-09-01T12:00:00Z', [row('001', '9.20', '4.60', '-1', '7.00')]));
  saveReport(c.id, input('2026-09-02T10:00:00Z', [row('001', '-1.40', '-0.69', '4', '5.00')]));
  const admin = leaderboard(c.id, { audience: 'admin' });
  assert.deepEqual(admin.rows[0].values, {
    units: '7.80',
    money: '3.91',
    calls: '8',
    time: '5.00',
  });
  assert.equal(admin.rows[0].operatorNumber, '001');
  const values = db.select().from(report_values).all();
  assert(values.every((v) => Number.isSafeInteger(v.value)));
  assert.equal(formatMetric('3.91', metrics[1]), '$3.91');
});
test('public projection excludes private metrics and rejects private sorting by falling back to official', () => {
  const c = competition();
  saveReport(c.id, input('2026-09-01T10:00:00Z', [row('A1', '1.00', '987654.32')]));
  const board = leaderboard(c.id, { metric: 'money' });
  const json = JSON.stringify(board);
  assert.equal(board.selected.key, 'units');
  assert(!json.includes('Private Revenue') && !json.includes('987654') && !json.includes('money'));
  assert.equal(leaderboard(c.id, { audience: 'admin', metric: 'money' }).selected.key, 'money');
});
test('invalid batches, precision, constraints, duplicate participants and overlapping reports save nothing', () => {
  const c = competition();
  const count = () => db.select().from(reports).all().length;
  const before = count();
  for (const rows of [
    [row('1', '1.00', '2.00'), row('2', '1.001', '2.00')],
    [row('1', '1.00', '2.00'), row('1', '2.00', '2.00')],
    [{ participant_id: '1', values: { units: '2.00', calls: '1' } }],
    [row('1', 'Infinity', null)],
    [{ ...row('1', '1.00', null), values: { ...row('1', '1.00', null).values, invented: '1' } }],
  ]) {
    assert.throws(() => saveReport(c.id, input('2026-09-01T10:00:00Z', rows)));
    assert.equal(count(), before);
  }
  assert.throws(
    () =>
      saveReport(c.id, {
        ...input('2026-09-02T10:00:00Z', [row('1', '1.00', null)]),
        period_start: '2026-09-01',
      }),
    /one day/,
  );
  saveReport(c.id, input('2026-09-01T10:00:00Z', [row('1', '1.00', null)]));
  assert.throws(
    () => saveReport(c.id, input('2026-09-01T10:00:00Z', [row('1', '1.00', null)])),
    /newer/,
  );
  assert.equal(count(), before + 1);
});
test('adding metrics and switching official ranking requires acknowledgement, keeps missing values and locks used semantics', () => {
  const c = competition();
  saveReport(c.id, input('2026-09-01T10:00:00Z', [row('1', '3.00', null), row('2', '2.00', null)]));
  let current = getCompetition(c.id);
  const score = { ...newMetric('bonus'), label: 'Bonus', required: false };
  const settings = {
    competition_id: c.id,
    schema_version: current.schema_version,
    metrics: [...current.metrics, score],
    profile: current.profile,
    official_metric_key: 'units',
  };
  assert.throws(() => updateCompetition(settings), /Confirm/);
  current = updateCompetition({ ...settings, confirm_add: true });
  assert.equal(leaderboard(c.id).rows[0].values.bonus, null);
  assert.throws(
    () =>
      saveReport(c.id, input('2026-09-01T11:00:00Z', [row('1', '4.00', null)]), {
        schemaVersion: 1,
      }),
    /settings changed/,
  );
  saveReport(
    c.id,
    input('2026-09-01T11:00:00Z', [
      { participant_id: '2', values: { ...row('2', '2.00', null).values, bonus: '9.00' } },
    ]),
  );
  const change = {
    ...settings,
    metrics: current.metrics,
    schema_version: current.schema_version,
    official_metric_key: 'bonus',
    profile: current.profile,
  };
  assert.throws(() => updateCompetition(change), /Confirm/);
  current = updateCompetition({ ...change, confirm_ranking: true });
  const board = leaderboard(c.id);
  assert.equal(board.rows[0].operatorNumber, '2');
  assert.equal(board.rows[1].rank, null);
  assert.equal(board.rows[0].values.units, '2.00');
  assert.throws(
    () =>
      updateCompetition({
        ...change,
        schema_version: current.schema_version,
        metrics: current.metrics.map((m) => (m.key === 'units' ? { ...m, mode: 'latest' } : m)),
      }),
    /locked/,
  );
  assert.throws(
    () =>
      updateCompetition({
        ...change,
        schema_version: current.schema_version,
        metrics: current.metrics.map((m) => (m.key === 'bonus' ? { ...m, public: false } : m)),
      }),
    /must be public/,
  );
});
test('lower-is-better sorting and ties do not alter official metric', () => {
  const c = competition();
  saveReport(
    c.id,
    input('2026-09-01T10:00:00Z', [
      row('2', '3.00', null, '1', '4.00'),
      row('1', '2.00', null, '1', '4.00'),
      row('3', '1.00', null, '1', '9.00'),
    ]),
  );
  const alternative = leaderboard(c.id, { metric: 'time' });
  assert.deepEqual(
    alternative.rows.map((r) => r.rank),
    [1, 1, 3],
  );
  assert.equal(alternative.rows[0].operatorNumber, '1');
  assert.equal(getCompetition(c.id).official_metric_key, 'units');
  assert.equal(leaderboard(c.id).rows[0].operatorNumber, '2');
});
test('report contract rejects unknown versions/metrics and leaves unreadable values editable', () => {
  const valid = {
    contract_version: 1,
    generated_at: null,
    period_start: null,
    period_end: null,
    rows: [
      { participant_id: '001', values: { units: null, money: '-0.69', calls: '2', time: '1.00' } },
    ],
  };
  const normalized = normalizeMetricReport(valid, metrics);
  assert.equal(normalized.generated_at, '');
  assert.equal(normalized.rows[0].values.units, null);
  assert.equal(normalized.rows[0].values.money, '-0.69');
  assert.throws(() => normalizeMetricReport({ ...valid, contract_version: 2 }, metrics), /version/);
  assert.throws(
    () =>
      normalizeMetricReport(
        { ...valid, rows: [{ participant_id: '001', values: { extra: '5' } }] },
        metrics,
      ),
    /unknown metric/,
  );
});
test('provider discovery and extraction use different contracts and stable mapped keys', async () => {
  const original = globalThis.fetch;
  process.env.VISION_BASE_URL = 'http://localhost:11434/v1';
  process.env.VISION_MODEL = 'mock';
  try {
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                identifier_label: 'Cashier No',
                metrics: [
                  { label: 'Quantity', source_column: 'Qty Sold', type: 'decimal', precision: 2 },
                  {
                    label: 'Revenue',
                    source_column: 'Dollars Sold',
                    type: 'currency',
                    precision: 2,
                    currency: 'USD',
                  },
                ],
              }),
            },
          },
        ],
      });
    const discovered = await discoverReport(Buffer.from('image'), 'image/png');
    assert.equal(discovered.metrics[0].key, 'metric_1');
    assert.equal(discovered.profile.columns.metric_1, 'Qty Sold');
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      assert.equal(request.model, 'mock');
      assert.equal(request.messages[1].content[1].image_url.url, 'data:image/png;base64,aW1hZ2U=');
      assert.match(request.messages[1].content[0].text, /Qty Sold/);
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                contract_version: 1,
                generated_at: '2026-09-01T10:00',
                period_start: '2026-09-01',
                period_end: '2026-09-01',
                rows: [{ participant_id: '001', values: { metric_1: '-1.40', metric_2: '-0.69' } }],
              }),
            },
          },
        ],
      });
    };
    const report = await extractMetricReport(Buffer.from('image'), 'image/png', {
      ...discovered,
      timezone: 'America/Chicago',
    });
    assert.equal(report.rows[0].values.metric_2, '-0.69');
  } finally {
    globalThis.fetch = original;
  }
});
test('generic timezone resolution honors offsets and rejects DST gaps/ambiguity', () => {
  assert.equal(
    resolveReportTime('2026-01-15T10:00', 'America/New_York'),
    '2026-01-15T15:00:00.000Z',
  );
  assert.equal(resolveReportTime('2026-01-15T10:00', 'Asia/Kathmandu'), '2026-01-15T04:15:00.000Z');
  assert.throws(() => resolveReportTime('2026-03-08T02:30', 'America/New_York'), /does not exist/);
  assert.throws(() => resolveReportTime('2026-11-01T01:30', 'America/New_York'), /occurs twice/);
  assert.equal(
    resolveReportTime('2026-11-01T01:30-05:00', 'America/New_York'),
    '2026-11-01T06:30:00.000Z',
  );
});
test('concurrent duplicate report submissions commit one complete batch', async () => {
  const c = competition(),
    report = input('2026-09-01T10:00:00Z', [row('1', '3.00', '1.50'), row('2', '2.00', '1.00')]);
  const url = new URL('../src/lib/competition-store.ts', import.meta.url).href;
  const results = await Promise.all(
    Array.from(
      { length: 2 },
      () =>
        new Promise<boolean>((resolve, reject) => {
          const worker = new Worker(
            `import { parentPort } from 'node:worker_threads'; import { saveReport } from ${JSON.stringify(url)}; try {saveReport(${c.id},${JSON.stringify(report)}); parentPort.postMessage(true)} catch {parentPort.postMessage(false)}`,
            { eval: true },
          );
          worker.on('message', resolve);
          worker.on('error', reject);
        }),
    ),
  );
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(leaderboard(c.id, { audience: 'admin' }).total, '5.00');
});
test('draft commit is atomic and a consumed token cannot write another report', () => {
  const c = competition();
  const report = input('2026-09-01T10:00:00Z', [row('1', '3.00', '1.50')]);
  db.insert(report_drafts)
    .values({
      token: 'draft',
      competition_id: c.id,
      schema_version: 1,
      profile_version: 1,
      payload: JSON.stringify(report),
      proof_image_path: 'example.png',
      created_at: Date.now(),
      expires_at: Date.now() + 86400000,
    })
    .run();
  saveReport(c.id, report, { draftToken: 'draft', draftRevision: 1, schemaVersion: 1 });
  assert.throws(
    () =>
      saveReport(c.id, input('2026-09-01T11:00:00Z', [row('1', '9.00', '4.50')]), {
        draftToken: 'draft',
        draftRevision: 1,
        schemaVersion: 1,
      }),
    /already been saved/,
  );
  assert.equal(leaderboard(c.id).total, '3.00');
});

test('competition creation requires explicit metrics instead of the old single-metric input', () => {
  assert.throws(
    () =>
      addCompetition({
        name: 'Old input',
        metric_label: 'Sales',
        start_date: '2026-09-01',
        end_date: '2026-09-30',
      }),
    /metric/i,
  );
});

test('metric extraction rejects malformed provider responses and HTTP errors', async () => {
  const original = globalThis.fetch;
  process.env.VISION_BASE_URL = 'http://localhost:11434/v1';
  process.env.VISION_MODEL = 'mock';
  const configuration = {
    metrics,
    profile: {
      identifier_label: 'Operator',
      identifier_aliases: '',
      date_instructions: '',
      columns: {},
    },
    timezone: 'America/Chicago',
  };
  try {
    for (const content of [
      'not json',
      JSON.stringify({ contract_version: 1, rows: null }),
      JSON.stringify({ contract_version: 2, rows: [] }),
    ]) {
      globalThis.fetch = async () =>
        Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
      await assert.rejects(() =>
        extractMetricReport(Buffer.from('image'), 'image/png', configuration),
      );
    }
    globalThis.fetch = async () => Response.json({ error: 'Bad key' }, { status: 401 });
    await assert.rejects(
      () => extractMetricReport(Buffer.from('image'), 'image/png', configuration),
      /HTTP 401/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
