import assert from 'node:assert/strict';
export function status(response, expected) { assert.equal(response.status, expected, `HTTP ${response.status}: ${response.text}`); return response; }
export function error(response, expectedStatus, code) {
  status(response, expectedStatus);
  assert.equal(typeof response.json?.error?.message, 'string');
  assert.ok(response.json.error.message);
  assert.equal(typeof response.json.error.requestId, 'string');
  assert.ok(response.json.error.requestId);
  if (code) assert.equal(response.json.error.code, code);
  return response.json.error;
}
