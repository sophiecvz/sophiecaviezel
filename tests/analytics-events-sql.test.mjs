import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/events.js';
import { createD1, listMigrations } from './helpers/d1-sqlite.mjs';

const url = 'http://localhost:8788/api/events';
const safariUA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ids = [
  '6e6c8894-d812-4edb-8710-9e7ecf4bf249',
  '0f8c1f4e-5a3b-4c1d-9a7e-2b6d4e8f1a30',
  'b2d4f6a8-1c3e-4a5b-8c7d-9e0f1a2b3c4d',
];
const sampleEvent = { event_id: ids[0], event_type: 'page_view', source: 'threads' };
const timestampFormat = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function makeRequest(payload = sampleEvent) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': safariUA,
      'cf-connecting-ip': '203.0.113.10',
    },
    body: JSON.stringify(payload),
  });
}

function setup(t, extraEnv = {}) {
  const { db, sqlite, close } = createD1();
  t.after(close);
  const env = {
    ANALYTICS_ENABLED: '1',
    ...extraEnv,
    ANALYTICS_DB: db,
    ANALYTICS_LIMITER: { fetch: async () => new Response(null, { status: 204 }) },
  };
  const send = (payload) => onRequest({ request: makeRequest(payload), env });
  const rows = () => sqlite.prepare('SELECT * FROM events ORDER BY seq').all();
  return { sqlite, send, rows };
}

const insert = (sqlite, id, type = 'page_view', source = 'threads') =>
  sqlite
    .prepare('INSERT INTO events (event_id, event_type, source) VALUES (?, ?, ?)')
    .run(id, type, source);

// Handler -> production INSERT -> real schema.

test('handler stores an accepted event through the production INSERT', async (t) => {
  const { send, rows } = setup(t);
  assert.equal((await send()).status, 204);
  const stored = rows();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].event_id, sampleEvent.event_id);
  assert.equal(stored[0].event_type, 'page_view');
  assert.equal(stored[0].source, 'threads');
  assert.match(stored[0].occurred_at, timestampFormat);
});

test('handler accepts every valid event type', async (t) => {
  const { send, rows } = setup(t);
  const types = ['page_view', 'telegram_click', 'fanvue_click'];
  for (const [i, event_type] of types.entries()) {
    assert.equal((await send({ ...sampleEvent, event_id: ids[i], event_type })).status, 204);
  }
  assert.deepEqual(
    rows().map((row) => row.event_type),
    types,
  );
});

test('duplicate event_id keeps a single row and does not overwrite it', async (t) => {
  const { send, rows } = setup(t);
  assert.equal((await send()).status, 204);
  const [original] = rows();
  assert.equal(
    (await send({ ...sampleEvent, event_type: 'fanvue_click', source: 'tiktok' })).status,
    204,
  );
  assert.deepEqual(rows(), [original]);
});

test('handler sees meta.changes === 0 for a duplicate and 1 for a new event', async (t) => {
  const { send } = setup(t, { ANALYTICS_DEBUG: '1' });
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);
  try {
    await send();
    await send();
  } finally {
    console.info = originalInfo;
  }
  assert.deepEqual(logs, [
    ['[analytics:stored]', 'page_view:threads'],
    ['[analytics:duplicate]', 'page_view:threads'],
  ]);
});

test('sequence identifiers increase for accepted inserts and need not be gapless', async (t) => {
  const { send, rows } = setup(t);
  for (const id of ids) await send({ ...sampleEvent, event_id: id });
  await send({ ...sampleEvent, event_id: ids[0] });
  const seqs = rows().map((row) => row.seq);
  assert.equal(seqs.length, 3);
  assert.ok(
    seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]),
    `not increasing: ${seqs}`,
  );
});

test('handler rejects invalid types and sources before the database', async (t) => {
  const { send, rows } = setup(t);
  assert.equal((await send({ ...sampleEvent, event_type: 'purchase' })).status, 204);
  assert.equal((await send({ ...sampleEvent, source: 'myspace' })).status, 204);
  assert.deepEqual(rows(), []);
});

