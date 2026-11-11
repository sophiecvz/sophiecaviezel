import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/events.js';

const url = 'http://localhost:8788/api/events';
const safariUA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const sampleEvent = {
  event_id: '6e6c8894-d812-4edb-8710-9e7ecf4bf249',
  event_type: 'page_view',
  source: 'threads',
};

function makeRequest(payload = sampleEvent, agent = safariUA) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': agent,
      'cf-connecting-ip': '203.0.113.10',
    },
    body: JSON.stringify(payload),
  });
}

// In-memory D1 stub; SQL constraints are checked separately.
function makeDatabase() {
  const rows = new Map();
  return {
    rows,
    prepare(statement) {
      assert.match(statement, /ON CONFLICT\(event_id\) DO NOTHING/);
      return {
        bind(eventId, eventType, source) {
          return {
            async run() {
              if (rows.has(eventId)) return { meta: { changes: 0 } };
              rows.set(eventId, { eventId, eventType, source });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

function withLimiter(env, decision = 204) {
  return {
    ...env,
    ANALYTICS_LIMITER: {
      async fetch(url, init) {
        assert.equal(url, 'https://limiter.internal/check');
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-analytics-rate-key'], '203.0.113.10');
        return new Response(null, { status: decision });
      },
    },
  };
}

test('accepted event is written once and repeated event is deduplicated', async () => {
  const database = makeDatabase();
  const env = withLimiter({ ANALYTICS_ENABLED: '1', ANALYTICS_DB: database });
  assert.equal((await onRequest({ request: makeRequest(), env })).status, 204);
  assert.equal((await onRequest({ request: makeRequest(), env })).status, 204);
  assert.equal(database.rows.size, 1);
});

test('known bot does not reach the database', async () => {
  const database = makeDatabase();
  const response = await onRequest({
    request: makeRequest(sampleEvent, 'facebookexternalhit/1.1'),
    env: withLimiter({ ANALYTICS_ENABLED: '1', ANALYTICS_DB: database }),
  });
  assert.equal(response.status, 204);
  assert.equal(database.rows.size, 0);
});

test('events are not stored while analytics is disabled', async () => {
  const database = makeDatabase();
  assert.equal(
    (
      await onRequest({
        request: makeRequest(),
        env: { ANALYTICS_ENABLED: '0', ANALYTICS_DB: database },
      })
    ).status,
    204,
  );
  assert.equal(database.rows.size, 0);
});

test('missing D1 binding is a visible server error, not a recorded event', async () => {
  assert.equal(
    (
      await onRequest({
        request: makeRequest(),
        env: withLimiter({ ANALYTICS_ENABLED: '1' }),
      })
    ).status,
    503,
  );
});

test('database errors return 503', async () => {
  assert.equal(
    (
      await onRequest({
        request: makeRequest(),
        env: withLimiter({
          ANALYTICS_ENABLED: '1',
          ANALYTICS_DB: {
            prepare() {
              throw new Error('simulated database failure');
            },
          },
        }),
      })
    ).status,
    503,
  );
});

test('oversized request without Content-Length is rejected before reaching D1', async () => {
  const database = makeDatabase();
  const body = JSON.stringify({ ...sampleEvent, extra: 'x'.repeat(1500) });
  const response = await onRequest({
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': safariUA,
        'cf-connecting-ip': '203.0.113.10',
      },
      body,
    }),
    env: withLimiter({ ANALYTICS_ENABLED: '1', ANALYTICS_DB: database }),
  });
  assert.equal(response.status, 204);
  assert.equal(database.rows.size, 0);
});

test('body limit is enforced even when Content-Length understates the size', async () => {
  const database = makeDatabase();
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': safariUA,
      'cf-connecting-ip': '203.0.113.10',
      'content-length': '100',
    },
    body: JSON.stringify({ ...sampleEvent, extra: 'x'.repeat(1500) }),
  });
  const response = await onRequest({
    request,
    env: withLimiter({ ANALYTICS_ENABLED: '1', ANALYTICS_DB: database }),
  });
  assert.equal(response.status, 204);
  assert.equal(database.rows.size, 0);
});

test('malformed JSON does not reach D1', async () => {
  const database = makeDatabase();
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': safariUA,
      'cf-connecting-ip': '203.0.113.10',
    },
    body: '{not-json',
  });
  assert.equal(
    (
      await onRequest({
        request,
        env: withLimiter({ ANALYTICS_ENABLED: '1', ANALYTICS_DB: database }),
      })
    ).status,
    204,
  );
  assert.equal(database.rows.size, 0);
});

