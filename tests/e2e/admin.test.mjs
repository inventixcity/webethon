import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from './lib/http.mjs';
import { auth, signin, verified } from './lib/fixtures.mjs';
import { error, status } from './lib/assert.mjs';
import { adminSignin, enabled, needsStepUp, noSecrets, root, stepUp, totp } from './lib/admin-fixture.mjs';

test('admin routes reject non-admins and unknown routes do not expose privileged APIs', async () => {
  const user = await verified();
  for (const path of ['/users', '/audit', '/overview', '/stats', '/system']) error(await user.browser.get(root + path), 403, 'FORBIDDEN');
  error(await user.browser.post(`${root}/users/${user.user.id}/suspend`), 403, 'FORBIDDEN');
  error(await user.browser.post(`${root}/step-up`, { password: user.secret }), 403, 'FORBIDDEN');
  assert.equal((await user.browser.get(`${root}/does-not-exist`)).status, 404);
  assert.equal((await user.browser.post(`${root}/users/${user.user.id}/impersonate`)).status, 404);
  assert.equal((await user.browser.post(`${root}/payments/refund`, {})).status, 404);
});

test('session-bound step-up, self protections, and session revocation', { skip: !enabled }, async () => {
  const admin = await adminSignin(), otherSession = await adminSignin(), target = await verified();
  needsStepUp(await admin.browser.post(`${root}/users/${target.user.id}/suspend`));
  error(await admin.browser.post(`${root}/step-up`, { password: 'incorrect password' }), 401, 'INVALID_CREDENTIALS');
  await stepUp(admin);
  needsStepUp(await otherSession.browser.post(`${root}/users/${target.user.id}/suspend`));
  for (const [path, body] of [['role', { role: 'user' }], ['suspend'], ['unsuspend'], ['mfa/reset']]) {
    error(await admin.browser.post(`${root}/users/${admin.user.id}/${path}`, body), 403, 'FORBIDDEN');
  }
  const legacy = await otherSession.browser.patch(`${root}/users/${target.user.id}`, { status: 'suspended' });
  assert.ok([404, 405, 428].includes(legacy.status));
  status(await admin.browser.post(`${root}/users/${target.user.id}/suspend`), 204);
  error(await target.browser.get('/api/v1/me'), 401, 'UNAUTHENTICATED');
  status(await admin.browser.post(`${root}/users/${target.user.id}/unsuspend`), 204);
  error(await target.browser.get('/api/v1/me'), 401, 'UNAUTHENTICATED');
  const restored = await signin(target);
  status(await admin.browser.post(`${root}/users/${target.user.id}/sessions/revoke`), 204);
  error(await restored.browser.get('/api/v1/me'), 401, 'UNAUTHENTICATED');
  const detail = status(await admin.browser.get(`${root}/users/${target.user.id}`), 200).json.data;
  assert.equal(detail.user.id, target.user.id);
  for (const key of ['sessions', 'audit', 'teams', 'files', 'entitlements']) { assert.ok(Array.isArray(detail[key])); assert.ok(detail[key].length <= 50); }
  assert.ok(detail.sessions.length > 0);
  noSecrets(detail);
  assert.ok(detail.audit.some(event => event.action === 'admin.user.suspend'));
  assert.ok(detail.audit.some(event => event.action === 'admin.user.unsuspend'));
});

test('user filters, cursor pagination, and validation use bounded values', { skip: !enabled }, async () => {
  const admin = await adminSignin(), target = await verified();
  const list = status(await admin.browser.get(`${root}/users?q=${encodeURIComponent(target.address)}&role=user&status=active&verified=true&mfa=false&sort=newest&limit=1`), 200).json;
  assert.equal(list.data.length, 1); assert.equal(list.data[0].id, target.user.id);
  assert.ok(Object.hasOwn(list.meta, 'nextCursor'));
  const first = status(await admin.browser.get(`${root}/users?limit=1&sort=newest`), 200).json;
  assert.equal(first.data.length, 1);
  assert.ok(first.meta.nextCursor);
  const second = status(await admin.browser.get(`${root}/users?limit=1&sort=newest&cursor=${encodeURIComponent(first.meta.nextCursor)}`), 200).json;
  assert.equal(second.data.length, 1); assert.notEqual(first.data[0].id, second.data[0].id);
  for (const query of ['limit=0', 'limit=101', 'sort=id%20desc', 'role=admin%27%20OR%20true--', 'cursor=not-a-uuid', 'verified=maybe', 'unknown=value']) {
    error(await admin.browser.get(`${root}/users?${query}`), 400, 'VALIDATION_FAILED');
  }
  const literal = status(await admin.browser.get(`${root}/users?q=${encodeURIComponent("' OR true --")}`), 200).json;
  assert.deepEqual(literal.data, []);
});

test('a promoted administrator needs TOTP for step-up and revocation invalidates its session', { skip: !enabled }, async () => {
  const admin = await adminSignin(), account = await verified(), target = await verified();
  await stepUp(admin);
  status(await admin.browser.post(`${root}/users/${account.user.id}/role`, { role: 'admin' }), 204);
  const promoted = await signin(account);
  const setupResponse = await promoted.browser.post(`${auth}/mfa/totp/setup`, { currentPassword: account.secret });
  assert.equal(setupResponse.status, 200, 'MFA setup failed');
  const secret = setupResponse.json.data.secret;
  const enableResponse = await promoted.browser.post(`${auth}/mfa/totp/enable`, { code: totp(secret) });
  assert.equal(enableResponse.status, 200, 'MFA enable failed');
  const recoveryCode = enableResponse.json.data.recoveryCodes[0];
  const mfaAdmin = { browser: promoted.browser, secret: account.secret };
  needsStepUp(await mfaAdmin.browser.post(`${root}/users/${target.user.id}/suspend`));
  assert.notEqual((await mfaAdmin.browser.post(`${root}/step-up`, { password: account.secret })).status, 200);
  assert.notEqual((await mfaAdmin.browser.post(`${root}/step-up`, { password: account.secret, code: recoveryCode })).status, 200);
  await stepUp(mfaAdmin, totp(secret, 1));
  status(await admin.browser.post(`${root}/users/${account.user.id}/sessions/revoke`), 204);
  error(await mfaAdmin.browser.post(`${root}/users/${target.user.id}/suspend`), 401, 'UNAUTHENTICATED');
  status(await admin.browser.post(`${root}/users/${account.user.id}/mfa/reset`), 204);
  status(await admin.browser.post(`${root}/users/${account.user.id}/role`, { role: 'user' }), 204);
});