test('source validation belongs to the handler: the schema has no source CHECK', async (t) => {
  const { sqlite } = setup(t);
  const sql = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'events'").get().sql;
  assert.doesNotMatch(sql, /CHECK\s*\(\s*source/i);
  insert(sqlite, ids[0], 'page_view', 'not-a-known-source');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});

// Direct schema contracts.

test('migrations are applied from the repository in unique numeric order', () => {
  const migrations = listMigrations();
  assert.ok(migrations.length >= 1);
  assert.deepEqual(
    migrations.map((m) => m.number),
    [...new Set(migrations.map((m) => m.number))].sort((a, b) => a - b),
  );
});

test('UNIQUE(event_id) rejects a second row with the same id', (t) => {
  const { sqlite } = setup(t);
  insert(sqlite, ids[0]);
  assert.throws(() => insert(sqlite, ids[0]), /UNIQUE/);
});

test('CHECK rejects an unknown event_type and accepts the valid ones', (t) => {
  const { sqlite } = setup(t);
  assert.throws(() => insert(sqlite, ids[0], 'purchase'), /CHECK/);
  for (const [i, type] of ['page_view', 'telegram_click', 'fanvue_click'].entries()) {
    insert(sqlite, ids[i], type);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get().n, 3);
});

test('NOT NULL is enforced on event_id, event_type, source and occurred_at', (t) => {
  const { sqlite } = setup(t);
  const attempt =
    (sql, ...args) =>
    () =>
      sqlite.prepare(sql).run(...args);
  assert.throws(
    attempt(
      'INSERT INTO events (event_id, event_type, source) VALUES (NULL, ?, ?)',
      'page_view',
      'tg',
    ),
    /NOT NULL/,
  );
  assert.throws(
    attempt('INSERT INTO events (event_id, event_type, source) VALUES (?, NULL, ?)', ids[0], 'tg'),
    /NOT NULL/,
  );
  assert.throws(
    attempt(
      'INSERT INTO events (event_id, event_type, source) VALUES (?, ?, NULL)',
      ids[0],
      'page_view',
    ),
    /NOT NULL/,
  );
  assert.throws(
    attempt(
      'INSERT INTO events (event_id, occurred_at, event_type, source) VALUES (?, NULL, ?, ?)',
      ids[0],
      'page_view',
      'tg',
    ),
    /NOT NULL/,
  );
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('default occurred_at is UTC ISO-8601 with millisecond precision', (t) => {
  const { sqlite } = setup(t);
  const before = Date.now();
  insert(sqlite, ids[0]);
  const after = Date.now();
  const { occurred_at } = sqlite.prepare('SELECT occurred_at FROM events').get();
  assert.match(occurred_at, timestampFormat);
  assert.equal(occurred_at.length, 24);
  const time = Date.parse(occurred_at);
  assert.ok(time >= before - 1000 && time <= after + 1000, `unexpected time ${occurred_at}`);
  // Same width as the dashboard's period bounds, so string comparison stays valid.
  assert.ok(occurred_at > '2000-01-01T00:00:00.000Z');
});

test('the schema has the expected columns and indexes', (t) => {
  const { sqlite } = setup(t);
  assert.deepEqual(
    sqlite
      .prepare("SELECT name FROM pragma_table_info('events') ORDER BY cid")
      .all()
      .map((c) => c.name),
    ['seq', 'event_id', 'occurred_at', 'event_type', 'source'],
  );
  const indexes = (name) =>
    sqlite
      .prepare(`SELECT name FROM pragma_index_info('${name}') ORDER BY seqno`)
      .all()
      .map((c) => c.name);
  assert.deepEqual(indexes('idx_events_time_source_type'), ['occurred_at', 'source', 'event_type']);
  assert.deepEqual(indexes('idx_events_type_seq'), ['event_type', 'seq']);
});
