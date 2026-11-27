import { Visitor } from './client.mjs';
import { PASSWORD, poolEmail, POOL_SIZE, BOOKING_OWNER_INDEX, stormEmail } from './config.mjs';
import { messageIds, waitForCode } from './mail.mjs';
import { mapLimit } from './pool.mjs';

// Returns a verified account with a bearer token. With signinFirst, an existing account is reused without
// touching email; otherwise it goes through signup, the emailed code, and verify-email. Each step uses a
// fresh visitor IP, so the per-IP signup, code and sign-in budgets never apply to the provisioning itself.
export async function ensureAccount(email, { signinFirst = true, name = 'Load test' } = {}) {
  if (signinFirst) {
    const response = await new Visitor().send('POST', '/api/v1/auth/signin', {
      body: { email, password: PASSWORD },
    });
    if (response.status === 200) {
      return { email, token: response.json.data.token, id: response.json.data.user.id };
    }
    // 401 means unknown or unverified, so fall through to signup. Anything else is a real problem.
    if (response.status !== 401) throw new Error(`sign-in for ${email} returned ${response.status} ${response.code}`);
  }
  const visitor = new Visitor();
  const before = await messageIds(email);
  const signup = await visitor.send('POST', '/api/v1/auth/signup', {
    body: { name, email, password: PASSWORD },
  });
  if (signup.status !== 202) throw new Error(`signup for ${email} returned ${signup.status} ${signup.code}`);
  const code = await waitForCode(email, before);
  const verified = await visitor.send('POST', '/api/v1/auth/verify-email', {
    body: { email, code, signupToken: signup.json.data.signupToken },
  });
  if (verified.status !== 200) throw new Error(`verify for ${email} returned ${verified.status} ${verified.code}`);
  return { email, token: verified.json.data.token, id: verified.json.data.user.id };
}

// The shared pool, created once per process. Accounts that already exist are signed in instead.
let poolPromise = null;
export function pool({ log } = {}) {
  poolPromise ??= (async () => {
    const indexes = Array.from({ length: POOL_SIZE }, (_, index) => index);
    const accounts = await mapLimit(indexes, 4, async index => {
      const account = await ensureAccount(poolEmail(index));
      if (log && index % 25 === 0) log(`  pool account ${index}/${POOL_SIZE} ready`);
      return account;
    });
    return accounts;
  })();
  return poolPromise;
}

export const bookingOwnerIndex = BOOKING_OWNER_INDEX;

// The auth storm accounts: fresh and verified for this run, created without signing in.
export async function stormAccounts(count, { log } = {}) {
  const indexes = Array.from({ length: count }, (_, index) => index);
  return mapLimit(indexes, 4, async index => {
    const account = await ensureAccount(stormEmail(index), { signinFirst: false });
    if (log && index % 25 === 0) log(`  storm account ${index}/${count} ready`);
    return account;
  });
}
