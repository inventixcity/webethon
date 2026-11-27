import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from './lib/http.mjs';
import { verified } from './lib/fixtures.mjs';

// These are deliberately invalid requests only. See SCRATCH/error-route-inventory.md
// for the remaining route/fixture work; this file does not claim complete L5 coverage.
const api = '/api/v1';
const validationMessage = 'Please check the highlighted fields.';
const internal = /serde|jsonschema|schema validation|sqlx|postgres|syntax error at|database error|line \d+ column \d+|expected (?:a |an )?(?:string|struct|sequence|map)/i;

function envelope(response, status, code) {
  assert.equal(response.status, status, `HTTP ${response.status}: ${response.text}`);
  const e = response.json?.error;
  assert.ok(e && typeof e === 'object', response.text);
  assert.equal(e.code, code);
  assert.equal(typeof e.message, 'string');
  assert.ok(e.message.trim());
  assert.equal(typeof e.requestId, 'string');
  assert.ok(e.requestId.trim());
  assert.doesNotMatch(JSON.stringify(e), internal);
  return e;
}
function validation(response, path, message) {
  const e = envelope(response, 400, 'VALIDATION_FAILED');
  assert.equal(e.message, validationMessage);
  assert.ok(Array.isArray(e.details) && e.details.length, 'expected field details');
  for (const detail of e.details) {
    assert.match(detail.path, /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/);
    assert.equal(typeof detail.message, 'string');
    assert.ok(detail.message.trim());
    assert.doesNotMatch(detail.message, internal);
  }
  const detail = e.details.find(d => d.path === path);
  assert.ok(detail, `missing ${path}: ${JSON.stringify(e.details)}`);
  if (message) assert.equal(detail.message, message);
}
async function send(browser, method, path, raw, headers = {}) {
  return browser.request(path, { method, raw, headers: { 'content-type': 'application/json', ...headers } });
}

test('signup JSON errors use the shared contract', async t => {
  const cases = [
    ['malformed', '{', null, null],
    ['missing name', JSON.stringify({ email: 'probe@example.test', password: 'Correct horse battery 57!' }), 'name', 'This field is required.'],
    ['wrong name type', JSON.stringify({ name: 3, email: 'probe@example.test', password: 'Correct horse battery 57!' }), 'name', 'Must be text.'],
    ['unknown field', JSON.stringify({ name: 'Probe', email: 'probe@example.test', password: 'Correct horse battery 57!', extra: true }), 'extra', "This field isn't allowed."],
    ['oversized name', JSON.stringify({ name: 'x'.repeat(121), email: 'probe@example.test', password: 'Correct horse battery 57!' }), 'name'],
  ];
  for (const [label, raw, path, message] of cases) await t.test(label, async () => {
    const response = await send(new Browser(), 'POST', `${api}/auth/signup`, raw);
    if (path) validation(response, path, message);
    else assert.equal(envelope(response, 400, 'BAD_REQUEST').message, "We couldn't read that request.");
  });
});

test('notes JSON and schema errors use relative field paths', async t => {
  const { browser } = await verified();
  const cases = [
    ['malformed', '{', null],
    ['missing title', JSON.stringify({ data: {} }), 'title', 'This field is required.'],
    ['wrong title type', JSON.stringify({ data: { title: 42 } }), 'title', 'Must be text.'],
    ['unknown data field', JSON.stringify({ data: { title: 'Probe', extra: true } }), 'extra', "This field isn't allowed."],
    ['oversized title', JSON.stringify({ data: { title: 'x'.repeat(201) } }), 'title'],
    ['nested wrong type', JSON.stringify({ data: { title: 'Probe', tags: ['ok', 'ok', 42] } }), 'tags.2', 'Must be text.'],
    ['empty required title', JSON.stringify({ data: { title: '' } }), 'title'],
    ['whitespace required title', JSON.stringify({ data: { title: '   ' } }), 'title'],
  ];
  for (const [label, raw, path, message] of cases) await t.test(label, async () => {
    const response = await send(browser, 'POST', `${api}/entities/notes`, raw);
    if (path) validation(response, path, message);
    else assert.equal(envelope(response, 400, 'BAD_REQUEST').message, "We couldn't read that request.");
  });
});

test('authentication and authorization precede JSON parsing', async t => {
  const anonymous = new Browser();
  const user = await verified();
  for (const [label, browser, method, path, code, status] of [
    ['anonymous note creation', anonymous, 'POST', `${api}/entities/notes`, 'UNAUTHENTICATED', 401],
    ['anonymous account update', anonymous, 'PATCH', `${api}/me`, 'UNAUTHENTICATED', 401],
    ['non-admin role change', user.browser, 'POST', `${api}/admin/users/${user.user.id}/role`, 'FORBIDDEN', 403],
  ]) await t.test(label, async () => {
    const e = envelope(await send(browser, method, path, '{'), status, code);
    assert.ok(!Array.isArray(e.details), 'parse details must not leak before access');
  });
});

test('invalid query and path errors are enveloped', async t => {
  const { browser } = await verified();
  await t.test('query limit', async () => validation(await browser.get(`${api}/entities/notes?limit=abc`), 'limit'));
  await t.test('invalid record id', async () => envelope(await browser.get(`${api}/entities/notes/not-a-uuid`), 404, 'NOT_FOUND'));
});
