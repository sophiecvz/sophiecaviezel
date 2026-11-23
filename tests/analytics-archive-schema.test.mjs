import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../functions/api/events.js';
import { createD1, listMigrations } from './helpers/d1-sqlite.mjs';

// Local SQLite (node:sqlite), not Cloudflare D1: plans and timings are indicative only.
const migration = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const M1 = migration('0001_events.sql');
const M2 = migration('0002_monthly_archive.sql');
const names = (db, type) =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type)
    .map((r) => r.name);

function seed(db, count) {
  const insert = db.prepare(
    'INSERT INTO events (event_id, occurred_at, event_type, source) VALUES (?, ?, ?, ?)',
  );
  const types = ['page_view', 'page_view', 'page_view', 'fanvue_click', 'telegram_click'];
  const sources = ['threads', 'tiktok', 'instagram', 'facebook', 'tg', 'unknown'];
  const start = Date.parse('2026-09-01T00:00:00.000Z');
  const span = Date.parse('2026-12-01T00:00:00.000Z') - start;
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    insert.run(
      `e${i}`,
      new Date(start + Math.floor((i * span) / count)).toISOString(),
      types[i % types.length],
      sources[(i * 7) % sources.length],
    );
  }
  db.exec('COMMIT');
}

// Every query that touches `events` after the click notifier's removal, verbatim from
// sophie-analytics-dashboard (lib/analytics/read-stats.ts, workers/analytics-archive/archive.ts)
// and this repository (functions/api/events.js).
const MONTH = ['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'];
const RANGE = ['2026-11-10T00:00:00.000Z', '2026-11-17T00:00:00.000Z'];
const QUERIES = {
  ingest: [
    'INSERT INTO events (event_id, event_type, source) VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING',
    ['plan', 'page_view', 'tg'],
  ],
  liveTotals: [
    'SELECT event_type, COUNT(*) AS total FROM events WHERE occurred_at >= ? AND occurred_at < ? AND source = ? GROUP BY event_type',
    [...RANGE, 'tg'],
  ],
  liveDaily: [
    'SELECT substr(occurred_at, 1, 10) AS day, event_type, COUNT(*) AS total FROM events WHERE occurred_at >= ? AND occurred_at < ? GROUP BY substr(occurred_at, 1, 10), event_type ORDER BY day',
    RANGE,
  ],
  liveSources: [
    'SELECT source, event_type, COUNT(*) AS total FROM events WHERE occurred_at >= ? AND occurred_at < ? GROUP BY source, event_type',
    RANGE,
  ],
  firstEvent: ['SELECT MIN(occurred_at) AS first FROM events', []],
  cutoff: ['SELECT COALESCE(MAX(seq), 0) AS cutoff FROM events', []],
  cells: [
    'SELECT substr(occurred_at, 1, 10) AS day, source, event_type, COUNT(*) AS total, MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM events WHERE occurred_at >= ? AND occurred_at < ? AND seq <= ? GROUP BY day, source, event_type',
    [...MONTH, 1e9],
  ],
  count: [
    'SELECT COUNT(*) AS n FROM events WHERE occurred_at >= ? AND occurred_at < ? AND seq <= ?',
    [...MONTH, 1e9],
  ],
  purge: [
    'DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE seq BETWEEN ? AND ? AND +occurred_at >= ? AND +occurred_at < ? ORDER BY seq LIMIT ?)',
    [1, 1e9, ...MONTH, 250],
  ],
  remaining: [
    'SELECT 1 AS found FROM events WHERE seq BETWEEN ? AND ? AND +occurred_at >= ? AND +occurred_at < ? LIMIT 1',
    [1, 1e9, ...MONTH],
  ],
  late: [
    'SELECT COUNT(*) AS n FROM events WHERE occurred_at >= ? AND occurred_at < ? AND seq > ?',
    [...MONTH, 0],
  ],
  lateByMonth: [
    'SELECT substr(occurred_at, 1, 7) AS month, COUNT(*) AS n FROM events WHERE occurred_at >= ? AND occurred_at < ? GROUP BY month',
    MONTH,
  ],
};
const plan = (db, [sql, args]) =>
  db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((r) => r.detail)
    .join(' | ');

