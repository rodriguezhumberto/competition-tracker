import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}
interface Index {
  name: string;
  unique: number;
}
// Astro relocates bundled server modules; deployments retain drizzle/ at the app root.
const sourceDirectory = new URL('../../drizzle/', import.meta.url);
const directory = existsSync(new URL('meta/_journal.json', sourceDirectory))
  ? sourceDirectory
  : pathToFileURL(resolve(process.cwd(), 'drizzle') + '/');
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', directory), 'utf8')) as {
  entries: { tag: string }[];
};

function columns(db: Database.Database, table: string) {
  return db.prepare(`PRAGMA table_info("${table}")`).all() as Column[];
}

function normalizeDefault(value: string | null) {
  return (
    value
      ?.replace(/^\((.*)\)$/, '$1')
      .replace(/^false$/i, '0')
      .replace(/^true$/i, '1') ?? null
  );
}

function verifySchema(db: Database.Database, expected: Database.Database) {
  const tables = expected
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const actual = columns(db, name);
    for (const wanted of columns(expected, name)) {
      const found = actual.find((column) => column.name === wanted.name);
      if (
        !found ||
        found.type.toUpperCase() !== wanted.type.toUpperCase() ||
        found.pk !== wanted.pk ||
        (!wanted.pk && found.notnull !== wanted.notnull) ||
        normalizeDefault(found.dflt_value) !== normalizeDefault(wanted.dflt_value)
      ) {
        throw new Error(`Unrecognized schema for ${name}.${wanted.name}. No migration applied.`);
      }
    }
    const indexes = db.prepare(`PRAGMA index_list("${name}")`).all() as Index[];
    for (const wanted of expected.prepare(`PRAGMA index_list("${name}")`).all() as Index[]) {
      // Primary-key autoindexes have implementation-defined names.
      if (wanted.name.startsWith('sqlite_')) continue;
      const found = indexes.find(
        (index) => index.name === wanted.name && index.unique === wanted.unique,
      );
      const indexColumns = (connection: Database.Database) =>
        (connection.prepare(`PRAGMA index_info("${wanted.name}")`).all() as { name: string }[]).map(
          (column: { name: string }) => column.name,
        );
      const predicate = (connection: Database.Database) => {
        const index = connection
          .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
          .get(wanted.name) as { sql: string } | undefined;
        return (index?.sql.split(/\bwhere\b/i)[1] ?? '')
          .toLowerCase()
          .replace(/["`\[\]]/g, '')
          .replace(/\b\w+\./g, '')
          .replace(/\btrue\b/g, '1')
          .replace(/\bfalse\b/g, '0')
          .replace(/[\s();]/g, '');
      };
      if (
        !found ||
        JSON.stringify(indexColumns(db)) !== JSON.stringify(indexColumns(expected)) ||
        predicate(db) !== predicate(expected)
      ) {
        throw new Error(`Missing or incompatible index ${wanted.name}. No migration applied.`);
      }
    }
    const foreignKeys = (connection: Database.Database) =>
      (connection.prepare(`PRAGMA foreign_key_list("${name}")`).all() as Record<string, unknown>[])
        .map(({ id, seq, ...key }) => JSON.stringify(key))
        .sort();
    if (JSON.stringify(foreignKeys(db)) !== JSON.stringify(foreignKeys(expected))) {
      throw new Error(`Incompatible foreign keys for ${name}. No migration applied.`);
    }
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length)
    throw new Error('Migration failed its foreign key check. No migration applied.');
}

export function migrateDatabase(db: Database.Database) {
  const migrations = journal.entries.map(({ tag }) => {
    const source = readFileSync(new URL(`${tag}.sql`, directory), 'utf8');
    return {
      tag,
      hash: createHash('sha256').update(source).digest('hex'),
      sql: source.replace(/PRAGMA\s+foreign_keys\s*=\s*(?:ON|OFF)\s*;/gi, ''),
    };
  });
  const expected = new Database(':memory:');
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  try {
    expected.pragma('foreign_keys = OFF');
    for (const migration of migrations) expected.exec(migration.sql);
    // SQLite cannot toggle foreign keys inside a transaction. Check all keys
    // before commit so future table-rebuild migrations can run atomically.
    db.pragma('foreign_keys = OFF');
    return db
      .transaction(() => {
        const existing = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[];
        if (existing.length && !existing.some(({ name }) => name === 'rally_migrations'))
          throw new Error('Unmanaged database schema. Start with a fresh database.');
        db.exec(
          'CREATE TABLE IF NOT EXISTS rally_migrations (tag TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TEXT NOT NULL)',
        );
        const recorded = db.prepare('SELECT tag, hash FROM rally_migrations').all() as {
          tag: string;
          hash: string;
        }[];
        if (recorded.some((row) => !migrations.some((migration) => migration.tag === row.tag)))
          throw new Error(
            'Database contains unsupported migration history. Start with a fresh database.',
          );
        const applied: string[] = [];
        for (const migration of migrations) {
          const previous = recorded.find((row) => row.tag === migration.tag);
          if (previous) {
            if (previous.hash !== migration.hash)
              throw new Error(`Applied migration ${migration.tag} has changed.`);
            continue;
          }
          db.exec(migration.sql);
          applied.push(migration.tag);
          db.prepare('INSERT INTO rally_migrations (tag, hash, applied_at) VALUES (?, ?, ?)').run(
            migration.tag,
            migration.hash,
            new Date().toISOString(),
          );
        }
        verifySchema(db, expected);
        return applied;
      })
      .immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    expected.close();
  }
}
