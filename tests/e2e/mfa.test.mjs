import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Browser } from './lib/http.mjs';
import { auth, password, signin, verified } from './lib/fixtures.mjs';
import { error, status } from './lib/assert.mjs';
import { messageIds, waitForCode } from './lib/mail.mjs';

function totp(secret, offset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.toUpperCase().replace(/=+$/, '')].map(character => {
    const value = alphabet.indexOf(character);
    assert.ok(value >= 0, 'Setup must return a base32 secret');
    return value.toString(2).padStart(5, '0');
  }).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const digest = createHmac('sha1', key).update(counter).digest();
  const index = digest.at(-1) & 15;
  return String((digest.readUInt32BE(index) & 0x7fffffff) % 1000000).padStart(6, '0');
}

async function enable(account) {
  const setup = status(await account.browser.post(`${auth}/mfa/totp/setup`, { currentPassword: account.secret }), 200).json.data;
  assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.match(setup.qrSvg, /<svg[\s>]/);
  const code = totp(setup.secret);
  const response = status(await account.browser.post(`${auth}/mfa/totp/enable`, { code }), 200);
  assert.equal(response.json.data.recoveryCodes.length, 10);
  assert.equal(new Set(response.json.data.recoveryCodes).size, 10);
  return { ...setup, code, recoveryCodes: response.json.data.recoveryCodes };
}

async function challenge(account, browser = new Browser()) {
  const response = await browser.post(`${auth}/signin`, { email: account.address, password: account.secret });
  const details = error(response, 403, 'MFA_REQUIRED').details;
  assert.match(details.mfaToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!response.headers.getSetCookie().some(cookie => /^(?:__Host-)?session=/.test(cookie)));
  return { browser, mfaToken: details.mfaToken };
}

test('MFA setup, replay protection, recovery rotation and disable work over HTTP', async () => {
  const account = await verified();
  const other = await signin(account);
  assert.equal(status(await account.browser.get(`${auth}/mfa`), 200).json.data.totpEnabled, false);
  const factor = await enable(account);
  assert.equal(status(await other.browser.get(`${auth}/session`), 200).json.data.user, null);
  assert.equal(status(await account.browser.get(`${auth}/session`), 200).json.data.user.mfaEnabled, true);

  const first = await challenge(account);
  error(await first.browser.post(`${auth}/mfa/verify`, { mfaToken: first.mfaToken, code: factor.code }), 401, 'INVALID_CODE');
  status(await first.browser.post(`${auth}/mfa/verify`, { mfaToken: first.mfaToken, recoveryCode: factor.recoveryCodes[0] }), 200);
  status(await first.browser.get('/api/v1/me'), 200);
  error(await new Browser().post(`${auth}/mfa/verify`, { mfaToken: first.mfaToken, recoveryCode: factor.recoveryCodes[1] }), 401, 'INVALID_CODE');

  const second = await challenge(account);
  error(await second.browser.post(`${auth}/mfa/verify`, { mfaToken: second.mfaToken, recoveryCode: factor.recoveryCodes[0] }), 401, 'INVALID_CODE');
  status(await second.browser.post(`${auth}/mfa/verify`, { mfaToken: second.mfaToken, code: totp(factor.secret, 1) }), 200);

  const rotated = status(await account.browser.post(`${auth}/mfa/recovery-codes`, { currentPassword: account.secret, code: factor.recoveryCodes[1] }), 200).json.data.recoveryCodes;
  assert.equal(rotated.length, 10);
  const third = await challenge(account);
  error(await third.browser.post(`${auth}/mfa/verify`, { mfaToken: third.mfaToken, recoveryCode: factor.recoveryCodes[2] }), 401, 'INVALID_CODE');
  status(await third.browser.post(`${auth}/mfa/verify`, { mfaToken: third.mfaToken, recoveryCode: rotated[0] }), 200);
  status(await account.browser.post(`${auth}/mfa/totp/disable`, { currentPassword: account.secret, code: rotated[1] }), 204);
  assert.equal(status(await third.browser.get(`${auth}/session`), 200).json.data.user, null);
  const remaining = status(await account.browser.get(`${auth}/mfa`), 200).json.data;
  assert.equal(remaining.totpEnabled, false);
  assert.equal(remaining.recoveryCodesRemaining, 0);
});

test('password reset changes credentials but requires MFA before a new session', async () => {
  const account = await verified();
  const factor = await enable(account);
  const resetter = new Browser();
  const before = await messageIds(account.address);
  status(await resetter.post(`${auth}/password/forgot`, { email: account.address }), 202);
  const code = await waitForCode(account.address, before);
  const grant = status(await resetter.post(`${auth}/password/verify-code`, { email: account.address, code }), 200).json.data.resetToken;
  const replacement = `${password} reset`;
  const response = await resetter.post(`${auth}/password/reset`, { password: replacement, resetToken: grant });
  const { mfaToken } = error(response, 403, 'MFA_REQUIRED').details;
  assert.ok(!response.headers.getSetCookie().some(cookie => /^(?:__Host-)?session=/.test(cookie)));
  assert.equal(status(await account.browser.get(`${auth}/session`), 200).json.data.user, null);
  status(await resetter.post(`${auth}/mfa/verify`, { mfaToken, recoveryCode: factor.recoveryCodes[0] }), 200);
  status(await resetter.get('/api/v1/me'), 200);
  error(await new Browser().post(`${auth}/signin`, { email: account.address, password: account.secret }), 401, 'INVALID_CREDENTIALS');
  await challenge({ ...account, secret: replacement });
});
