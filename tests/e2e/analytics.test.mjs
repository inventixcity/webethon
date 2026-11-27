import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verified } from './lib/fixtures.mjs';
import { Browser } from './lib/http.mjs';
import { error, status } from './lib/assert.mjs';

const stats = '/api/v1/entities/notes/stats';
test('analytics validates queries and enforces scope', async () => {
  const { browser } = await verified();
  for (const query of ['', 'metric=count&metric=count', 'metric=count&extra=x', 'metric=sum:title', 'metric=count&groupBy=title%3BSELECT', 'metric=count&filter%5Bpinned%3BSELECT%5D=true', 'metric=count&scope=all', 'metric=count&from=bad', 'metric=count&from=2024-01-01T00:00:00Z&to=2025-01-02T00:00:00Z']) {
    const response = await browser.get(`${stats}?${query}`);
    if (query === 'metric=count&scope=all') error(response, 403);
    else error(response, 400);
  }
  error(await new Browser().get(`${stats}?metric=count&scope=mine`), 401);
});

test('analytics counts owner records, groups pinned and buckets creation days in UTC', async () => {
  const owner = await verified(), other = await verified();
  const create = async (browser, pinned, visibility) => status(await browser.post('/api/v1/entities/notes', { data: { title: 'Analytics', pinned }, visibility }), 201).json.data;
  const publicBefore = status(await owner.browser.get(stats + '?metric=count&scope=public'), 200).json.data[0].value;
  const a = await create(owner.browser, true, 'public');
  await create(owner.browser, false, 'private');
  await create(other.browser, true, 'private');
  const get = async query => status(await owner.browser.get(`${stats}?${query}`), 200).json.data;
  assert.deepEqual(await get('metric=count'), [{ key: null, value: 2 }]);
  const groups = await get('metric=count&groupBy=pinned');
  assert.deepEqual(new Map(groups.map(row => [row.key, row.value])), new Map([[false, 1], [true, 1]]));
  assert.deepEqual(await get('metric=count&filter%5Bpinned%5D=true'), [{ key: null, value: 1 }]);
  const day = new Date(a.createdAt).toISOString().slice(0, 10);
  const buckets = await get('metric=count&groupBy=createdAt:day');
  assert.equal(buckets.find(row => row.key.startsWith(day))?.key, `${day}T00:00:00Z`);
  assert.equal(buckets.reduce((sum, row) => sum + row.value, 0), 2);
  assert.equal((await get('metric=count&scope=public'))[0].value, publicBefore + 1);
  status(await owner.browser.get(stats + '?metric=count&from=2024-01-01T00:00:00Z&to=2025-01-01T00:00:00Z'), 200);
  const task = status(await owner.browser.post('/api/v1/entities/tasks', { data: { title: 'Numeric', priority: 3 } }), 201);
  assert.equal(task.json.data.data.priority, 3);
  assert.deepEqual(status(await owner.browser.get('/api/v1/entities/tasks/stats?metric=sum:priority'), 200).json.data, [{ key: null, value: 3 }]);
});


