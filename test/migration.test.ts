import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateDatabase } from '../src/db/migrate.ts';

test('the baseline initializes a fresh database and is repeatable without changing data', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    assert.deepEqual(migrateDatabase(db), [
      '0000_initial_schema',
      '0001_admin_sessions',
      '0002_tracked_items',
      '0003_power_hour_reports',
      '0004_power_hour_plu_timestamps',
    ]);
    assert.deepEqual(db.prepare('SELECT id,enabled,password_hash FROM site_privacy').all(), [
      { id: 1, enabled: 0, password_hash: null },
    ]);
    db.prepare("INSERT INTO users (name) VALUES ('Alex')").run();
    assert.deepEqual(migrateDatabase(db), []);
    assert.deepEqual(db.prepare('SELECT * FROM users').all(), [{ id: 1, name: 'Alex' }]);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(
      (db.prepare('SELECT count(*) AS n FROM rally_migrations').get() as { n: number }).n,
      5,
    );
    const columns = db.prepare('PRAGMA table_info(entries)').all() as {
      name: string;
      notnull: number;
    }[];
    assert(!columns.some(({ name }) => ['basis', 'total', 'delta'].includes(name)));
    assert.equal(columns.find(({ name }) => name === 'report_id')?.notnull, 1);
  } finally {
    db.close();
  }
});

test('unmanaged databases are rejected without changing their data or creating a ledger', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec("CREATE TABLE competitions (name TEXT); INSERT INTO competitions VALUES ('Old data')");
    const before = db.prepare('SELECT sql FROM sqlite_master').all();
    assert.throws(() => migrateDatabase(db), /Start with a fresh database/);
    assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master').all(), before);
    assert.deepEqual(db.prepare('SELECT name FROM competitions').all(), [{ name: 'Old data' }]);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    db.close();
  }
});

test('migration history rejects changed checksums and unsupported versions', () => {
  const db = new Database(':memory:');
  try {
    migrateDatabase(db);
    const { hash } = db.prepare('SELECT hash FROM rally_migrations').get() as { hash: string };
    db.prepare("UPDATE rally_migrations SET hash='changed' WHERE tag='0000_initial_schema'").run();
    assert.throws(() => migrateDatabase(db), /has changed/);
    db.prepare("UPDATE rally_migrations SET hash=? WHERE tag='0000_initial_schema'").run(hash);
    db.prepare("INSERT INTO rally_migrations VALUES ('9999_future','hash','now')").run();
    assert.throws(() => migrateDatabase(db), /unsupported migration history/);
    assert.equal(
      (db.prepare('SELECT count(*) AS n FROM rally_migrations').get() as { n: number }).n,
      6,
    );
  } finally {
    db.close();
  }
});

test('schema and foreign key checks reject drift and restore the foreign key setting', () => {
  const db = new Database(':memory:');
  try {
    migrateDatabase(db);
    db.exec('DROP INDEX unique_report_timestamp');
    assert.throws(() => migrateDatabase(db), /incompatible index/);
    db.exec(
      'CREATE UNIQUE INDEX unique_report_timestamp ON entries (competition_id,operator_number,item_code,timestamp_on_report)',
    );
    db.pragma('foreign_keys = OFF');
    db.exec(
      "INSERT INTO power_hour_sessions (name,created_at,ends_at,competition_id) VALUES ('Bad link','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z',999)",
    );
    db.pragma('foreign_keys = ON');
    assert.throws(() => migrateDatabase(db), /foreign key check/);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    db.close();
  }
});

test('the CLI initializes and seeds the current metric schema, then migrates without changing reports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-migration-'));
  const path = join(directory, 'data', 'fresh.db');
  const env = { ...process.env, DATABASE_PATH: path };
  const run = (script: string) => {
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  let db: Database.Database | undefined;
  try {
    assert.match(run('scripts/migrate.mjs'), /Applied 5 migrations/);
    assert.match(run('scripts/seed.ts'), /8 sample operator reports/);
    db = new Database(path);
    const before = db.prepare('SELECT * FROM report_values ORDER BY id').all();
    assert.equal(before.length, 8);
    assert.match(run('scripts/migrate.mjs'), /schema is current/);
    assert.deepEqual(db.prepare('SELECT * FROM report_values ORDER BY id').all(), before);
    assert.deepEqual(db.prepare('SELECT key FROM competition_metrics').all(), [{ key: 'points' }]);
    const reseed = spawnSync(process.execPath, ['scripts/seed.ts'], { env, encoding: 'utf8' });
    assert.notEqual(reseed.status, 0);
    assert.match(reseed.stderr, /empty database/);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an existing baseline database gains revocable admin sessions without replacing competition data', () => {
  const db = new Database(':memory:');
  try {
    const baseline = readFileSync(
      new URL('../drizzle/0000_initial_schema.sql', import.meta.url),
      'utf8',
    );
    db.exec(baseline);
    db.exec(
      'CREATE TABLE rally_migrations (tag TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO rally_migrations VALUES (?, ?, ?)').run(
      '0000_initial_schema',
      createHash('sha256').update(baseline).digest('hex'),
      new Date().toISOString(),
    );
    db.prepare("INSERT INTO users (name) VALUES ('Retained participant')").run();
    assert.deepEqual(migrateDatabase(db), [
      '0001_admin_sessions',
      '0002_tracked_items',
      '0003_power_hour_reports',
      '0004_power_hour_plu_timestamps',
    ]);
    assert.deepEqual(db.prepare('SELECT name FROM users').all(), [
      { name: 'Retained participant' },
    ]);
    assert.deepEqual(db.prepare('SELECT * FROM admin_sessions').all(), []);
  } finally {
    db.close();
  }
});
