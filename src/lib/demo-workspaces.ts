import Database from 'better-sqlite3';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { withDatabase } from '../db/index.ts';
import { migrateDatabase } from '../db/migrate.ts';
import { seedDemoWorkspace } from './demo-seed.ts';

export interface DemoWorkspace {
  id: string;
  ownerHash: string;
  shareToken: string;
  createdAt: number;
  expiresAt: number;
}
const ID = /^[a-f0-9]{32}$/;
const TTL = 2 * 3600000;
const MAX_WORKSPACES = 100;
const key = Symbol.for('rally.demo-workspaces');
type Registry = {
  directory: string;
  database: Database.Database;
  connections: Map<string, Database.Database>;
};
const shared = globalThis as typeof globalThis & { [key]?: Map<string, Registry> };
const registries = (shared[key] ??= new Map<string, Registry>());
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const token = () => randomBytes(32).toString('hex');
function storage() {
  const directory = resolve(process.env.DEMO_DIR || './data/demos');
  let registry = registries.get(directory);
  if (!registry) {
    if (
      process.env.DATABASE_PATH !== ':memory:' &&
      resolve(process.env.DATABASE_PATH || './sqlite.db') === join(directory, 'registry.sqlite')
    ) {
      throw new Error('Demo storage must be separate from the production database.');
    }
    mkdirSync(directory, { recursive: true });
    const database = new Database(join(directory, 'registry.sqlite'));
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    database.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, ownerHash TEXT NOT NULL, shareToken TEXT NOT NULL,
      createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL
    )`);
    registry = { directory, database, connections: new Map() };
    registries.set(directory, registry);
    const ownedRegistry = registry;
    const cleanup = setInterval(() => {
      try {
        cleanupRegistry(ownedRegistry);
      } catch (error) {
        console.error('Demo workspace cleanup failed:', error);
      }
    }, 60000);
    cleanup.unref();
  }
  return registry;
}
function removeWorkspace(id: string, registry: Registry = storage()) {
  const { directory, database, connections } = registry;
  connections.get(id)?.close();
  connections.delete(id);
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(join(directory, `${id}.sqlite${suffix}`), { force: true });
  database.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
}
function cleanupRegistry(registry: Registry) {
  const { database } = registry;
  const expired = database
    .prepare('SELECT id FROM workspaces WHERE expiresAt <= ?')
    .all(Date.now()) as { id: string }[];
  for (const { id } of expired) removeWorkspace(id, registry);
}
export function cleanupDemoWorkspaces() {
  cleanupRegistry(storage());
}
export function getDemoWorkspace(id: string): DemoWorkspace | null {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  const { database } = storage();
  const row = database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
    DemoWorkspace | undefined;
  return row && row.expiresAt > Date.now() ? row : null;
}
function connection(id: string) {
  const { directory, connections } = storage();
  let database = connections.get(id);
  if (!database) {
    database = new Database(join(directory, `${id}.sqlite`));
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    migrateDatabase(database);
    connections.set(id, database);
  }
  return database;
}
export function withDemo<T>(id: string, fn: () => T): T {
  if (!getDemoWorkspace(id)) throw new Error('This demo has expired. Start a new demo.');
  return withDatabase(connection(id), fn);
}
export function touchDemoWorkspace(id: string): void {
  if (!getDemoWorkspace(id)) throw new Error('This demo has expired. Start a new demo.');
  storage()
    .database.prepare('UPDATE workspaces SET expiresAt = ? WHERE id = ?')
    .run(Date.now() + TTL, id);
}
export function createDemoWorkspace(): { id: string; ownerToken: string; shareToken: string } {
  cleanupDemoWorkspaces();
  const { database } = storage();
  const id = randomBytes(16).toString('hex'),
    ownerToken = token(),
    shareToken = token();
  const now = Date.now();
  database
    .transaction(() => {
      const count = (
        database.prepare('SELECT count(*) AS count FROM workspaces').get() as { count: number }
      ).count;
      if (count >= MAX_WORKSPACES) throw new Error('The demo is busy. Please try again later.');
      database
        .prepare(
          'INSERT INTO workspaces (id, ownerHash, shareToken, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, hash(ownerToken), shareToken, now, now + TTL);
    })
    .immediate();
  try {
    withDemo(id, seedDemoWorkspace);
  } catch (error) {
    removeWorkspace(id);
    throw error;
  }
  return { id, ownerToken, shareToken };
}
function matches(actual: string, expected: string) {
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function authorizeDemoOwner(id: string, ownerToken: string): boolean {
  const workspace = getDemoWorkspace(id);
  return (
    !!workspace &&
    typeof ownerToken === 'string' &&
    /^[a-f0-9]{64}$/.test(ownerToken) &&
    matches(hash(ownerToken), workspace.ownerHash)
  );
}
export function authorizeDemoShare(id: string, shareToken: string): boolean {
  const workspace = getDemoWorkspace(id);
  return !!workspace && typeof shareToken === 'string' && matches(shareToken, workspace.shareToken);
}
export function resetDemoWorkspace(id: string): void {
  // Keep the connection and access credentials; reset all application tables atomically.
  withDemo(id, () => {
    const database = connection(id);
    database
      .transaction(() => {
        for (const table of ['demo_simulation', 'demo_preferences']) {
          if (
            database
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(table)
          )
            database.exec(`DELETE FROM "${table}"`);
        }
        const tables = [
          'report_values',
          'report_drafts',
          'entries',
          'reports',
          'competition_metrics',
          'power_hour_scores',
          'power_hour_participants',
          'power_hour_sessions',
          'users',
          'competitions',
        ];
        for (const table of tables) database.exec(`DELETE FROM "${table}"`);
        database.exec('DELETE FROM sqlite_sequence');
        seedDemoWorkspace();
      })
      .immediate();
  });
}
