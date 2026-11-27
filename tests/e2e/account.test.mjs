import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from './lib/http.mjs';
import { auth, verified } from './lib/fixtures.mjs';
import { error, status } from './lib/assert.mjs';
test('profile exposes only its documented fields', async () => {
  const { browser } = await verified(), user = status(await browser.get('/api/v1/me'), 200).json.data;
  for (const key of Object.keys(user)) assert.ok(['id', 'email', 'displayName', 'avatarUrl', 'role', 'createdAt'].includes(key), key);
});
test('profile protects role, email, status and validates avatar URLs', async () => {
  const { browser } = await verified();
  for (const field of ['role', 'email', 'status']) error(await browser.patch('/api/v1/me', { [field]: 'admin' }), 400);
  error(await browser.patch('/api/v1/me', { avatarUrl: 'http://example.test/avatar' }), 400);
});
test('account deletion revokes the session and blocks sign-in', async () => {
  const account = await verified();
  status(await account.browser.delete('/api/v1/me'), 204);
  error(await account.browser.get('/api/v1/me'), 401, 'UNAUTHENTICATED');
  error(await new Browser().post(`${auth}/signin`, { email: account.address, password: account.secret }), 401, 'INVALID_CREDENTIALS');
});
