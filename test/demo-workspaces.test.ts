import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

process.env.DATABASE_PATH = ':memory:';
const directory = mkdtempSync(join(tmpdir(), 'rally-demo-test-'));
process.env.DEMO_DIR = directory;
const { db, sqlite } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const workspace = await import('../src/lib/demo-workspaces.ts');
const store = await import('../src/lib/store.ts');
const { leaderboard } = await import('../src/lib/leaderboard.ts');
const { currentCompetition } = await import('../src/lib/competition-config.ts');
const { events } = await import('../src/lib/events.ts');
const { users } = await import('../src/db/schema.ts');
after(() => rmSync(directory, { recursive: true, force: true }));

test('invites expire after two hours of inactivity and visits refresh the timeout', (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const room = workspace.createDemoWorkspace();
  now += 3600000;
  assert.equal(workspace.authorizeDemoShare(room.id, room.shareToken), true);
  workspace.touchDemoWorkspace(room.id);
  now += 2 * 3600000 - 1;
  assert.equal(workspace.authorizeDemoShare(room.id, room.shareToken), true);
  now += 1;
  assert.equal(workspace.authorizeDemoShare(room.id, room.shareToken), false);
  assert.equal(workspace.authorizeDemoOwner(room.id, room.ownerToken), false);
});

test('separate workspaces use actual competition, report and score stores without changing production', async () => {
  let productionEvents = 0;
  const listener = () => productionEvents++;
  events.on('power-hour-change', listener);
  try {
    const a = workspace.createDemoWorkspace(),
      b = workspace.createDemoWorkspace();
    assert.equal(productionEvents, 0, 'seed events must not broadcast to production');
    assert.equal(currentCompetition(), undefined);
    assert.equal(db.select().from(users).all().length, 0);
    const initialExpiry = workspace.getDemoWorkspace(a.id)!.expiresAt;
    await Promise.all(
      [a, b].map((w, index) =>
        workspace.withDemo(w.id, async () => {
          await new Promise((resolve) => setTimeout(resolve, index ? 1 : 5));
          const competition = currentCompetition()!;
          const standings = leaderboard(competition.id);
          assert.equal(standings.rows.length, 8);
          assert.equal(store.getArchives().length, 1);
          const session = store.startSession({
            name: `Room ${index}`,
            password: 'test-password',
            duration_minutes: 5,
          });
          const person = store.joinSession(session.id, 'test-password', `Visitor ${index}`);
          store.incrementScore(person.userId, session.id);
          assert.equal(store.sessionScores(session.id)[0].name, `Visitor ${index}`);
        }),
      ),
    );
    assert.equal(
      workspace.getDemoWorkspace(a.id)!.expiresAt,
      initialExpiry,
      'background execution must not extend expiry',
    );
    assert.equal(
      workspace.withDemo(a.id, () => store.activeSession()!.name),
      'Room 0',
    );
    assert.equal(
      workspace.withDemo(b.id, () => store.activeSession()!.name),
      'Room 1',
    );
    assert.equal(store.activeSession(), null);
    assert.equal(productionEvents, 0);
    events.emit('power-hour-change');
    assert.equal(productionEvents, 1, 'production bus still functions');
  } finally {
    events.off('power-hour-change', listener);
  }
});

test('reset restores sample data, removes simulation state and preserves credentials', () => {
  const room = workspace.createDemoWorkspace();
  workspace.withDemo(room.id, () => {
    sqlite.exec(
      "CREATE TABLE demo_simulation (state TEXT); INSERT INTO demo_simulation VALUES ('running')",
    );
    store.startSession({ name: 'Visitor session', password: 'test-password' });
  });
  workspace.resetDemoWorkspace(room.id);
  assert.equal(workspace.authorizeDemoOwner(room.id, room.ownerToken), true);
  assert.equal(workspace.authorizeDemoShare(room.id, room.shareToken), true);
  assert.equal(workspace.authorizeDemoOwner(room.id, room.shareToken), false);
  assert.equal(workspace.authorizeDemoOwner(room.id, 'invalid'), false);
  workspace.withDemo(room.id, () => {
    assert.equal(store.activeSession(), null);
    assert.equal(store.getArchives().length, 1);
    assert.equal(
      (sqlite.prepare('SELECT count(*) AS count FROM demo_simulation').get() as { count: number })
        .count,
      0,
    );
    assert.equal(leaderboard(currentCompetition()!.id).rows.length, 8);
  });
});

test('expired workspaces refuse access, cleanup deletes data, and malformed IDs cannot traverse paths', () => {
  const room = workspace.createDemoWorkspace();
  const registry = new Database(join(directory, 'registry.sqlite'));
  registry.prepare('UPDATE workspaces SET expiresAt = ? WHERE id = ?').run(Date.now() - 1, room.id);
  registry.close();
  assert.equal(workspace.getDemoWorkspace(room.id), null);
  assert.equal(workspace.authorizeDemoOwner(room.id, room.ownerToken), false);
  assert.throws(() => workspace.withDemo(room.id, () => null), /expired/);
  assert.equal(workspace.getDemoWorkspace('../sqlite.db'), null);
  workspace.cleanupDemoWorkspaces();
  assert.equal(existsSync(join(directory, `${room.id}.sqlite`)), false);
});

test('workspace credentials and reports survive a fresh SQLite connection', () => {
  const room = workspace.createDemoWorkspace();
  const persisted = new Database(join(directory, `${room.id}.sqlite`), { readonly: true });
  assert.equal(
    (persisted.prepare('SELECT count(*) AS n FROM reports').get() as { n: number }).n,
    5,
  );
  assert.equal(
    (persisted.prepare('SELECT count(*) AS n FROM report_values').get() as { n: number }).n,
    120,
  );
  persisted.close();
  const registry = new Database(join(directory, 'registry.sqlite'), { readonly: true });
  const metadata = registry
    .prepare('SELECT ownerHash FROM workspaces WHERE id = ?')
    .get(room.id) as { ownerHash: string };
  assert.notEqual(metadata.ownerHash, room.ownerToken);
  registry.close();
});
