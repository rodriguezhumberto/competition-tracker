import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'rally-items-board-'));
process.env.DATABASE_PATH = join(temp, 'test.db');
const { sqlite } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const { addCompetition } = await import('../src/lib/competition-config.ts');
const { leaderboard, itemFilterErrorResponse, UnknownTrackedItemError } =
  await import('../src/lib/leaderboard.ts');
const { saveReport } = await import('../src/lib/report-store.ts');
const { newMetric } = await import('../src/lib/metrics.ts');
const { resultsCsv, resultsFilename } = await import('../src/lib/results-csv.ts');
after(() => {
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

function competition(mode: 'daily' | 'additive' | 'latest') {
  return addCompetition({
    name: `Items ${mode}`,
    start_date: '2020-01-01',
    end_date: '2099-12-31',
    multiple_items: true,
    item_label: 'Product',
    items: [
      { code: '0001', name: 'First product' },
      { code: '0002', name: 'Second product' },
      { code: '0003', name: 'Unreported product' },
    ],
    metrics: [{ ...newMetric('sales'), label: 'Sales', mode }],
  });
}
function report(id: number, code: string, time: string, values: Record<string, string>) {
  saveReport(id, {
    item_code: code,
    generated_at: `2020-01-02T${time}:00Z`,
    period_start: '2020-01-02',
    period_end: '2020-01-02',
    rows: Object.entries(values).map(([participant_id, sales]) => ({
      participant_id,
      values: { sales },
    })),
  });
}

test('daily and additive boards combine item streams and independently filter ranks, activity and exports', () => {
  for (const mode of ['daily', 'additive'] as const) {
    const c = competition(mode);
    report(c.id, '0001', '12:00', { A: '10', B: '5' });
    report(c.id, '0002', '12:00', { A: '6', B: '20' });
    report(c.id, '0001', '13:00', { A: '12', B: '7' });
    const all = leaderboard(c.id, { activityLimit: 20 });
    assert.equal(all.selectedItem, null);
    assert.equal(all.rows[0].operatorNumber, 'B');
    assert.equal(
      all.rows.find((row) => row.operatorNumber === 'A')?.values.sales,
      mode === 'daily' ? '18.00' : '28.00',
    );
    assert.equal(all.items[0].updated, '2020-01-02T13:00:00.000Z');
    assert.equal(all.items[1].updated, '2020-01-02T12:00:00.000Z');
    assert.equal(all.items[2].updated, null);
    const first = leaderboard(c.id, { item: '0001', activityLimit: 20 });
    assert.equal(first.rows[0].operatorNumber, 'A');
    assert.equal(first.selectedItem, '0001');
    assert.ok(
      first.updates.every(
        (update) => update.itemCode === '0001' && update.itemName === 'First product',
      ),
    );
    assert.match(resultsCsv(first), /"Product"/);
    assert.match(resultsCsv(first), /"First product"/);
    assert.match(resultsFilename(first), /0001/);
    assert.equal(leaderboard(c.id).rows[0].operatorNumber, 'B');
    assert.throws(() => leaderboard(c.id, { item: 'unknown' }), /Unknown tracked item/);
    assert.equal(leaderboard(c.id, { item: '0003' }).rows.length, 0);
  }
});

test('latest boards retain each item’s latest value and sum across items per participant', () => {
  const c = competition('latest');
  report(c.id, '0001', '12:00', { A: '10', B: '5' });
  report(c.id, '0002', '12:00', { A: '6', B: '20' });
  report(c.id, '0001', '13:00', { A: '12', B: '7' });
  const all = leaderboard(c.id);
  assert.deepEqual(
    all.rows.map((row) => [row.operatorNumber, row.values.sales]),
    [
      ['B', '27.00'],
      ['A', '18.00'],
    ],
  );
  assert.equal(all.total, '45.00');
  assert.equal(leaderboard(c.id, { item: '0001' }).total, '19.00');
  assert.equal(leaderboard(c.id, { period: 'day' }).rows.length, 0);
});

test('single-item competitions preserve their board behavior', () => {
  const c = addCompetition({
    name: 'Single',
    start_date: '2020-01-01',
    end_date: '2099-12-31',
    metrics: [{ ...newMetric('sales'), label: 'Sales' }],
  });
  report(c.id, '', '12:00', { A: '10' });
  const board = leaderboard(c.id);
  assert.equal(board.multipleItems, false);
  assert.deepEqual(board.items, []);
  assert.equal(board.total, '10.00');
  assert.doesNotMatch(resultsCsv(board), /"Item"/);
  assert.throws(() => leaderboard(c.id, { item: '0001' }), /Unknown tracked item/);
});

test('invalid item response offers an escaped link to combined standings and preserves other filters', async () => {
  const response = itemFilterErrorResponse(
    new UnknownTrackedItemError('Unknown tracked item'),
    new URL('https://example.com/?item=unknown&metric=sales&period=week&page=2'),
  )!;
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /href="\/\?metric=sales&amp;period=week"/);
  assert.match(body, /All items/);
  assert.equal(
    itemFilterErrorResponse(new Error('Other failure'), new URL('https://example.com')),
    null,
  );
});
