import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Browser } from './http.mjs';
import { auth } from './fixtures.mjs';
import { error, status } from './assert.mjs';

export const enabled = Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD);
export const root = '/api/v1/admin';
export async function adminSignin() {
  const browser = new Browser();
  const response = status(await browser.post(`${auth}/signin`, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }), 200);
  return { browser, user: response.json.data.user, secret: process.env.ADMIN_PASSWORD };
}
export async function stepUp(account, code) {
  const before = Date.now();
  const response = status(await account.browser.post(`${root}/step-up`, { password: account.secret, ...(code ? { code } : {}) }), 200);
  const expiry = Date.parse(response.json.data.expiresAt);
  assert.ok(expiry > before && expiry <= Date.now() + 10 * 60_000 + 5000);
}
export function needsStepUp(response) {
  assert.equal(error(response, 428, 'PRECONDITION_REQUIRED').details?.reason, 'STEP_UP_REQUIRED');
}
export function totp(secret, offset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.toUpperCase().replace(/=+$/, '')].map(c => {
    const n = alphabet.indexOf(c); assert.ok(n >= 0); return n.toString(2).padStart(5, '0');
  }).join('');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const digest = createHmac('sha1', key).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export function noSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    // Boolean flags such as config.secureCookies say whether a feature is on; they never carry a secret value.
    if (typeof child === 'boolean') continue;
    assert.doesNotMatch(key, /password|secret|token|hash|recovery.?code|cookie|credential|authorization|nonce/i);
    noSecrets(child);
  }
}