test('streamed oversized request is cancelled without buffering the entire body', async () => {
  const database = makeDatabase();
  let cancelled = false;
  let chunksSent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      chunksSent += 1;
      controller.enqueue(new Uint8Array(600));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': safariUA,
      'cf-connecting-ip': '203.0.113.10',
    },
    body: stream,
    duplex: 'half',
  });
  const response = await onRequest({
    request,
    env: withLimiter({ ANALYTICS_ENABLED: '1', ANALYTICS_DB: database }),
  });
  assert.equal(response.status, 204);
  assert.equal(database.rows.size, 0);
  assert.equal(cancelled, true);
  assert.ok(chunksSent <= 3, `read ${chunksSent} chunks before cancellation`);
});

test('analytics remains disabled when the new flag is absent, even with a legacy flag', async () => {
  const database = makeDatabase();
  const response = await onRequest({
    request: makeRequest(),
    env: { ANALYTICS_EXPERIMENT: '1', ANALYTICS_DB: database },
  });
  assert.equal(response.status, 204);
  assert.equal(database.rows.size, 0);
});

test('ordinary requests do not emit per-event info logs', async () => {
  const database = makeDatabase();
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);
  try {
    const env = withLimiter({ ANALYTICS_ENABLED: '1', ANALYTICS_DB: database });
    await onRequest({ request: makeRequest(), env });
    await onRequest({ request: makeRequest(), env });
    await onRequest({ request: makeRequest(sampleEvent, 'facebookexternalhit/1.1'), env });
    assert.equal(database.rows.size, 1);
    assert.deepEqual(logs, []);
  } finally {
    console.info = originalInfo;
  }
});

test('debug mode logs decisions without recording event IDs', async () => {
  const database = makeDatabase();
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);
  try {
    const env = withLimiter({
      ANALYTICS_ENABLED: '1',
      ANALYTICS_DEBUG: '1',
      ANALYTICS_DB: database,
    });
    await onRequest({ request: makeRequest(), env });
    await onRequest({ request: makeRequest(), env });
    await onRequest({ request: makeRequest(sampleEvent, 'facebookexternalhit/1.1'), env });
    assert.deepEqual(logs, [
      ['[analytics:stored]', 'page_view:threads'],
      ['[analytics:duplicate]', 'page_view:threads'],
      ['[analytics:ignored]', 'known_bot'],
    ]);
    assert.equal(JSON.stringify(logs).includes(sampleEvent.event_id), false);
  } finally {
    console.info = originalInfo;
  }
});

test('rate-limited events return 429 and never reach D1', async () => {
  const database = makeDatabase();
  const response = await onRequest({
    request: makeRequest(),
    env: withLimiter({ ANALYTICS_ENABLED: '1', ANALYTICS_DB: database }, 429),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(database.rows.size, 0);
});

test('enabled analytics fails closed without private limiter binding', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const database = makeDatabase();
    const response = await onRequest({
      request: makeRequest(),
      env: { ANALYTICS_ENABLED: '1', ANALYTICS_DB: database },
    });
    assert.equal(response.status, 503);
    assert.equal(database.rows.size, 0);
  } finally {
    console.error = originalError;
  }
});

test('enabled analytics fails closed without Cloudflare client IP', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const database = makeDatabase();
    const request = makeRequest();
    request.headers.delete('cf-connecting-ip');
    const response = await onRequest({
      request,
      env: withLimiter({ ANALYTICS_ENABLED: '1', ANALYTICS_DB: database }),
    });
    assert.equal(response.status, 503);
    assert.equal(database.rows.size, 0);
  } finally {
    console.error = originalError;
  }
});
