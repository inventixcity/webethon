import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Browser } from './lib/http.mjs';
import { auth, email, password } from './lib/fixtures.mjs';
import { error } from './lib/assert.mjs';
function limited(response) {
  error(response, 429, 'RATE_LIMITED');
  assert.ok(Number(response.headers.get('retry-after')) > 0);
}
test('sign-in account budget returns retry-after', async () => {
  const browser = new Browser(), address = email();
  for (let count = 0; count < 8; count++) error(await browser.post(`${auth}/signin`, { email: address, password }), 401, 'INVALID_CREDENTIALS');
  limited(await browser.post(`${auth}/signin`, { email: address, password }));
});
test('signup per-IP budget returns retry-after', async () => {
  const browser = new Browser();
  let response;
  for (let count = 0; count < 7; count++) {
    response = await browser.post(`${auth}/signup`, { name: 'Probe', email: email(), password });
    if (response.status === 429) break;
    assert.equal(response.status, 202, response.text);
  }
  limited(response);
});
test('verification per-account budget returns retry-after', async () => {
  const browser = new Browser(), address = email();
  const body = { email: address, code: '123456', signupToken: randomBytes(32).toString('base64url') };
  for (let count = 0; count < 6; count++) error(await browser.post(`${auth}/verify-email`, body), 401, 'INVALID_CODE');
  limited(await browser.post(`${auth}/verify-email`, body));
});
