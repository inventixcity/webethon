import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verified } from './lib/fixtures.mjs';
import { Browser } from './lib/http.mjs';
import { error, status } from './lib/assert.mjs';

const base = '/api/v1/assist';
test('assist requires authentication and rejects malformed bodies', async () => {
  const anon = new Browser();
  for (const [route, body] of [['ask', { question: 'Hello' }], ['search', { entity: 'notes', query: 'hello' }], ['confirm', { actionId: randomUUID() }], ['cancel', { actionId: randomUUID() }]]) error(await anon.post(`${base}/${route}`, body), 401);
  const { browser } = await verified();
  for (const [route, body] of [['ask', { question: 'Hello', extra: true }], ['search', { entity: 'notes', query: 'x', extra: true }], ['confirm', { actionId: randomUUID(), extra: true }], ['cancel', { actionId: 'invalid' }]]) error(await browser.post(`${base}/${route}`, body), 400);
  const unknown = randomUUID();
  error(await browser.post(`${base}/confirm`, { actionId: unknown }), 404, 'NOT_FOUND');
  error(await browser.post(`${base}/cancel`, { actionId: unknown }), 404, 'NOT_FOUND');
});

test('assist without a configured provider returns a deterministic unavailable error', async () => {
  const { browser } = await verified();
  const response = await browser.post(`${base}/ask`, { question: 'Summarize my notes' });
  assert.equal(response.status, 503, response.text);
  assert.equal(response.json?.error?.code, 'NOT_CONFIGURED');
});

