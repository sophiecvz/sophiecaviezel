import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
const lines = file.trimEnd().split(/\r?\n/);
const headers = new Map(
  lines.slice(1).map((line) => {
    const match = /^\s+([^:]+):\s+(.+)$/.exec(line);
    assert.ok(match, `Malformed _headers line: ${line}`);
    return [match[1].toLowerCase(), match[2]];
  }),
);

function cspDirectives() {
  return new Map(
    headers
      .get('content-security-policy')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values.join(' ')];
      }),
  );
}

test('security headers apply to all static Pages routes', () => {
  assert.equal(lines[0], '/*');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(
    headers.get('permissions-policy'),
    'camera=(), microphone=(), geolocation=(), payment=()',
  );
});

test('CSP allows the same-origin analytics request without permitting inline scripts', () => {
  const directives = cspDirectives();
  for (const [name, expected] of Object.entries({
    'default-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'none'",
    'frame-ancestors': "'none'",
    'object-src': "'none'",
    'script-src': "'self'",
    'style-src': "'self'",
    'connect-src': "'self'",
    'font-src': "'self'",
  })) {
    assert.equal(directives.get(name), expected, `Unexpected ${name}`);
  }
  assert.equal(directives.get('img-src'), "'self' data:");
  assert.ok(directives.has('upgrade-insecure-requests'));
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(headers.get('content-security-policy')));
});
