import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verified } from './lib/fixtures.mjs';
import { Browser } from './lib/http.mjs';
import { status, error } from './lib/assert.mjs';

test('place viewport, radius and private access', async () => {
  const owner = await verified(), other = await verified(), anonymous = new Browser();
  const create = async (name, lng, visibility) => status(await owner.browser.post('/api/v1/places', { name, lat: 0, lng, visibility }), 201).json.data;
  const east = await create('E2E east', 179.99, 'public');
  const west = await create('E2E west', -179.99, 'public');
  const hidden = await create('E2E private', 179.98, 'private');
  const ids = result => result.json.data.map(p => p.id);
  const box = status(await anonymous.get('/api/v1/places?bbox=179,-1,-179,1'), 200);
  assert.ok(ids(box).includes(east.id) && ids(box).includes(west.id));
  assert.ok(!ids(box).includes(hidden.id));
  assert.ok(ids(status(await owner.browser.get('/api/v1/places?bbox=179,-1,-179,1'), 200)).includes(hidden.id));
  const near = status(await anonymous.get('/api/v1/places/nearby?lat=0&lng=179.99&radiusKm=5'), 200).json.data;
  assert.ok(near.some(p => p.id === east.id) && near.some(p => p.id === west.id));
  assert.ok(!near.some(p => p.id === hidden.id));
  assert.ok(near.every((p, i) => i === 0 || near[i - 1].distanceM <= p.distanceM));
  error(await other.browser.get(`/api/v1/places/${hidden.id}`), 404);
  error(await other.browser.patch(`/api/v1/places/${east.id}`, { name: 'No' }), 404);
  error(await anonymous.get('/api/v1/places?bbox=0,10,1,-10'), 400);
  error(await anonymous.get('/api/v1/places/nearby?lat=0&lng=0&radiusKm=51'), 400);
});

test('onboarding replaces answers and preserves completion', async () => {
  const user = await verified();
  const path = '/api/v1/onboarding';
  const initial = status(await user.browser.get(path), 200).json.data;
  assert.deepEqual(initial.answers, {}); assert.equal(initial.completedAt, null);
  const save = body => user.browser.request(path, { method: 'PUT', body });
  const completed = status(await save({ answers: { interests: ['maps'], notifications: 'important' }, completed: true }), 200).json.data;
  assert.ok(completed.completedAt);
  const updated = status(await save({ answers: { notifications: 'none' }, completed: false }), 200).json.data;
  assert.deepEqual(updated.answers, { notifications: 'none' });
  assert.equal(updated.completedAt, completed.completedAt);
  assert.deepEqual(status(await user.browser.get(path), 200).json.data, updated);
  error(await save({ answers: { unexpected: true } }), 400);
});
