import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from './lib/http.mjs';
import { verified } from './lib/fixtures.mjs';
import { error, status } from './lib/assert.mjs';
const path = '/api/v1/entities/notes';
function headers(response) {
  for (const [name, value] of Object.entries({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': `default-src 'none'; frame-ancestors 'none'`, 'cross-origin-resource-policy': 'same-origin' })) assert.equal(response.headers.get(name), value, name);
  assert.ok(response.headers.get('x-request-id'));
}
test('security headers and request IDs cover success and errors', async () => {
  const browser = new Browser();
  for (const response of [await browser.get('/api/v1/health'), await browser.get('/api/v1/no-such-route'), await browser.post(path, undefined, { raw: '{', headers: { 'content-type': 'application/json' } })]) {
    headers(response);
    assert.doesNotMatch(response.text, /panicked|sqlx|SELECT|\/src\//i);
  }
  const bad = 'x'.repeat(500), response = await browser.get('/api/v1/health', { headers: { 'x-request-id': bad } });
  assert.notEqual(response.headers.get('x-request-id'), bad);
});
test('body types, limits, malformed and deeply nested JSON are rejected', async () => {
  const { browser } = await verified();
  error(await browser.post(path, undefined, { raw: 'hello', headers: { 'content-type': 'text/plain' } }), 415);
  error(await browser.post(path, { data: { title: 'x'.repeat(2 * 1024 * 1024) } }), 413);
  error(await browser.post(path, undefined, { raw: '{', headers: { 'content-type': 'application/json' } }), 400);
  let nested = '0';
  for (let index = 0; index < 64; index++) nested = `[${nested}]`;
  error(await browser.post(path, undefined, { raw: nested, headers: { 'content-type': 'application/json' } }), 400);
});
test('prototype keys cannot pollute server behavior', async () => {
  const { browser } = await verified();
  const response = await browser.post(path, undefined, { raw: '{\u0022data\u0022:{\u0022title\u0022:\u0022Probe\u0022,\u0022__proto__\u0022:{\u0022polluted\u0022:true}}}', headers: { 'content-type': 'application/json' } });
  assert.ok([201, 400].includes(response.status), response.text);
  if (response.status === 201) assert.equal(response.json.data.data.polluted, undefined);
  assert.equal({}.polluted, undefined);
});
test('cross-site cookie writes fail while bearer writes pass', async () => {
  const account = await verified(), cross = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
  error(await account.browser.post(path, { data: { title: 'Cookie' } }, { headers: cross }), 403, 'CSRF_REJECTED');
  status(await account.browser.post(path, { data: { title: 'Bearer' } }, { cookies: false, headers: { ...cross, authorization: `Bearer ${account.token}` } }), 201);
});
test('unknown routes and wrong methods use safe JSON envelopes', async () => {
  const browser = new Browser();
  for (const [response, expected] of [[await browser.get('/api/v1/no-such-route'), 404], [await browser.request('/api/v1/health', { method: 'POST' }), 405]]) {
    error(response, expected);
    assert.doesNotMatch(response.text, /panicked|sqlx|SELECT|\/src\//i);
  }
});
