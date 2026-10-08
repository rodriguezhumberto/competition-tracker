import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'rally-items-'));
process.env.DATABASE_PATH = join(temp, 'test.db');
const { sqlite, db } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const { addCompetition, getCompetition, updateCompetition } =
  await import('../src/lib/competition-config.ts');
const { saveReport } = await import('../src/lib/report-store.ts');
const { createDraft, draftView, addDraftItem } = await import('../src/lib/draft-store.ts');
const { entries, report_values } = await import('../src/db/schema.ts');
const { newMetric } = await import('../src/lib/metrics.ts');
const { normalizeMetricReport } = await import('../src/lib/vision.ts');
after(() => {
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
function competition(multiple_items = true) {
  return addCompetition({
    name: 'Items',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    metrics: [{ ...newMetric('units'), label: 'Units' }],
    multiple_items,
    items: [
      { code: '0001', name: 'Apples' },
      { code: '0002', name: 'Pears' },
    ],
  });
}
function report(code: string, value: string, hour = '10', day = '01') {
  return {
    item_code: code,
    generated_at: `2026-09-${day}T${hour}:00:00Z`,
    period_start: `2026-09-${day}`,
    period_end: `2026-09-${day}`,
    rows: [{ participant_id: '001', values: { units: value } }],
  };
}
function settings(id: number) {
  const c = getCompetition(id);
  return {
    competition_id: id,
    schema_version: c.schema_version,
    metrics: c.metrics,
    profile: c.profile,
    official_metric_key: c.official_metric_key,
    multiple_items: c.multiple_items,
    items: c.items,
  };
}

test('daily baselines, duplicate checks and refunds are independent per item', () => {
  const c = competition();
  saveReport(c.id, report('0001', '10.00'));
  saveReport(c.id, report('0002', '6.00'));
  saveReport(c.id, report('0001', '8.00', '11'));
  saveReport(c.id, report('0002', '7.00', '11'));
  saveReport(c.id, report('0001', '-1.00', '10', '02'));
  assert.deepEqual(
    db
      .select({ value: report_values.contribution })
      .from(report_values)
      .all()
      .map((v) => v.value),
    [1000, 600, -200, 100, -100],
  );
  assert.deepEqual(
    db
      .select({ code: entries.item_code })
      .from(entries)
      .orderBy(entries.id)
      .all()
      .map((v) => v.code),
    ['0001', '0002', '0001', '0002', '0001'],
  );
  assert.throws(() => saveReport(c.id, report('0002', '99.00', '11')), /newer/);
  assert.throws(() => saveReport(c.id, report('0002', '99.00', '09')), /newer/);
});

test('configured codes retain zeroes and unknown codes cannot become scores', () => {
  const c = competition();
  for (const code of ['', '1', 'unknown'])
    assert.throws(() => saveReport(c.id, report(code, '1.00')), /code|configured/i);
  assert.throws(() => competitionWithDuplicate(), /unique/);
  function competitionWithDuplicate() {
    return addCompetition({
      ...settings(c.id),
      name: 'Bad',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      items: [
        { code: '1', name: 'A' },
        { code: '1', name: 'B' },
      ],
    });
  }
  const single = competition(false);
  const saved = saveReport(single.id, report('unconfigured', '1.00'));
  assert.equal(saved[0].item_code, '');
});

test('saved reports lock tracking mode and used codes while new items and friendly names remain editable', () => {
  const c = competition();
  saveReport(c.id, report('0001', '1.00'));
  assert.throws(() => updateCompetition({ ...settings(c.id), multiple_items: false }), /locked/);
  assert.throws(
    () => updateCompetition({ ...settings(c.id), items: [{ code: '0002', name: 'Pears' }] }),
    /removed or changed/,
  );
  const updated = updateCompetition({
    ...settings(c.id),
    items: [
      { code: '0001', name: 'Red apples' },
      { code: '0003', name: 'Plums' },
    ],
  });
  assert.equal(updated.items[0].name, 'Red apples');
  saveReport(c.id, report('0003', '2.00'));
});

test('adding an item during review preserves edited values and original extraction atomically', () => {
  const c = getCompetition(competition().id);
  const draft = createDraft(c, report('unknown', '1.00'), 'proof.png');
  const other = createDraft(c, report('0001', '2.00'), 'other.png');
  const edited = report('unknown', '3.00');
  const view = addDraftItem(draft.token, 1, { code: '0003', name: 'Plums' }, edited);
  assert.equal(view.report.item_code, '0003');
  assert.equal(view.report.rows[0].values.units, '3.00');
  assert.equal(view.originalReport.item_code, 'unknown');
  assert.equal(view.revision, 2);
  assert.equal(view.schemaChanged, false);
  assert.equal(draftView(other.token).schemaChanged, true);
  assert.throws(() => addDraftItem(draft.token, 1, { code: '0004', name: 'Stale' }), /another tab/);
  assert.equal(getCompetition(c.id).items.length, 3);
  saveReport(c.id, view.report, { draftToken: draft.token, draftRevision: 2 });
});

test('extraction retains item codes only in enabled mode and leaves missing headers editable', () => {
  const c = getCompetition(competition().id);
  const raw = { contract_version: 1, ...report('0001', '1.00') };
  assert.equal(normalizeMetricReport(raw, c.metrics, true).item_code, '0001');
  assert.equal(normalizeMetricReport({ ...raw, item_code: null }, c.metrics, true).item_code, '');
  assert.equal(normalizeMetricReport(raw, c.metrics).item_code, undefined);
});
