import { isBot } from 'isbot';

export const MAX_BODY_BYTES = 1024;

const allowedEvents = new Set(['page_view', 'telegram_click', 'fanvue_click']);
const allowedSources = new Set(['threads', 'tiktok', 'instagram', 'facebook', 'tg', 'unknown']);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateRequest(request) {
  if (request.method !== 'POST') return 'method_not_allowed';

  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') return 'invalid_content_type';

  const userAgent = request.headers.get('user-agent');
  if (!userAgent?.trim()) return 'missing_user_agent';
  if (isBot(userAgent)) return 'known_bot';

  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return 'origin_mismatch';

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') return 'cross_site';

  const purpose = [
    request.headers.get('sec-purpose'),
    request.headers.get('purpose'),
    request.headers.get('x-purpose'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/\b(prefetch|prerender)\b/.test(purpose)) return 'speculative_request';

  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return 'payload_too_large';

  return null;
}

export function validatePayload(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') return 'invalid_payload';

  const keys = Object.keys(payload);
  if (
    keys.length !== 3 ||
    !['event_id', 'event_type', 'source'].every((key) => keys.includes(key))
  ) {
    return 'unexpected_fields';
  }

  if (typeof payload.event_id !== 'string' || !uuidV4.test(payload.event_id)) {
    return 'invalid_event_id';
  }
  if (!allowedEvents.has(payload.event_type)) return 'invalid_event_type';
  if (!allowedSources.has(payload.source)) return 'invalid_source';

  return null;
}
