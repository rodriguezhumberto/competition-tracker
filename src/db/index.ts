import '../lib/env.ts';
import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.ts';
const filename = process.env.DATABASE_PATH || './sqlite.db';
if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
const productionSqlite = new Database(filename);
productionSqlite.pragma('journal_mode = WAL');
productionSqlite.pragma('foreign_keys = ON');
productionSqlite.pragma('busy_timeout = 5000');
const productionDb = drizzle(productionSqlite, { schema });
type DatabaseContext = { sqlite: Database.Database; db: typeof productionDb };
const key = Symbol.for('rally.database-context');
const shared = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<DatabaseContext> };
const context = (shared[key] ??= new AsyncLocalStorage<DatabaseContext>());
const demoKey = Symbol.for('rally.demo-request-context');
const demoShared = globalThis as typeof globalThis & {
  [demoKey]?: AsyncLocalStorage<boolean>;
};
const demoRequest = (demoShared[demoKey] ??= new AsyncLocalStorage<boolean>());
// Public demo routes must explicitly select a workspace before using application stores.
export function withDemoRequest<T>(fn: () => T): T {
  return demoRequest.run(true, fn);
}
function requireSelectedDatabase() {
  if (demoRequest.getStore() && !context.getStore())
    throw new Error('Demo database access requires a validated workspace.');
}
// Site privacy can only be accessed outside public demo requests and workspace scopes.
export function getProductionSqlite(): Database.Database {
  if (demoRequest.getStore() || context.getStore())
    throw new Error('Production settings are unavailable in demo requests.');
  return productionSqlite;
}
export function withDatabase<T>(database: Database.Database, fn: () => T): T {
  return context.run({ sqlite: database, db: drizzle(database, { schema }) }, fn);
}
export function hasDatabaseContext() {
  return !!context.getStore();
}
// Method binding is essential for SQLite's native methods and Drizzle's builders.
function selectedProxy<T extends object>(defaultValue: T, select: () => T): T {
  return new Proxy(defaultValue, {
    get(_target, property) {
      const selected = select();
      const value = Reflect.get(selected, property, selected);
      return typeof value === 'function' ? value.bind(selected) : value;
    },
  });
}
export const sqlite = selectedProxy(productionSqlite, () => {
  requireSelectedDatabase();
  return context.getStore()?.sqlite ?? productionSqlite;
});
export const db = selectedProxy(productionDb, () => {
  requireSelectedDatabase();
  return context.getStore()?.db ?? productionDb;
});
