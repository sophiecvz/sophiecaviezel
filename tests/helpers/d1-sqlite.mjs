import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Local SQLite stand-in for the part of Cloudflare D1 used by the analytics handler.
 *
 * It applies the real files from `migrations/` (numeric order) to an isolated in-memory
 * `node:sqlite` database, so the schema, constraints and defaults are enforced by SQLite
 * itself. Only `prepare(sql).bind(...).run()` is implemented, returning `meta.changes` and
 * `meta.last_row_id`. It is not D1: no network, latency, quotas, batching or real
 * cross-request concurrency, and SQLite error text may differ from D1's.
 */

const migrationsUrl = new URL('../../migrations/', import.meta.url);

export function listMigrations() {
  const files = readdirSync(migrationsUrl)
    .map((name) => {
      const match = /^(\d+)_.+\.sql$/.exec(name);
      return match ? { number: Number(match[1]), name } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);
  if (files.length === 0) throw new Error('No migrations found');
  for (let i = 1; i < files.length; i++) {
    if (files[i].number === files[i - 1].number) {
      throw new Error(`Duplicate migration number: ${files[i].name}`);
    }
  }
  return files;
}

export function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const { name } of listMigrations()) {
    sqlite.exec(readFileSync(new URL(name, migrationsUrl), 'utf8'));
  }

  function statement(sql, args = []) {
    return {
      bind(...next) {
        return statement(sql, next);
      },
      async run() {
        const result = sqlite.prepare(sql).run(...args);
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
        };
      },
    };
  }

  return {
    sqlite,
    db: { prepare: (sql) => statement(sql) },
    close: () => sqlite.close(),
  };
}
