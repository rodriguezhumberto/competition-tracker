import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

process.env.DATABASE_PATH = ':memory:';
const directory = mkdtempSync(join(tmpdir(), 'rally-demo-boundary-'));
process.env.DEMO_DIR = directory;
const { db, sqlite, withDemoRequest, getProductionSqlite } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const { createDemoWorkspace, withDemo, getDemoWorkspace } =
  await import('../src/lib/demo-workspaces.ts');
const { preferences } = await import('../src/lib/demo-access.ts');
const { currentCompetition } = await import('../src/lib/competition-config.ts');
after(() => rmSync(directory, { recursive: true, force: true }));

test('demo routes fail closed when an application store lacks a workspace context', () => {
  withDemoRequest(() => {
    assert.throws(() => sqlite.prepare('SELECT * FROM competitions'), /validated workspace/);
    assert.throws(() => db.select(), /validated workspace/);
    assert.throws(() => currentCompetition(), /validated workspace/);
    assert.throws(() => getProductionSqlite(), /unavailable in demo requests/);
  });
  assert.equal(currentCompetition(), undefined, 'production access resumes outside demo requests');
  assert.equal(getProductionSqlite().name, ':memory:');
});

test('public demo creation and registry lookups work without production access', () => {
  withDemoRequest(() => {
    const room = createDemoWorkspace();
    assert.equal(getDemoWorkspace(room.id)?.id, room.id);
    withDemo(room.id, () => {
      assert(currentCompetition(), 'the selected demo exposes its seeded competition');
      assert.equal(preferences('presenter'), 'presenter');
      assert.throws(() => getProductionSqlite(), /unavailable in demo requests/);
    });
    assert.throws(() => currentCompetition(), /validated workspace/);
  });
});

test('demo helpers cannot create tables in production when called without context', () => {
  assert.throws(() => preferences('presenter'), /validated workspace/);
  assert.equal(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'demo_preferences'").get(),
    undefined,
  );
});

test('demo workspace scopes also reject production settings outside public demo requests', () => {
  const room = createDemoWorkspace();
  withDemo(room.id, () => {
    assert.throws(() => getProductionSqlite(), /unavailable in demo requests/);
  });
});

test('demo request boundaries and workspace selection stay isolated across asynchronous requests', async () => {
  const room = createDemoWorkspace();
  await Promise.all([
    withDemoRequest(async () => {
      await Promise.resolve();
      await withDemo(room.id, async () => {
        await Promise.resolve();
        assert(currentCompetition());
        assert.throws(() => getProductionSqlite(), /unavailable in demo requests/);
      });
      assert.throws(() => currentCompetition(), /validated workspace/);
    }),
    (async () => {
      await Promise.resolve();
      assert.equal(currentCompetition(), undefined);
      assert.equal(getProductionSqlite().name, ':memory:');
    })(),
  ]);
});

test('invalid and expired workspaces never fall back to production within a demo request', () => {
  const room = createDemoWorkspace();
  const registry = new Database(join(directory, 'registry.sqlite'));
  registry.prepare('UPDATE workspaces SET expiresAt = 0 WHERE id = ?').run(room.id);
  registry.close();
  withDemoRequest(() => {
    for (const id of [room.id, '../sqlite.db', 'a'.repeat(32)]) {
      let called = false;
      assert.throws(
        () =>
          withDemo(id, () => {
            called = true;
          }),
        /expired/,
      );
      assert.equal(called, false);
    }
    assert.throws(() => currentCompetition(), /validated workspace/);
  });
});
