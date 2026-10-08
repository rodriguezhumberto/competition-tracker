import '../src/lib/env.ts';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrateDatabase } from '../src/db/migrate.ts';

const filename = process.env.DATABASE_PATH || './sqlite.db';
if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
const db = new Database(filename);
try {
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const applied = migrateDatabase(db);
  console.log(
    applied.length ? `Applied ${applied.length} migrations.` : 'Database schema is current.',
  );
} finally {
  db.close();
}
