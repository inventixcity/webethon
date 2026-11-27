import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verified } from './lib/fixtures.mjs';
import { error, status } from './lib/assert.mjs';
const path = '/api/v1/entities/notes';
async function create(browser, data = { title: 'Probe' }, options = {}) {
  return status(await browser.post(path, { data, ...options }), 201).json.data;
}
test('notes CRUD and deleted records disappear', async () => {
  const { browser } = await verified(), item = await create(browser);
  assert.equal(status(await browser.get(`${path}/${item.id}`), 200).json.data.id, item.id);
  const updated = status(await browser.patch(`${path}/${item.id}`, { data: { title: 'Changed' } }, { headers: { 'if-match': String(item.version) } }), 200).json.data;
  assert.equal(updated.data.title, 'Changed');
  status(await browser.delete(`${path}/${item.id}`, { headers: { 'if-match': String(updated.version) } }), 204);
  error(await browser.get(`${path}/${item.id}`), 404, 'NOT_FOUND');
  assert.ok(!status(await browser.get(path), 200).json.data.some(entry => entry.id === item.id));
});
test('private notes resist IDOR and public notes are readable', async () => {
  const first = await verified(), second = await verified(), item = await create(first.browser);
  error(await second.browser.get(`${path}/${item.id}`), 404, 'NOT_FOUND');
  error(await second.browser.patch(`${path}/${item.id}`, { data: { title: 'Stolen' } }, { headers: { 'if-match': String(item.version) } }), 404, 'NOT_FOUND');
  error(await second.browser.delete(`${path}/${item.id}`, { headers: { 'if-match': String(item.version) } }), 404, 'NOT_FOUND');
  assert.ok(!status(await second.browser.get(path), 200).json.data.some(entry => entry.id === item.id));
  const publicItem = await create(first.browser, { title: 'Public' }, { visibility: 'public' });
  assert.equal(status(await second.browser.get(`${path}/${publicItem.id}`), 200).json.data.id, publicItem.id);
});
test('mass assignment and unknown fields are rejected', async () => {
  const { browser } = await verified();
  for (const field of ['ownerId', 'id', 'version', 'role', 'unknown']) {
    error(await browser.post(path, { data: { title: 'Probe' }, [field]: 'bad' }), 400);
    error(await browser.post(path, { data: { title: 'Probe', [field]: 'bad' } }), 400);
  }
});
test('schema violations include details', async () => {
  const { browser } = await verified();
  for (const data of [{ title: 'x'.repeat(10000) }, { title: 42 }]) {
    const result = error(await browser.post(path, { data }), 400, 'VALIDATION_FAILED');
    assert.ok(result.details && Object.keys(result.details).length);
  }
});
test('updates require current version', async () => {
  const { browser } = await verified(), item = await create(browser);
  error(await browser.patch(`${path}/${item.id}`, { data: { title: 'New' } }), 428, 'PRECONDITION_REQUIRED');
  const updated = status(await browser.patch(`${path}/${item.id}`, { data: { title: 'New' } }, { headers: { 'if-match': String(item.version) } }), 200).json.data;
  const conflict = error(await browser.patch(`${path}/${item.id}`, { data: { title: 'Stale' } }, { headers: { 'if-match': String(item.version) } }), 409, 'VERSION_CONFLICT');
  assert.equal(conflict.details.currentVersion, updated.version);
});
test('idempotency replays and rejects mismatches', async () => {
  const { browser } = await verified(), headers = { 'idempotency-key': randomUUID() }, body = { data: { title: 'Same' } };
  const first = status(await browser.post(path, body, { headers }), 201).json.data;
  assert.equal(status(await browser.post(path, body, { headers }), 201).json.data.id, first.id);
  error(await browser.post(path, { data: { title: 'Different' } }, { headers }), 422, 'IDEMPOTENCY_MISMATCH');
});
test('parallel idempotency creates exactly one record', async () => {
  const { browser } = await verified(), title = randomUUID(), headers = { 'idempotency-key': randomUUID() };
  const responses = await Promise.all(Array.from({ length: 20 }, () => browser.post(path, { data: { title } }, { headers })));
  for (const response of responses) {
    if (response.status === 409) error(response, 409, 'CONFLICT');
    else status(response, 201);
  }
  const ids = new Set(responses.filter(response => response.status === 201).map(response => response.json.data.id));
  assert.equal(ids.size, 1);
  const list = status(await browser.get(`${path}?q=${title}`), 200).json.data;
  assert.equal(list.filter(item => item.data.title === title).length, 1);
});
test('query parameters and cursors are strictly validated', async () => {
  const { browser } = await verified();
  for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=abc', 'cursor=not-a-cursor', 'sort=body', 'sort=title%3BSELECT', 'filter%5Bbody%5D=x', 'filter%5Btitle%3BSELECT%5D=x']) error(await browser.get(`${path}?${query}`), 400);
  error(await browser.get('/api/v1/entities/no_such_entity'), 404, 'NOT_FOUND');
});
test('pagination returns 45 records exactly once', async () => {
  const { browser } = await verified(), ids = new Set();
  for (let index = 0; index < 45; index++) ids.add((await create(browser, { title: 'Tie' })).id);
  const found = [], cursors = new Set();
  let cursor;
  do {
    const page = status(await browser.get(`${path}?limit=10&sort=title${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), 200).json;
    found.push(...page.data.map(item => item.id));
    cursor = page.meta.nextCursor;
    if (cursor) { assert.ok(!cursors.has(cursor)); cursors.add(cursor); }
  } while (cursor);
  assert.equal(found.length, 45);
  assert.deepEqual(new Set(found), ids);
});
test('search treats percent and underscore literally', async () => {
  const { browser } = await verified();
  const percent = await create(browser, { title: 'one%marker' }), underscore = await create(browser, { title: 'two_marker' });
  await create(browser, { title: 'onexmarker twoxmarker' });
  for (const [query, id] of [['%', percent.id], ['_', underscore.id]]) {
    const items = status(await browser.get(`${path}?q=${encodeURIComponent(query)}`), 200).json.data;
    assert.deepEqual(items.map(item => item.id), [id]);
  }
});
