import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from './lib/http.mjs';
import { verified, password, email } from './lib/fixtures.mjs';
import { envelope, validation, send } from './lib/error-contract.mjs';

const api = '/api/v1';
const id = '00000000-0000-4000-8000-000000000001';
// Inputs are syntactically valid until the one named field is mutated; no valid write is sent.
const routes = [
  ['POST', '/auth/signin', { email: 'probe@example.test', password }, 'email', false],
  ['POST', '/auth/verify-email', { email: 'probe@example.test', code: '123456' }, 'email', false],
  ['POST', '/auth/resend-code', { email: 'probe@example.test', purpose: 'signup' }, 'email', false],
  ['POST', '/auth/password/forgot', { email: 'probe@example.test' }, 'email', false],
  ['POST', '/auth/password/verify-code', { email: 'probe@example.test', code: '123456' }, 'email', false],
  ['POST', '/auth/password/reset', { password }, 'password', false],
  ['POST', '/auth/password/change', { currentPassword: password, newPassword: password }, 'currentPassword', true],
  ['POST', '/auth/mfa/totp/setup', { currentPassword: password }, 'currentPassword', true],
  ['POST', '/auth/mfa/totp/enable', { code: '123456' }, 'code', true],
  ['POST', '/auth/mfa/totp/disable', { currentPassword: password, code: '123456' }, 'currentPassword', true],
  ['POST', '/auth/mfa/recovery-codes', { currentPassword: password, code: '123456' }, 'currentPassword', true],
  ['POST', '/auth/mfa/verify', { mfaToken: 'probe' }, 'mfaToken', false],
  ['POST', '/teams', { name: 'Probe' }, 'name', true],
  ['POST', '/teams/invites/accept', { token: 'probe' }, 'token', true],
  ['POST', '/billing/checkout', { productId: 'probe' }, 'productId', true],
  ['POST', '/assist/search', { entity: 'notes', query: 'probe' }, 'query', true],
  ['POST', '/assist/ask', { question: 'probe' }, 'question', true],
  ['POST', `/entities/notes/${id}/comments`, { body: 'probe' }, 'body', true],
  ['PATCH', `/comments/${id}`, { body: 'probe' }, 'body', true],
  ['PATCH', `/files/${id}`, { visibility: 'private' }, 'visibility', true],
];

test('domain JSON decoding returns the common error contract', async t => {
  const { browser } = await verified();
  const anonymous = new Browser();
  for (const [method, path, body, field, authenticated] of routes) {
    const client = authenticated ? browser : anonymous;
    const missing = { ...body }; delete missing[field];
    const variants = [
      ['malformed', '{', null],
      ['missing', JSON.stringify(missing), field],
      ['wrong type', JSON.stringify({ ...body, [field]: 42 }), field],
      ['unknown', JSON.stringify({ ...body, extra: true }), 'extra'],
    ];
    for (const [label, raw, expected] of variants) await t.test(`${method} ${path} ${label}`, async () => {
      const response = await send(client, method, api + path, raw);
      if (expected) validation(response, expected);
      else assert.equal(envelope(response, 400, 'BAD_REQUEST').message, "We couldn't read that request.");
    });
  }
});

test('oversized domain fields and optional-body DTOs', async t => {
  const { browser } = await verified();
  for (const [method, path, body, field] of [
    ['POST', '/teams', { name: 'x'.repeat(1000) }, 'name'],
    ['POST', '/billing/checkout', { productId: 'x'.repeat(1000) }, 'productId'],
    ['POST', `/entities/notes/${id}/comments`, { body: 'x'.repeat(2001) }, 'body'],
    ['PATCH', '/me', { displayName: 'x'.repeat(1000) }, 'displayName'],
    ['POST', '/booking/resources', { name: 'x'.repeat(1000), timezone: 'UTC', slotMinutes: 30, capacity: 1, visibility: 'private' }, 'name'],
    ['POST', '/places', { name: 'x'.repeat(1000), lat: 0, lng: 0 }, 'name'],
  ]) await t.test(`${method} ${path}`, async () => validation(await send(browser, method, api + path, JSON.stringify(body)), field));
  for (const [method, path, body, field] of [
    ['PATCH', '/me', { displayName: 3 }, 'displayName'],
    ['POST', '/booking/resources', { name: 3 }, 'name'],
    ['POST', '/places', { name: 3 }, 'name'],
    ['PUT', '/onboarding', { completed: 3 }, 'completed'],
    ['POST', '/notifications/read', { all: 3 }, 'all'],
  ]) await t.test(`${method} ${path} wrong type`, async () => validation(await send(browser, method, api + path, JSON.stringify(body)), field));
});

test('transport, route and retry errors use safe envelopes', async t => {
  const { browser } = await verified();
  await t.test('unknown route', async () => envelope(await browser.get(`${api}/not-a-route`), 404, 'NOT_FOUND'));
  await t.test('wrong method', async () => envelope(await browser.request(`${api}/health`, { method: 'POST' }), 405, 'METHOD_NOT_ALLOWED'));
  await t.test('JSON MIME', async () => envelope(await send(browser, 'POST', `${api}/teams`, 'hello', { 'content-type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'));
  await t.test('JSON size', async () => envelope(await send(browser, 'POST', `${api}/entities/notes`, JSON.stringify({ data: { title: 'x'.repeat(2 * 1024 * 1024) } })), 413, 'PAYLOAD_TOO_LARGE'));
  await t.test('multipart MIME', async () => envelope(await send(browser, 'POST', `${api}/files`, 'hello', { 'content-type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'));
  await t.test('multipart missing file', async () => validation(await browser.request(`${api}/files`, { method: 'POST', raw: '--probe--\r\n', headers: { 'content-type': 'multipart/form-data; boundary=probe' } }), 'file'));
  await t.test('multipart size', async () => envelope(await browser.request(`${api}/files`, { method: 'POST', raw: `--probe\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\n${'x'.repeat(4 * 1024 * 1024)}\r\n--probe--\r\n`, headers: { 'content-type': 'multipart/form-data; boundary=probe' } }), 413, 'PAYLOAD_TOO_LARGE'));
  await t.test('invalid record path', async () => envelope(await browser.get(`${api}/entities/notes/not-a-uuid`), 404, 'NOT_FOUND'));
  await t.test('invalid query', async () => validation(await browser.get(`${api}/entities/notes?limit=abc`), 'limit'));
  await t.test('rate limit retry header', async () => {
    const client = new Browser(), address = email();
    for (let i = 0; i < 8; i++) envelope(await client.post(`${api}/auth/signin`, { email: address, password }), 401, 'INVALID_CREDENTIALS');
    const response = await client.post(`${api}/auth/signin`, { email: address, password });
    envelope(response, 429, 'RATE_LIMITED');
    assert.match(response.headers.get('retry-after') ?? '', /^\d+$/);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
  });
});
