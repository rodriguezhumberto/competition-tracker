import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AstroCookies } from 'astro';
const temp = mkdtempSync(join(tmpdir(), 'rally-retention-'));
process.env.DATABASE_PATH = join(temp, 'test.db');
process.env.UPLOAD_DIR = join(temp, 'proofs');
process.env.ADMIN_PASSCODE = 'retention-tests-private-admin-passcode';
mkdirSync(process.env.UPLOAD_DIR);
const { sqlite } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const { cleanupRetainedData, competitionEndsAt } = await import('../src/lib/retention.ts');
const { newSession } = await import('../src/lib/auth.ts');
const { GET: getProof } = await import('../src/pages/api/proof.ts');
const DAY = 86_400_000;
const end = competitionEndsAt('2026-09-30', 'America/Chicago');
beforeEach(() => {
  for (const table of [
    'report_values',
    'entries',
    'reports',
    'report_drafts',
    'competition_metrics',
    'power_hour_scores',
    'power_hour_participants',
    'power_hour_sessions',
    'users',
    'competitions',
  ]) {
    sqlite.prepare(`DELETE FROM ${table}`).run();
  }
});
after(() => {
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
function competition(id = 1, endDate = '2026-09-30') {
  sqlite
    .prepare(
      `INSERT INTO competitions (id,name,metric_label,start_date,end_date,is_active,official_metric_key)
    VALUES (?, 'Test', 'Points', '2026-01-01', ?, ?, 'units')`,
    )
    .run(id, endDate, id === 1 ? 1 : 0);
}
function report(c = 1, filename = 'proof.png') {
  const reportId = Number(
    sqlite
      .prepare(
        `INSERT INTO reports
    (competition_id,timestamp,period_start,period_end,schema_version,profile_version,proof_image_path)
    VALUES (?, '2026-09-30T12:00:00Z', '2026-09-30', '2026-09-30', 1, 1, ?)`,
      )
      .run(c, filename).lastInsertRowid,
  );
  const entryId = Number(
    sqlite
      .prepare(
        `INSERT INTO entries
    (competition_id,report_id,operator_number,timestamp_on_report,report_date,proof_image_path)
    VALUES (?, ?, '007', '2026-09-30T12:00:00Z', '2026-09-30', ?)`,
      )
      .run(c, reportId, filename).lastInsertRowid,
  );
  const metricId = Number(
    sqlite
      .prepare(
        `INSERT INTO competition_metrics
    (competition_id,key,label,type,precision,mode) VALUES (?, 'units', 'Units', 'integer', 0, 'daily')`,
      )
      .run(c).lastInsertRowid,
  );
  sqlite
    .prepare(
      'INSERT INTO report_values (entry_id,metric_id,value,contribution) VALUES (?, ?, 5, 5)',
    )
    .run(entryId, metricId);
  const paths = [filename, `${filename}.processed.png`, `${filename}.processing.json`].map((f) =>
    join(process.env.UPLOAD_DIR!, f),
  );
  paths.forEach((p) => writeFileSync(p, 'personal image data'));
  return paths;
}
function count(table: string) {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function proofRequest(token: string, query: string) {
  const cookies = {
    get: (name: string) => (name === 'admin' ? { value: token } : undefined),
  } as unknown as AstroCookies;
  return getProof({
    cookies,
    url: new URL(`https://competition.example.com/api/proof?${query}`),
  } as Parameters<typeof getProof>[0]);
}
function session(id: number, user: number, endsAt: string, c: number | null = null) {
  sqlite
    .prepare(
      `INSERT INTO power_hour_sessions (id,name,status,created_at,ends_at,competition_id)
    VALUES (?, 'Session', 'archived', '2026-10-01T04:00:00Z', ?, ?)`,
    )
    .run(id, endsAt, c);
  sqlite.prepare('INSERT OR IGNORE INTO users (id,name) VALUES (?, ?)').run(user, `Person ${user}`);
  sqlite
    .prepare(
      `INSERT INTO power_hour_participants (session_id,user_id,name_key,credential_hash)
    VALUES (?, ?, ?, ?)`,
    )
    .run(id, user, `person-${user}`, `credential-${id}`);
  sqlite
    .prepare('INSERT INTO power_hour_scores (session_id,user_id,clicks) VALUES (?, ?, 8)')
    .run(id, user);
}

test('competition end includes the last local day and handles daylight saving offsets', () => {
  assert.equal(new Date(end).toISOString(), '2026-10-01T05:00:00.000Z');
  assert.equal(
    new Date(competitionEndsAt('2026-11-01', 'America/Chicago')).toISOString(),
    '2026-11-02T06:00:00.000Z',
  );
});
test('15-day boundary removes original, processed image and metadata while keeping results', async () => {
  competition();
  const paths = report();
  await cleanupRetainedData({ now: end + 15 * DAY - 1 });
  assert(paths.every(existsSync));
  await cleanupRetainedData({ now: end + 15 * DAY });
  assert(paths.every((p) => !existsSync(p)));
  assert.equal(count('entries'), 1);
  assert.equal(count('report_values'), 1);
  assert.equal(
    (sqlite.prepare('SELECT proof_image_path FROM reports').get() as any).proof_image_path,
    null,
  );
  assert.equal(
    (sqlite.prepare('SELECT proof_image_path FROM entries').get() as any).proof_image_path,
    null,
  );
  assert.equal(count('report_drafts'), 0);
});
test('saved proof access expires at the exact deadline before cleanup runs', async (t) => {
  competition();
  const paths = report();
  const entry = sqlite.prepare('SELECT id FROM entries').get() as { id: number };
  let now = end + 15 * DAY - 1;
  t.mock.method(Date, 'now', () => now);
  const token = newSession();
  for (const variant of ['', '&variant=processed'])
    assert.equal((await proofRequest(token, `id=${entry.id}${variant}`)).status, 200);
  now++;
  for (const variant of ['', '&variant=processed'])
    assert.equal((await proofRequest(token, `id=${entry.id}${variant}`)).status, 404);
  assert(paths.every(existsSync));
  assert.equal(count('entries'), 1);
  // A failed deletion must not restore access through either image variant.
  await cleanupRetainedData({
    now,
    remove: async () => {
      throw new Error('File locked');
    },
    onError: () => {},
  });
  assert(paths.every(existsSync));
  for (const variant of ['', '&variant=processed'])
    assert.equal((await proofRequest(token, `id=${entry.id}${variant}`)).status, 404);
});
test('proof expiry applies to its competition even when another still uses the image', async (t) => {
  competition();
  competition(2, '2026-12-31');
  const paths = report();
  report(2);
  const rows = sqlite.prepare('SELECT id FROM entries ORDER BY competition_id').all() as {
    id: number;
  }[];
  t.mock.method(Date, 'now', () => end + 15 * DAY);
  const token = newSession();
  assert.equal((await proofRequest(token, `id=${rows[0].id}`)).status, 404);
  assert.equal((await proofRequest(token, `id=${rows[1].id}`)).status, 200);
  assert(paths.every(existsSync));
});
test('draft proofs expire at their own deadline or the competition data deadline', async (t) => {
  competition();
  writeFileSync(join(process.env.UPLOAD_DIR!, 'draft.png'), 'draft image');
  writeFileSync(join(process.env.UPLOAD_DIR!, 'draft.png.processed.png'), 'processed draft image');
  const insert = sqlite.prepare(`INSERT INTO report_drafts
    (token,competition_id,schema_version,profile_version,payload,proof_image_path,created_at,expires_at)
    VALUES (?, 1, 1, 1, '{}', 'draft.png', ?, ?)`);
  let now = end + 30 * DAY - 1;
  insert.run('draft-expiring', now - DAY + 1, now + 1);
  insert.run('draft-later', now, now + DAY);
  insert.run('draft-already-expired', now - DAY, now);
  t.mock.method(Date, 'now', () => now);
  const token = newSession();
  for (const variant of ['', '&variant=processed'])
    assert.equal((await proofRequest(token, `draft=draft-already-expired${variant}`)).status, 404);
  for (const draft of ['draft-expiring', 'draft-later'])
    for (const variant of ['', '&variant=processed'])
      assert.equal((await proofRequest(token, `draft=${draft}${variant}`)).status, 200);
  now++;
  for (const draft of ['draft-expiring', 'draft-later'])
    for (const variant of ['', '&variant=processed'])
      assert.equal((await proofRequest(token, `draft=${draft}${variant}`)).status, 404);
  assert(existsSync(join(process.env.UPLOAD_DIR!, 'draft.png')));
  assert.equal(count('report_drafts'), 3);
});
test('30-day boundary deletes identifiable reports and values even with a stale active flag', async () => {
  competition();
  report();
  await cleanupRetainedData({ now: end + 30 * DAY - 1 });
  assert.equal(count('entries'), 1);
  await cleanupRetainedData({ now: end + 30 * DAY });
  for (const table of ['entries', 'reports', 'report_values', 'report_drafts'])
    assert.equal(count(table), 0);
  assert.equal(count('competitions'), 1);
  await cleanupRetainedData({ now: end + 31 * DAY });
  assert.equal(count('entries'), 0);
});
test('failed image deletion stays queued after result deletion and retries safely', async () => {
  competition();
  const paths = report();
  const failures: unknown[] = [];
  await cleanupRetainedData({
    now: end + 30 * DAY,
    remove: async () => {
      throw new Error('File locked');
    },
    onError: (e) => failures.push(e),
  });
  assert.equal(count('entries'), 0);
  assert.equal(count('reports'), 0);
  assert.equal(count('report_drafts'), 1);
  const queue = sqlite
    .prepare('SELECT payload, original_payload, cleanup_attempts FROM report_drafts')
    .get() as any;
  assert.equal(queue.payload, '{}');
  assert.equal(queue.original_payload, null);
  assert.equal(queue.cleanup_attempts, 1);
  assert.equal(failures.length, 1);
  await cleanupRetainedData({ now: end + 31 * DAY });
  assert.equal(count('report_drafts'), 0);
  assert(paths.every((p) => !existsSync(p)));
});
test('an image shared with an unexpired competition is preserved until its last reference expires', async () => {
  competition();
  competition(2, '2026-12-31');
  const paths = report();
  report(2);
  await cleanupRetainedData({ now: end + 30 * DAY });
  assert(paths.every(existsSync));
  assert.equal(count('entries'), 1);
  assert.equal(
    (sqlite.prepare('SELECT operator_number FROM entries').get() as any).operator_number,
    '007',
  );
  await cleanupRetainedData({ now: competitionEndsAt('2026-12-31', 'America/Chicago') + 15 * DAY });
  assert(paths.every((p) => !existsSync(p)));
});
test('Power Hour cleanup removes credentials and orphan names but preserves a participant in a newer session', async () => {
  competition();
  competition(2, '2026-12-31');
  session(1, 1, '2026-10-01T05:00:00Z');
  session(2, 1, '2026-11-01T05:00:00Z');
  session(3, 2, '2026-10-01T05:00:00Z');
  session(4, 3, '2026-10-01T05:00:00Z', 2);
  await cleanupRetainedData({ now: end + 30 * DAY - 1 });
  assert.equal(count('power_hour_sessions'), 4);
  await cleanupRetainedData({ now: end + 30 * DAY });
  assert.equal(count('power_hour_sessions'), 2);
  assert.equal(count('power_hour_scores'), 2);
  assert.equal(count('power_hour_participants'), 2);
  assert.equal(count('users'), 2);
  assert.equal(
    (sqlite.prepare('SELECT name FROM users WHERE id = 1').get() as any).name,
    'Person 1',
  );
  assert.equal(sqlite.prepare('SELECT * FROM users WHERE id = 2').get(), undefined);
});
test('expired draft payloads are scrubbed even when their image cannot be removed', async () => {
  competition();
  sqlite
    .prepare(
      `INSERT INTO report_drafts (token,competition_id,schema_version,profile_version,payload,original_payload,proof_image_path,created_at,expires_at)
    VALUES ('draft', 1, 1, 1, '{"name":"Person"}', '{"name":"Person"}', 'draft.png', ?, ?)`,
    )
    .run(end + 29 * DAY, end + 31 * DAY);
  await cleanupRetainedData({
    now: end + 30 * DAY,
    remove: async () => {
      throw new Error('Locked');
    },
    onError: () => {},
  });
  const draft = sqlite.prepare('SELECT * FROM report_drafts').get() as any;
  assert.equal(draft.status, 'discarded');
  assert.equal(draft.payload, '{}');
  assert.equal(draft.original_payload, null);
});