test('migrations apply in order 0001, 0002 on a fresh database', (t) => {
  assert.deepEqual(
    listMigrations().map((m) => m.name),
    ['0001_events.sql', '0002_monthly_archive.sql'],
  );
  const { sqlite, close } = createD1();
  t.after(close);
  assert.deepEqual(names(sqlite, 'table'), ['archive_alerts', 'archive_months', 'events']);
  assert.deepEqual(names(sqlite, 'index'), ['idx_events_time_source_type']);
  assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('0002 upgrades a populated 0001 database without touching events', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(M1);
  seed(db, 500);
  const before = db.prepare('SELECT * FROM events ORDER BY seq').all();
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get().seq;
  assert.ok(names(db, 'index').includes('idx_events_type_seq'));
  db.exec(M2);
  assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY seq').all(), before);
  assert.equal(
    db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get().seq,
    sequence,
    'AUTOINCREMENT high-water mark preserved',
  );
  assert.deepEqual(names(db, 'index'), ['idx_events_time_source_type']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM archive_months').get().n, 0);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
});

test('0001 stays byte-for-byte historical and 0002 owns the change', () => {
  assert.match(M1, /CREATE INDEX idx_events_type_seq ON events \(event_type, seq\);/);
  assert.match(M2, /^DROP INDEX IF EXISTS idx_events_type_seq;$/m);
  assert.doesNotMatch(M2, /CREATE INDEX/);
  assert.doesNotMatch(M2, /DROP TABLE|DELETE FROM|ALTER TABLE events/);
});

test('query plans: idx_events_type_seq is unused by every surviving query', () => {
  const withIndex = new DatabaseSync(':memory:');
  withIndex.exec(M1);
  const without = new DatabaseSync(':memory:');
  without.exec(M1);
  without.exec(M2);
  for (const db of [withIndex, without]) {
    seed(db, 30_000);
    db.exec('ANALYZE');
  }
  for (const [name, query] of Object.entries(QUERIES)) {
    const a = plan(withIndex, query);
    const b = plan(without, query);
    assert.equal(a, b, `${name} plan changes without the index`);
    assert.doesNotMatch(a, /idx_events_type_seq/, name);
    assert.doesNotMatch(a, /\bSCAN events\b/, `${name} must not scan the table`);
  }
  // Range reads use the time index; purge walks the primary key range.
  assert.match(plan(without, QUERIES.cells), /COVERING INDEX idx_events_time_source_type/);
  assert.match(plan(without, QUERIES.purge), /INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
  withIndex.close();
  without.close();
});

test('ingestion writes one fewer index entry per event without the notifier index', () => {
  const entries = (migrations) => {
    const db = new DatabaseSync(':memory:');
    for (const sql of migrations) db.exec(sql);
    db.prepare(QUERIES.ingest[0]).run(...QUERIES.ingest[1]);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'",
      )
      .get().n;
    db.close();
    return count;
  };
  // Indexes maintained on insert: UNIQUE(event_id) autoindex + time index (+ notifier index).
  assert.equal(entries([M1]), 3);
  assert.equal(entries([M1, M2]), 2);
});

test('event ingestion and deduplication are unchanged on the final schema', async (t) => {
  const { db, sqlite, close } = createD1();
  t.after(close);
  const env = {
    ANALYTICS_ENABLED: '1',
    ANALYTICS_DB: db,
    ANALYTICS_LIMITER: { fetch: async () => new Response(null, { status: 204 }) },
  };
  const send = (event_id, event_type = 'fanvue_click') =>
    onRequest({
      request: new Request('http://localhost/api/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
          'cf-connecting-ip': '203.0.113.1',
        },
        body: JSON.stringify({ event_id, event_type, source: 'tiktok' }),
      }),
      env,
    });
  const id = '6e6c8894-d812-4edb-8710-9e7ecf4bf249';
  assert.equal((await send(id)).status, 204);
  assert.equal((await send(id, 'page_view')).status, 204);
  assert.equal((await send('0f8c1f4e-5a3b-4c1d-9a7e-2b6d4e8f1a30', 'telegram_click')).status, 204);
  assert.deepEqual(
    sqlite
      .prepare('SELECT event_type, source FROM events ORDER BY seq')
      .all()
      .map((r) => ({ ...r })),
    [
      { event_type: 'fanvue_click', source: 'tiktok' },
      { event_type: 'telegram_click', source: 'tiktok' },
    ],
  );
});

