import assert from 'node:assert/strict';

const internals = /serde|jsonschema|schema validation|sqlx|postgres|syntax error at|database error|line \d+ column \d+|expected (?:a |an )?(?:string|struct|sequence|map)|panicked|\/src\//i;
export function envelope(response, status, code) {
  assert.equal(response.status, status, response.text);
  const error = response.json?.error;
  assert.ok(error && typeof error === 'object', response.text);
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.match(error.message, /[A-Za-z]/);
  assert.equal(typeof error.requestId, 'string');
  assert.ok(error.requestId.trim());
  assert.doesNotMatch(JSON.stringify(error), internals);
  return error;
}
export function validation(response, path) {
  const error = envelope(response, 400, 'VALIDATION_FAILED');
  assert.equal(error.message, 'Please check the highlighted fields.');
  assert.ok(Array.isArray(error.details) && error.details.length);
  for (const detail of error.details) {
    assert.match(detail.path, /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/);
    assert.equal(typeof detail.message, 'string');
    assert.match(detail.message, /[A-Za-z]/);
    assert.doesNotMatch(detail.message, internals);
  }
  assert.ok(error.details.some(detail => detail.path === path), JSON.stringify(error.details));
}
export function send(browser, method, path, raw, headers = {}) {
  return browser.request(path, { method, raw, headers: { 'content-type': 'application/json', ...headers } });
}
