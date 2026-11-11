import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, validateRequest } from '../lib/analytics/validate-event.js';

const endpoint = 'http://localhost:8788/api/events';
const safariUA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// Representative mobile-browser strings, not real traffic captures.
const mobileAppAgents = {
  'Threads iOS':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Threads/350.0',
  'Threads Android':
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Threads/350.0',
  'TikTok iOS':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_35.0.2',
  'TikTok Android':
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 musical_ly_35.0.2',
};
const payload = {
  event_id: '9f37f8b0-b746-4772-8146-d1cd12f42d4d',
  event_type: 'page_view',
  source: 'threads',
};
const makeRequest = (headers = {}, method = 'POST') =>
  new Request(endpoint, {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': safariUA, ...headers },
  });

test('accepts a regular Safari-like request', () => {
  assert.equal(validateRequest(makeRequest()), null);
});
test('accepts representative Threads and TikTok mobile user-agents', () => {
  for (const [label, ua] of Object.entries(mobileAppAgents)) {
    assert.equal(validateRequest(makeRequest({ 'user-agent': ua })), null, label);
  }
});
test('rejects known crawlers', () => {
  for (const ua of [
    'Googlebot/2.1',
    'facebookexternalhit/1.1',
    'TikTokSpider/1.0',
    'bingbot/2.0',
  ]) {
    assert.equal(validateRequest(makeRequest({ 'user-agent': ua })), 'known_bot', ua);
  }
});
test('rejects absent user-agent', () => {
  assert.equal(validateRequest(makeRequest({ 'user-agent': '' })), 'missing_user_agent');
});
test('rejects speculative requests', () => {
  assert.equal(
    validateRequest(makeRequest({ 'sec-purpose': 'prefetch;prerender' })),
    'speculative_request',
  );
});
test('rejects cross-origin browser calls', () => {
  assert.equal(validateRequest(makeRequest({ origin: 'https://example.com' })), 'origin_mismatch');
  assert.equal(validateRequest(makeRequest({ 'sec-fetch-site': 'cross-site' })), 'cross_site');
});
test('accepts a valid event payload', () => {
  assert.equal(validatePayload(payload), null);
  assert.equal(validatePayload({ ...payload, source: 'tg' }), null);
});
test('rejects missing or malformed event properties', () => {
  assert.equal(validatePayload({ ...payload, source: 'hacker' }), 'invalid_source');
  assert.equal(validatePayload({ ...payload, event_type: 'purchase' }), 'invalid_event_type');
  assert.equal(validatePayload({ ...payload, event_id: 'not-a-uuid' }), 'invalid_event_id');
  assert.equal(validatePayload({ ...payload, visitor_id: 'abc' }), 'unexpected_fields');
});

test('rejects an advertised body larger than the limit', () => {
  assert.equal(validateRequest(makeRequest({ 'content-length': '1025' })), 'payload_too_large');
});
