// No cookies, visitor IDs, or device fingerprints.
// The destination links work normally even when analytics fails.

const endpoint = '/api/events';
const allowedSources = new Set(['threads', 'tiktok', 'instagram', 'facebook', 'tg']);
const querySource = new URLSearchParams(window.location.search).get('utm_source');
const source = allowedSources.has(querySource) ? querySource : 'unknown';

function sendEvent(eventType) {
  const payload = {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    source,
  };

  const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });

  if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(endpoint, body)) {
    return;
  }

  // Fallback only if the browser could not queue the beacon.
  fetch(endpoint, {
    method: 'POST',
    body,
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => {});
}

// A visible document gets one initial view; each bfcache restoration gets one more.
// Returning from an external app or switching tabs does not create another view.
let viewPending = true;

function maybeSendPageView() {
  if (!viewPending || document.visibilityState !== 'visible' || document.prerendering === true) {
    return;
  }

  viewPending = false;
  sendEvent('page_view');
}

document.addEventListener('visibilitychange', maybeSendPageView);
document.addEventListener('prerenderingchange', maybeSendPageView);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    viewPending = true;
  }
  maybeSendPageView();
});
maybeSendPageView();

for (const [selector, eventType] of [
  ['.profile__link--telegram', 'telegram_click'],
  ['.profile__link--fanvue', 'fanvue_click'],
]) {
  const link = document.querySelector(selector);
  if (!link) continue;

  link.addEventListener('click', (event) => {
    // isTrusted blocks basic synthetic clicks, not automated browsers.
    if (event.isTrusted) sendEvent(eventType);
  });

  link.addEventListener('auxclick', (event) => {
    if (event.button === 1 && event.isTrusted) sendEvent(eventType);
  });
}
