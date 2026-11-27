import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Browser } from './lib/http.mjs';
import { auth, email, password, signup, verified, signin } from './lib/fixtures.mjs';
import { messageIds, waitForCode } from './lib/mail.mjs';
import { error, status } from './lib/assert.mjs';

test('signup, verification and session', async () => {
  const account = await verified();
  assert.equal(status(await account.browser.get(`${auth}/session`), 200).json.data.user.email, account.address);
  assert.ok(account.token);
  assert.match(account.signupToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!account.browser.jar.cookies.has('signup'));
});
test('wrong password and unknown email are indistinguishable', async t => {
  const account = await verified(), browser = new Browser(), times = [[], []], errors = [];
  for (let iteration = 0; iteration < 3; iteration++) for (let kind = 0; kind < 2; kind++) {
    const start = performance.now();
    const response = await browser.post(`${auth}/signin`, { email: kind ? email() : account.address, password: 'wrong password' });
    times[kind].push(performance.now() - start);
    errors.push(error(response, 401, 'INVALID_CREDENTIALS'));
  }
  for (const item of errors) assert.deepEqual([item.code, item.message], [errors[0].code, errors[0].message]);
  const means = times.map(values => values.reduce((sum, value) => sum + value, 0) / values.length);
  t.diagnostic(`wrong-password mean ${means[0].toFixed(1)}ms; unknown-email mean ${means[1].toFixed(1)}ms`);
  assert.ok(Math.abs(means[0] - means[1]) <= 250);
});
test('duplicate signup never authenticates the attacker', async () => {
  const account = await verified(), attacker = new Browser();
  const result = status(await attacker.post(`${auth}/signup`, { name: 'Probe', email: account.address, password }), 202);
  assert.equal(result.json.data.status, 'verification_sent');
  assert.equal(status(await attacker.get(`${auth}/session`), 200).json.data.user, null);
});
test('unverified sign-in is indistinguishable from wrong password', async () => {
  const account = await signup();
  await waitForCode(account.address, account.before);
  const before = await messageIds(account.address);
  const first = error(await account.browser.post(`${auth}/signin`, { email: account.address, password }), 401, 'INVALID_CREDENTIALS');
  const second = error(await account.browser.post(`${auth}/signin`, { email: email(), password: 'wrong password' }), 401, 'INVALID_CREDENTIALS');
  assert.deepEqual([first.code, first.message], [second.code, second.message]);
  assert.deepEqual(await messageIds(account.address), before);
});
test('owner second signup commits owner credentials', async () => {
  const attacker = await signup({ secret: 'Attacker password 957!' });
  await waitForCode(attacker.address, attacker.before);
  const owner = await verified({ address: attacker.address, secret: 'Owner password 863!' });
  status(await new Browser().post(`${auth}/signin`, { email: owner.address, password: owner.secret }), 200);
  error(await new Browser().post(`${auth}/signin`, { email: owner.address, password: attacker.secret }), 401, 'INVALID_CREDENTIALS');
  error(await attacker.browser.post(`${auth}/verify-email`, { email: attacker.address, code: owner.code, signupToken: attacker.signupToken }), 401, 'INVALID_CODE');
});
test('five wrong codes invalidate the sixth correct attempt', async () => {
  const account = await signup(), code = await waitForCode(account.address, account.before);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let count = 0; count < 5; count++) error(await account.browser.post(`${auth}/verify-email`, { email: account.address, code: wrong }), 401, 'INVALID_CODE');
  error(await account.browser.post(`${auth}/verify-email`, { email: account.address, code }), 401, 'INVALID_CODE');
});
test('verification code cannot be reused', async () => {
  const account = await verified();
  error(await new Browser().post(`${auth}/verify-email`, { email: account.address, code: account.code, signupToken: account.signupToken }), 401, 'INVALID_CODE');
});
test('password reset revokes sessions and grants are single-use', async () => {
  const account = await verified(), oldCookie = account.browser.jar.header(), before = await messageIds(account.address);
  status(await account.browser.post(`${auth}/password/forgot`, { email: email() }), 202);
  status(await account.browser.post(`${auth}/password/forgot`, { email: account.address }), 202);
  const code = await waitForCode(account.address, before);
  const grant = status(await account.browser.post(`${auth}/password/verify-code`, { email: account.address, code }), 200).json.data.resetToken;
  const next = 'New password 725!';
  status(await account.browser.post(`${auth}/password/reset`, { password: next, resetToken: grant }), 200);
  error(await new Browser().get('/api/v1/me', { headers: { cookie: oldCookie } }), 401, 'UNAUTHENTICATED');
  status(await new Browser().post(`${auth}/signin`, { email: account.address, password: next }), 200);
  error(await new Browser().post(`${auth}/password/reset`, { password: next, resetToken: grant }), 401, 'INVALID_CODE');
});
test('password policy counts characters and rejects weak values', async () => {
  const browser = new Browser();
  for (const secret of ['1234567', 'x'.repeat(129)]) error(await browser.post(`${auth}/signup`, { name: 'Probe', email: email(), password: secret }), 422, 'WEAK_PASSWORD');
  const address = email();
  error(await browser.post(`${auth}/signup`, { name: 'Probe', email: address, password: address }), 422, 'WEAK_PASSWORD');
  // Eight multi-byte characters pass the length rule; a random suffix keeps it out of breach lists.
  await verified({ secret: `éèêë${randomUUID().slice(0, 4)}` });
});
test('signout invalidates replayed cookies', async () => {
  const account = await verified(), cookie = account.browser.jar.header();
  status(await account.browser.post(`${auth}/signout`), 204);
  error(await new Browser().get('/api/v1/me', { headers: { cookie } }), 401, 'UNAUTHENTICATED');
});
test('signout-all revokes another browser', async () => {
  const account = await verified(), other = await signin(account);
  status(await account.browser.post(`${auth}/signout-all`), 204);
  error(await other.browser.get('/api/v1/me'), 401, 'UNAUTHENTICATED');
});
test('sessions are private and cannot be deleted by another user', async () => {
  const first = await verified(), second = await verified();
  const sessions = status(await first.browser.get(`${auth}/sessions`), 200).json.data;
  const otherSessions = status(await second.browser.get(`${auth}/sessions`), 200).json.data;
  assert.ok(sessions.length && otherSessions.length);
  assert.ok(!sessions.some(session => otherSessions.some(other => session.id === other.id)));
  error(await second.browser.delete(`${auth}/sessions/${sessions[0].id}`), 404, 'NOT_FOUND');
});
test('invalid bearer tokens and basic authentication fail; cookies are anonymous', async () => {
  for (const token of ['garbage', 'a.b.c', 'x'.repeat(5000)]) {
    error(await new Browser().get('/api/v1/me', { headers: { authorization: `Bearer ${token}` } }), 401, 'UNAUTHENTICATED');
    assert.equal(status(await new Browser().get(`${auth}/session`, { headers: { cookie: `session=${token}` } }), 200).json.data.user, null);
  }
  error(await new Browser().get('/api/v1/me', { headers: { authorization: 'Basic Zm9vOmJhcg==' } }), 401, 'UNAUTHENTICATED');
});
test('email is normalized for sign-in', async () => {
  const account = await verified();
  status(await new Browser().post(`${auth}/signin`, { email: `  ${account.address.toUpperCase()}  `, password }), 200);
});
test('SQL-like and unicode emails are rejected cleanly', async () => {
  for (const address of [`a' OR 1=1--@example.test`, '用户@example.test']) {
    error(await new Browser().post(`${auth}/signup`, { name: 'Probe', email: address, password }), 400);
  }
});
