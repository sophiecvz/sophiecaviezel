import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../src/analytics.js', import.meta.url), 'utf8');

function startPage({
  search = '?utm_source=threads',
  visibilityState = 'visible',
  prerendering = false,
  beaconQueued = true,
} = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const linkListeners = new Map();
  const beacons = [];
  const fetches = [];
  let eventNumber = 0;

  for (const selector of ['.profile__link--telegram', '.profile__link--fanvue']) {
    linkListeners.set(selector, new Map());
  }

  const document = {
    visibilityState,
    prerendering,
    addEventListener(name, callback) {
      documentListeners.set(name, callback);
    },
    querySelector(selector) {
      const listeners = linkListeners.get(selector);
      return listeners
        ? {
            addEventListener(name, callback) {
              listeners.set(name, callback);
            },
          }
        : null;
    },
  };
  const window = {
    location: { search },
    addEventListener(name, callback) {
      windowListeners.set(name, callback);
    },
  };

  runInNewContext(script, {
    document,
    window,
    navigator: {
      sendBeacon(path, body) {
        beacons.push({ path, body });
        return beaconQueued;
      },
    },
    fetch(path, options) {
      fetches.push({ path, options });
      return Promise.resolve();
    },
    crypto: {
      randomUUID() {
        eventNumber += 1;
        return `00000000-0000-4000-8000-${String(eventNumber).padStart(12, '0')}`;
      },
    },
    Blob,
    URLSearchParams,
  });

  return {
    document,
    beacons,
    fetches,
    emitDocument(name) {
      documentListeners.get(name)?.();
    },
    emitWindow(name, event) {
      windowListeners.get(name)?.(event);
    },
    emitLink(selector, name, event) {
      linkListeners.get(selector)?.get(name)?.(event);
    },
    async events() {
      return Promise.all(beacons.map(async ({ body }) => JSON.parse(await body.text())));
    },
  };
}

test('one visible page view is sent without counting tab switches', async () => {
  const page = startPage();
  page.document.visibilityState = 'hidden';
  page.emitDocument('visibilitychange');
  page.document.visibilityState = 'visible';
  page.emitDocument('visibilitychange');
  assert.deepEqual(
    (await page.events()).map((event) => event.event_type),
    ['page_view'],
  );
});

test('hidden page sends its first view only after becoming visible', async () => {
  const page = startPage({ visibilityState: 'hidden' });
  assert.equal(page.beacons.length, 0);
  page.document.visibilityState = 'visible';
  page.emitDocument('visibilitychange');
  assert.equal(page.beacons.length, 1);
});

test('prerendered page waits for activation', async () => {
  const page = startPage({ prerendering: true });
  assert.equal(page.beacons.length, 0);
  page.document.prerendering = false;
  page.emitDocument('prerenderingchange');
  assert.equal(page.beacons.length, 1);
});

test('bfcache restoration registers a new view but a normal pageshow does not', async () => {
  const page = startPage();
  page.emitWindow('pageshow', { persisted: false });
  assert.equal(page.beacons.length, 1);
  page.emitWindow('pageshow', { persisted: true });
  assert.deepEqual(
    (await page.events()).map((event) => event.event_type),
    ['page_view', 'page_view'],
  );
});

test('trusted CTA clicks are sent independently with unique event IDs', async () => {
  const page = startPage();
  page.emitLink('.profile__link--telegram', 'click', { isTrusted: true });
  page.emitLink('.profile__link--fanvue', 'click', { isTrusted: true });
  const events = await page.events();
  assert.deepEqual(
    events.map((event) => event.event_type),
    ['page_view', 'telegram_click', 'fanvue_click'],
  );
  assert.equal(new Set(events.map((event) => event.event_id)).size, 3);
  assert.ok(
    page.beacons.every(
      ({ path, body }) => path === '/api/events' && body.type === 'application/json',
    ),
  );
});

test('synthetic clicks are ignored and trusted middle clicks are tracked', async () => {
  const page = startPage();
  page.emitLink('.profile__link--telegram', 'click', { isTrusted: false });
  page.emitLink('.profile__link--telegram', 'auxclick', { isTrusted: true, button: 2 });
  page.emitLink('.profile__link--telegram', 'auxclick', { isTrusted: true, button: 1 });
  assert.deepEqual(
    (await page.events()).map((event) => event.event_type),
    ['page_view', 'telegram_click'],
  );
});

test('missing and unsupported UTM sources are recorded as unknown', async () => {
  for (const search of ['', '?utm_source=chatgpt.com', '?utm_source=THREADS']) {
    const page = startPage({ search });
    assert.equal((await page.events())[0].source, 'unknown');
  }
});

test('approved marketing sources are preserved', async () => {
  for (const source of ['threads', 'tiktok', 'instagram', 'facebook', 'tg']) {
    const page = startPage({ search: `?utm_source=${source}` });
    assert.equal((await page.events())[0].source, source);
  }
});

test('fetch keepalive is used only when sendBeacon cannot queue the event', async () => {
  const queued = startPage();
  assert.equal(queued.fetches.length, 0);
  const fallback = startPage({ beaconQueued: false });
  assert.equal(fallback.beacons.length, 1);
  assert.equal(fallback.fetches.length, 1);
  assert.equal(fallback.fetches[0].path, '/api/events');
  assert.equal(fallback.fetches[0].options.method, 'POST');
  assert.equal(fallback.fetches[0].options.keepalive, true);
  assert.equal(fallback.fetches[0].options.credentials, 'same-origin');
});
