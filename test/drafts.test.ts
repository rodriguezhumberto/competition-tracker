import { Worker } from 'node:worker_threads';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'rally-drafts-'));
process.env.DATABASE_PATH = join(temp, 'test.db');
process.env.UPLOAD_DIR = join(temp, 'proofs');
mkdirSync(process.env.UPLOAD_DIR);
const { sqlite } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const { addCompetition, saveReport, getCompetition } =
  await import('../src/lib/competition-store.ts');
const { newMetric } = await import('../src/lib/metrics.ts');
const {
  createDraft,
  draftView,
  saveDraftEdits,
  discardDraft,
  listPendingDrafts,
  DRAFT_LIFETIME_MS,
} = await import('../src/lib/draft-store.ts');
const { cleanupDrafts } = await import('../src/lib/draft-cleanup.ts');
const { reportImageArtifacts } = await import('../src/lib/report-image.ts');
after(() => {
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
function fixture(now = Date.now()) {
  const c = addCompetition({
    name: 'Draft test',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    metrics: [{ ...newMetric('units'), label: 'Units' }],
    official_metric_key: 'units',
  });
  const report = {
    generated_at: '2026-09-01T12:00:00Z',
    period_start: '2026-09-01',
    period_end: '2026-09-01',
    rows: [{ participant_id: '119', values: { units: '12' } }],
  };
  const name = `proof-${c.id}.png`;
  const artifacts = reportImageArtifacts(name);
  const paths = [name, artifacts.processed, artifacts.metadata].map((name) =>
    join(process.env.UPLOAD_DIR!, name),
  );
  paths.forEach((path) => writeFileSync(path, 'fixture'));
  return { c, report, paths, draft: createDraft(getCompetition(c.id), report, name, { now }) };
}
const commit = (f: ReturnType<typeof fixture>, revision = f.draft.revision, report = f.report) =>
  saveReport(f.c.id, report, { draftToken: f.draft.token, draftRevision: revision });

test('saved edits reopen, preserve original extraction and fixed expiry, and reject stale revisions', () => {
  const f = fixture();
  const edited = structuredClone(f.report);
  edited.rows[0].values.units = '9';
  const saved = saveDraftEdits(f.draft.token, 1, edited);
  assert.equal(saved.revision, 2);
  assert.equal(saved.expiresAt, f.draft.created_at + DRAFT_LIFETIME_MS);
  assert.equal(draftView(f.draft.token).report.rows[0].values.units, '9');
  assert.equal(saved.originalReport.rows[0].values.units, '12');
  assert(listPendingDrafts().some((draft) => draft.token === f.draft.token));
  assert.throws(() => saveDraftEdits(f.draft.token, 1, f.report), /another tab/);
  assert.throws(() => discardDraft(f.draft.token, 1), /another tab/);
  assert.throws(() => commit(f), /another tab/);
  assert.equal(
    sqlite
      .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM reports WHERE competition_id=?')
      .get(f.c.id)!.n,
    0,
  );
  commit(f, 2, edited);
  assert.throws(() => draftView(f.draft.token), /expired/);
  assert.throws(() => commit(f, 2), /expired/);
});

test('incomplete edits can be recovered but confirmation validates everything atomically', () => {
  const f = fixture();
  const incomplete = structuredClone(f.report);
  incomplete.rows[0].values.units = '';
  saveDraftEdits(f.draft.token, 1, incomplete);
  assert.throws(() => commit(f, 2, incomplete));
  assert.equal(draftView(f.draft.token).revision, 2);
  assert.equal(
    sqlite
      .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM entries WHERE competition_id=?')
      .get(f.c.id)!.n,
    0,
  );
  sqlite.prepare('UPDATE competitions SET schema_version=schema_version+1 WHERE id=?').run(f.c.id);
  assert.equal(draftView(f.draft.token).schemaChanged, true);
  assert.throws(() => saveDraftEdits(f.draft.token, 2, f.report), /settings changed/);
  assert.throws(() => commit(f, 2), /settings changed/);
  discardDraft(f.draft.token, 2);
});

test('discard invalidates immediately; deletion failures stay queued and retry missing files safely', async () => {
  const f = fixture();
  discardDraft(f.draft.token, 1);
  assert.throws(() => draftView(f.draft.token), /discarded/);
  assert.throws(() => commit(f), /discarded/);
  let failures = 0;
  await cleanupDrafts({
    remove: async (path) => {
      if (path === f.paths[1]) throw Object.assign(new Error('Locked file'), { code: 'EACCES' });
      return unlink(path);
    },
    onError: () => failures++,
  });
  assert.equal(failures, 1);
  const queued = sqlite
    .prepare<[string], { cleanup_attempts: number; cleanup_error: string }>(
      'SELECT * FROM report_drafts WHERE token=?',
    )
    .get(f.draft.token)!;
  assert.equal(queued.cleanup_attempts, 1);
  assert.equal(queued.cleanup_error, 'Locked file');
  assert.equal(existsSync(f.paths[0]), false);
  assert.equal(existsSync(f.paths[1]), true);
  await cleanupDrafts();
  assert.equal(
    sqlite.prepare('SELECT token FROM report_drafts WHERE token=?').get(f.draft.token),
    undefined,
  );
  assert(f.paths.every((path) => !existsSync(path)));
});

test('expiry wins before filesystem deletion, while confirmed proofs survive all cleanup', async () => {
  const confirmed = fixture();
  commit(confirmed);
  const expired = fixture(Date.now() - DRAFT_LIFETIME_MS - 1);
  assert.throws(() => commit(expired), /expired/);
  let attempted = false;
  await cleanupDrafts({
    remove: async (path) => {
      if (path === expired.paths[0]) {
        attempted = true;
        assert.equal(
          sqlite
            .prepare<[string], { status: string }>('SELECT status FROM report_drafts WHERE token=?')
            .get(expired.draft.token)!.status,
          'expired',
        );
        assert.throws(() => commit(expired), /expired/);
        assert.throws(() => saveDraftEdits(expired.draft.token, 1, expired.report), /expired/);
      }
      return unlink(path);
    },
  });
  assert(attempted);
  assert(confirmed.paths.every(existsSync));
  assert(expired.paths.every((path) => !existsSync(path)));
  assert.equal(
    sqlite
      .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM reports WHERE competition_id=?')
      .get(expired.c.id)!.n,
    0,
  );
});

test('concurrent confirmation and discard commit exactly one state transition', async () => {
  const f = fixture();
  const store = new URL('../src/lib/report-store.ts', import.meta.url).href;
  const drafts = new URL('../src/lib/draft-store.ts', import.meta.url).href;
  const results = await Promise.all(
    ['confirm', 'discard'].map(
      (action) =>
        new Promise<boolean>((resolve, reject) => {
          const worker = new Worker(
            `import { parentPort } from 'node:worker_threads'; import { saveReport } from ${JSON.stringify(store)}; import { discardDraft } from ${JSON.stringify(drafts)}; parentPort.once('message', () => { try { ${action === 'confirm' ? `saveReport(${f.c.id}, ${JSON.stringify(f.report)}, {draftToken: ${JSON.stringify(f.draft.token)}, draftRevision: 1})` : `discardDraft(${JSON.stringify(f.draft.token)}, 1)`}; parentPort.postMessage(true); } catch { parentPort.postMessage(false); } }); parentPort.postMessage('ready');`,
            { eval: true },
          );
          worker.on('message', (result) => {
            if (result === 'ready') worker.postMessage('go');
            else resolve(result);
          });
          worker.on('error', reject);
        }),
    ),
  );
  assert.deepEqual([...results].sort(), [false, true]);
  const confirmed = results[0];
  assert.equal(
    sqlite
      .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM reports WHERE competition_id=?')
      .get(f.c.id)!.n,
    confirmed ? 1 : 0,
  );
  await cleanupDrafts();
  assert.equal(f.paths.every(existsSync), confirmed);
  assert.throws(() => draftView(f.draft.token), /expired/);
});
