// Runs in the isolated API's network namespace; never calls Stripe.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const sessions = new Map();
createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
    const p = new URLSearchParams(body), id = `cs_test_${randomUUID().replaceAll('-', '')}`;
    const user = p.get('client_reference_id'), product = p.get('metadata[productId]');
    if (!user || p.get('metadata[userId]') !== user || !product) { res.statusCode = 400; return res.end('{}'); }
    const session = { id, object: 'checkout.session', status: 'complete', payment_status: 'paid', mode: p.get('mode'), client_reference_id: user, metadata: { userId: user, productId: product }, customer: `cus_${id}`, amount_total: product === 'pro-pass' ? 4900 : 900, currency: 'usd', payment_intent: `pi_${id}`, subscription: `sub_${id}` };
    sessions.set(id, session);
    return res.end(JSON.stringify({ id, object: 'checkout.session', url: `https://checkout.stripe.test/pay/${id}` }));
  }
  if (req.method === 'POST' && url.pathname === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ id: 'bps_e2e', url: 'https://billing.stripe.test/session/bps_e2e' }));
  const match = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_test_[a-f0-9]+)(?:\/(line_items))?$/);
  if (req.method === 'GET' && match && sessions.has(match[1])) {
    const session = sessions.get(match[1]);
    return res.end(JSON.stringify(match[2] ? { object: 'list', data: [{ quantity: 1, price: { currency: session.currency, unit_amount: session.amount_total } }], has_more: false } : session));
  }
  const object = url.pathname.match(/^\/v1\/(payment_intents|subscriptions)\/(?:pi_|sub_)(cs_test_[a-f0-9]+?)(?:_(cancelled))?$/);
  if (req.method === 'GET' && object && sessions.has(object[2])) {
    const session = sessions.get(object[2]);
    return res.end(JSON.stringify({ id: url.pathname.split('/').pop(), object: object[1] === 'subscriptions' ? 'subscription' : 'payment_intent', status: object[3] ? 'canceled' : (object[1] === 'subscriptions' ? 'active' : 'succeeded'), metadata: session.metadata, customer: session.customer, currency: session.currency, amount: session.amount_total, items: { data: [{ price: { id: 'price_e2e' } }] } }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing' } }));
}).listen(Number(process.env.STRIPE_MOCK_PORT || 12111), '127.0.0.1');
