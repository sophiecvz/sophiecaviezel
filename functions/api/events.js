import {
  MAX_BODY_BYTES,
  validatePayload,
  validateRequest,
} from '../../lib/analytics/validate-event.js';

const headers = { 'cache-control': 'no-store' };
const noContent = () => new Response(null, { status: 204, headers });
const unavailable = () => new Response('Analytics service unavailable', { status: 503, headers });
const limited = () =>
  new Response(null, {
    status: 429,
    headers: { ...headers, 'retry-after': '60' },
  });
const logDebug = (env, kind, detail) => {
  if (env.ANALYTICS_DEBUG === '1') console.info(`[analytics:${kind}]`, detail);
};

async function readPayload(request) {
  if (!request.body) return { error: 'invalid_json' };

  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (size + value.byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: 'payload_too_large' };
      }

      bytes.set(value, size);
      size += value.byteLength;
    }

    return {
      payload: JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
      ),
    };
  } catch {
    return { error: 'invalid_json' };
  } finally {
    reader.releaseLock();
  }
}

async function checkRateLimit(request, env) {
  // CF-Connecting-IP is supplied by Cloudflare; no IP is written to analytics D1.
  const clientIp = request.headers.get('cf-connecting-ip');
  if (!clientIp || typeof env.ANALYTICS_LIMITER?.fetch !== 'function') {
    console.error('[analytics:error] rate_limiter_unavailable');
    return unavailable();
  }

  try {
    const decision = await env.ANALYTICS_LIMITER.fetch('https://limiter.internal/check', {
      method: 'POST',
      headers: { 'x-analytics-rate-key': clientIp },
    });

    if (decision.status === 204) return null;
    if (decision.status === 429) {
      logDebug(env, 'rate_limited', 'request');
      return limited();
    }

    console.error('[analytics:error] rate_limiter_bad_response', decision.status);
    return unavailable();
  } catch (error) {
    console.error('[analytics:error] rate_limiter_failed', error);
    return unavailable();
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }

  // The endpoint stays disabled until the environment explicitly enables analytics.
  if (env.ANALYTICS_ENABLED !== '1') return noContent();

  const requestError = validateRequest(request);
  if (requestError) {
    logDebug(env, 'ignored', requestError);
    return noContent();
  }

  const rateLimitResponse = await checkRateLimit(request, env);
  if (rateLimitResponse) return rateLimitResponse;

  const { payload, error } = await readPayload(request);
  if (error) {
    logDebug(env, 'ignored', error);
    return noContent();
  }

  const payloadError = validatePayload(payload);
  if (payloadError) {
    logDebug(env, 'ignored', payloadError);
    return noContent();
  }

  if (typeof env.ANALYTICS_DB?.prepare !== 'function') {
    console.error('[analytics:error] missing_d1_binding');
    return unavailable();
  }

  try {
    const result = await env.ANALYTICS_DB.prepare(
      `INSERT INTO events (event_id, event_type, source)
       VALUES (?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    )
      .bind(payload.event_id, payload.event_type, payload.source)
      .run();

    // The unique event_id constraint makes retries idempotent across Worker instances.
    const kind = result.meta?.changes === 0 ? 'duplicate' : 'stored';
    logDebug(env, kind, `${payload.event_type}:${payload.source}`);
    return noContent();
  } catch (error) {
    console.error('[analytics:error] d1_write_failed', error);
    return unavailable();
  }
}
