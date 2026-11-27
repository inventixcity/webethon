import { randomUUID } from 'node:crypto';
import { Browser } from './http.mjs';
import { messageIds, waitForCode } from './mail.mjs';
import { status } from './assert.mjs';
export const password = 'Correct horse battery 57!';
export const email = () => `probe+${randomUUID()}@example.test`;
export const auth = '/api/v1/auth';
export async function signup({ address = email(), secret = password, browser = new Browser() } = {}) {
  const before = await messageIds(address);
  const result = status(await browser.post(`${auth}/signup`, { name: 'Probe', email: address, password: secret }), 202);
  return { browser, address, secret, before, signupToken: result.json.data.signupToken };
}
export async function verified(options) {
  const account = await signup(options), code = await waitForCode(account.address, account.before);
  const result = status(await account.browser.post(`${auth}/verify-email`, { email: account.address, code }), 200);
  return { ...account, code, token: result.json.data.token, user: result.json.data.user };
}
export async function signin(account, browser = new Browser()) {
  const response = status(await browser.post(`${auth}/signin`, { email: account.address, password: account.secret }), 200);
  return { browser, ...response.json.data };
}
