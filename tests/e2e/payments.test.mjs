import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { paymentsEnvironment } from './lib/payments-env.mjs';

const environment = await paymentsEnvironment();
after(() => environment.cleanup());
process.env.API_URL = environment.origin;
const { verified } = await import('./lib/fixtures.mjs');
const { Browser } = await import('./lib/http.mjs');
const { status, error } = await import('./lib/assert.mjs');

function signedEvent(anon, kind, objectId) {
  const raw = JSON.stringify({ id: `evt_${randomUUID().replaceAll('-', '')}`, type: kind, livemode: false, data: { object: { id: objectId } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', 'whsec_e2e').update(`${timestamp}.${raw}`).digest('hex');
  return { send: sig => anon.request('/api/v1/billing/webhook', { method: 'POST', raw, headers: { 'content-type': 'application/json', 'stripe-signature': sig || `t=${timestamp},v1=${signature}` } }), invalid: `t=${timestamp},v1=${'0'.repeat(64)}` };
}

test('isolated Stripe checkout, signed events and entitlement lifecycle', async () => {
  const user = await verified(), other = await verified(), anon = new Browser();
  const products = status(await anon.get('/api/v1/billing/products'), 200).json.data;
  assert.ok(products.some(p => p.id === 'pro-pass'));
  assert.deepEqual(status(await user.browser.get('/api/v1/billing/me'), 200).json.data.entitlements, []);
  error(await anon.post('/api/v1/billing/checkout', { productId: 'pro-pass' }), 401);
  error(await user.browser.post('/api/v1/billing/checkout', { productId: 'not-a-product' }), 400);
  const checkout = async (account, productId) => {
    const url = status(await account.browser.post('/api/v1/billing/checkout', { productId }), 200).json.data.url;
    assert.match(url, /^https:\/\/checkout\.stripe\.test\/pay\/cs_test_[a-f0-9]+$/);
    return url.split('/').pop();
  };
  const first = await checkout(user, 'pro-pass');
  const second = await checkout(other, 'pro-pass');
  assert.notEqual(first, second);
  const complete = signedEvent(anon, 'checkout.session.completed', first);
  error(await complete.send(complete.invalid), 400);
  assert.equal(status(await complete.send(), 200).json.data.outcome, 'done');
  assert.equal(status(await complete.send(), 200).json.data.outcome, 'duplicate');
  let billing = status(await user.browser.get('/api/v1/billing/me'), 200).json.data;
  assert.ok(billing.entitlements.some(e => e.productId === 'pro-pass' && e.active));
  assert.equal(billing.purchases.length, 1);
  assert.deepEqual(status(await other.browser.get('/api/v1/billing/me'), 200).json.data.entitlements, []);
  assert.equal(status(await signedEvent(anon, 'checkout.session.completed', second).send(), 200).json.data.outcome, 'done');
  assert.ok(status(await other.browser.get('/api/v1/billing/me'), 200).json.data.entitlements.some(e => e.productId === 'pro-pass' && e.active));
  const plan = await checkout(user, 'pro-plan');
  assert.equal(status(await signedEvent(anon, 'checkout.session.completed', plan).send(), 200).json.data.outcome, 'done');
  assert.ok(status(await user.browser.get('/api/v1/billing/me'), 200).json.data.entitlements.some(e => e.productId === 'pro-plan' && e.active));
  assert.equal(status(await signedEvent(anon, 'customer.subscription.deleted', `sub_${plan}_cancelled`).send(), 200).json.data.outcome, 'done');
  billing = status(await user.browser.get('/api/v1/billing/me'), 200).json.data;
  assert.ok(billing.entitlements.some(e => e.productId === 'pro-plan' && !e.active));
  // Refund events are currently unsupported: they must not silently revoke access.
  assert.equal(status(await signedEvent(anon, 'charge.refunded', `ch_${first}`).send(), 200).json.data.outcome, 'skipped');
  assert.ok(status(await user.browser.get('/api/v1/billing/me'), 200).json.data.entitlements.some(e => e.productId === 'pro-pass' && e.active));
});