test('archive_months accepts a valid lifecycle and rejects invalid rows', (t) => {
  const { sqlite, close } = createD1();
  t.after(close);
  const base = {
    month: '2026-10',
    state: 'built',
    snapshot_seq: 20,
    min_seq: 3,
    max_seq: 18,
    row_count: 12,
    sha256: 'c'.repeat(64),
    payload: '{}',
    payload_bytes: 2,
    built_at: 1,
  };
  const insert = (row) => {
    const keys = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO archive_months (${keys}) VALUES (${keys.map(() => '?')})`)
      .run(...Object.values(row));
  };
  insert(base);
  const update = (sql) =>
    sqlite.prepare(`UPDATE archive_months SET ${sql} WHERE month = '2026-10'`).run();
  assert.throws(() => update("state = 'sent'"), /CHECK/, 'sent needs a Telegram receipt');
  update("state = 'sent', telegram_message_id = 5, telegram_file_unique_id = 'U', sent_at = 2");
  assert.throws(() => update("state = 'purging'"), /CHECK/, 'purging needs a start time');
  update("state = 'purging', purge_started_at = 3");
  assert.throws(
    () => update("state = 'purged', purged_at = 4"),
    /CHECK/,
    'payload must be dropped',
  );
  update("state = 'purged', purged_at = 4, payload = NULL");
  assert.throws(() => insert(base), /UNIQUE|PRIMARY/);
  for (const bad of [
    { month: '2026-00' },
    { month: '26-10' },
    { state: 'deleted' },
    { sha256: 'xyz' },
    { min_seq: 0 },
    { max_seq: 21 },
    { row_count: 17 },
    { payload_bytes: 0 },
    { last_error: 'has spaces' },
  ])
    assert.throws(
      () => insert({ ...base, month: bad.month ?? '2026-09', ...bad }),
      JSON.stringify(bad),
    );
});

// Late rows (occurred_at in an already archived month, seq above its snapshot) cannot be
// produced by the supported ingestion path: the client cannot choose occurred_at or seq,
// and the database assigns both in the same INSERT statement.
test('ingestion: the only events INSERT lets the database assign occurred_at and seq', () => {
  const handler = readFileSync(new URL('../functions/api/events.js', import.meta.url), 'utf8');
  const inserts = handler.match(/INSERT INTO events \(([^)]*)\)/g);
  assert.deepEqual(inserts, ['INSERT INTO events (event_id, event_type, source)']);
  assert.match(M1, /occurred_at TEXT NOT NULL DEFAULT \(strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)\)/);
  assert.match(M1, /seq INTEGER PRIMARY KEY AUTOINCREMENT/);
});

test('ingestion: payloads carrying occurred_at or seq are rejected and store nothing', async (t) => {
  const { db, sqlite, close } = createD1();
  t.after(close);
  const env = {
    ANALYTICS_ENABLED: '1',
    ANALYTICS_DB: db,
    ANALYTICS_LIMITER: { fetch: async () => new Response(null, { status: 204 }) },
  };
  const base = {
    event_id: '6e6c8894-d812-4edb-8710-9e7ecf4bf249',
    event_type: 'page_view',
    source: 'tg',
  };
  const post = (payload) =>
    onRequest({
      request: new Request('http://localhost/api/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
          'cf-connecting-ip': '203.0.113.1',
        },
        body: JSON.stringify(payload),
      }),
      env,
    });
  for (const payload of [
    { ...base, occurred_at: '2026-10-31T23:59:59.999Z' },
    { ...base, seq: 1 },
    {
      event_id: base.event_id,
      event_type: base.event_type,
      occurred_at: '2026-10-01T00:00:00.000Z',
    },
  ])
    assert.equal((await post(payload)).status, 204);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  // A valid event gets a server-assigned, current timestamp.
  const before = Date.now();
  await post(base);
  const row = sqlite.prepare('SELECT seq, occurred_at FROM events').get();
  assert.ok(Date.parse(row.occurred_at) >= before - 1000);
  assert.equal(row.seq, 1);
});

test('archive_alerts accepts only fixed classes and is deduplicated by key', (t) => {
  const { sqlite, close } = createD1();
  t.after(close);
  const insert = (row) => {
    const full = {
      kind: 'halted',
      month: '2026-10',
      reason: 'count_mismatch',
      created_at: 1,
      ...row,
    };
    const keys = Object.keys(full);
    sqlite
      .prepare(`INSERT INTO archive_alerts (${keys}) VALUES (${keys.map(() => '?')})`)
      .run(...Object.values(full));
  };
  insert({ alert_key: 'halted:2026-10' });
  assert.throws(() => insert({ alert_key: 'halted:2026-10' }), /UNIQUE|PRIMARY/);
  insert({
    alert_key: 'build_blocked:unknown',
    kind: 'build_blocked',
    month: 'unknown',
    reason: 'timestamp',
  });
  for (const bad of [
    { alert_key: 'Halted 2026' },
    { alert_key: 'x', kind: 'click' },
    { alert_key: 'y', month: 'October' },
    { alert_key: 'z', reason: 'chat 12345 said hi' },
    { alert_key: 'w', state: 'sent' },
  ])
    assert.throws(() => insert(bad), JSON.stringify(bad));
  sqlite
    .prepare(
      "UPDATE archive_alerts SET state = 'sent', sent_at = 2 WHERE alert_key = 'halted:2026-10'",
    )
    .run();
});
