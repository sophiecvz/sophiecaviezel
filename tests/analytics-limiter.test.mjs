import test from 'node:test';
import assert from 'node:assert/strict';
import limiter from '../workers/analytics-limiter.js';

const request = (key) =>
  new Request('https://limiter.internal/check', {
    method: 'POST',
    headers: key ? { 'x-analytics-rate-key': key } : {},
  });

test('private limiter accepts allowed requests and never logs a client key', async () => {
  const checked = [];
  const env = {
    EVENT_RATE_LIMIT: {
      async limit(value) {
        checked.push(value);
        return { success: true };
      },
    },
  };
  assert.equal((await limiter.fetch(request('203.0.113.10'), env)).status, 204);
  assert.deepEqual(checked, [{ key: 'events:203.0.113.10' }]);
});

test('private limiter rejects requests over quota', async () => {
  const env = { EVENT_RATE_LIMIT: { limit: async () => ({ success: false }) } };
  assert.equal((await limiter.fetch(request('203.0.113.10'), env)).status, 429);
});

test('private limiter rejects missing keys, other paths, and other methods', async () => {
  let calls = 0;
  const env = {
    EVENT_RATE_LIMIT: {
      limit: async () => {
        calls++;
        return { success: true };
      },
    },
  };
  assert.equal((await limiter.fetch(request(), env)).status, 400);
  assert.equal(
    (await limiter.fetch(new Request('https://limiter.internal/other', { method: 'POST' }), env))
      .status,
    404,
  );
  assert.equal(
    (await limiter.fetch(new Request('https://limiter.internal/check'), env)).status,
    404,
  );
  assert.equal(calls, 0);
});

test('private limiter fails closed when Cloudflare binding is missing', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await limiter.fetch(request('203.0.113.10'), {})).status, 503);
  } finally {
    console.error = originalError;
  }
});
