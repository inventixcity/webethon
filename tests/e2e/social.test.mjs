import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verified } from './lib/fixtures.mjs';
import { error, status } from './lib/assert.mjs';

const put = (browser, path) => browser.request(path, { method: 'PUT' });
test('social threads, idempotent relations and access changes', async () => {
  const owner = await verified(), visitor = await verified();
  const note = status(await owner.browser.post('/api/v1/entities/notes', { data: { title: 'Social' }, visibility: 'public' }), 201).json.data;
  const path = `/api/v1/entities/notes/${note.id}`;
  const comment = status(await visitor.browser.post(`${path}/comments`, { body: 'Hello' }), 201).json.data;
  error(await owner.browser.patch(`/api/v1/comments/${comment.id}`, { body: 'Hijacked' }), 404, 'NOT_FOUND');
  error(await owner.browser.delete(`/api/v1/comments/${comment.id}`), 404, 'NOT_FOUND');
  assert.equal(status(await visitor.browser.patch(`/api/v1/comments/${comment.id}`, { body: 'Edited' }), 200).json.data.body, 'Edited');
  const reply = status(await owner.browser.post(`${path}/comments`, { body: 'Reply', parentId: comment.id }), 201).json.data;
  assert.equal(reply.parentId, comment.id);
  error(await visitor.browser.post(`${path}/comments`, { body: 'Too deep', parentId: reply.id }), 400);
  status(await visitor.browser.delete(`/api/v1/comments/${comment.id}`), 204);
  const placeholder = status(await visitor.browser.get(`${path}/comments`), 200).json.data.find(item => item.id === comment.id);
  assert.equal(placeholder.body, null);
  assert.ok(placeholder.deletedAt);
  error(await visitor.browser.post(`${path}/comments`, { body: 'Deleted parent', parentId: comment.id }), 400);
  for (const suffix of ['/reactions/like', '/bookmark']) {
    status(await put(visitor.browser, path + suffix), 204);
    status(await put(visitor.browser, path + suffix), 204);
  }
  const reactions = status(await visitor.browser.get(`${path}/reactions`), 200).json.data;
  assert.equal(reactions.counts.like, 1);
  assert.deepEqual(reactions.mine, ['like']);
  assert.equal(status(await visitor.browser.get(`${path}/bookmark`), 200).json.data.active, true);
  assert.ok(status(await visitor.browser.get('/api/v1/bookmarks'), 200).json.data.some(item => item.id === note.id));
  const follow = `/api/v1/users/${owner.user.id}/follow`;
  status(await put(visitor.browser, follow), 204);
  status(await put(visitor.browser, follow), 204);
  assert.equal(status(await visitor.browser.get(follow), 200).json.data.active, true);
  status(await visitor.browser.delete(follow), 204);
  status(await visitor.browser.delete(follow), 204);
  assert.equal(status(await visitor.browser.get(follow), 200).json.data.active, false);
  status(await visitor.browser.delete(`${path}/reactions/like`), 204);
  status(await visitor.browser.delete(`${path}/reactions/like`), 204);
  assert.equal(status(await visitor.browser.get(`${path}/reactions`), 200).json.data.counts.like ?? 0, 0);
  status(await visitor.browser.delete(`${path}/bookmark`), 204);
  status(await visitor.browser.delete(`${path}/bookmark`), 204);
  status(await put(visitor.browser, `${path}/bookmark`), 204);
  const unreadBeforePrivate = status(await owner.browser.get('/api/v1/notifications/count'), 200).json.data.unreadCount;
  assert.ok(unreadBeforePrivate > 0);
  status(await owner.browser.patch(path, { visibility: 'private' }, { headers: { 'if-match': String(note.version) } }), 200);
  error(await visitor.browser.get(`${path}/comments`), 404, 'NOT_FOUND');
  error(await visitor.browser.get(`${path}/reactions`), 404, 'NOT_FOUND');
  assert.ok(!status(await visitor.browser.get('/api/v1/bookmarks'), 200).json.data.some(item => item.id === note.id));
  assert.ok(!status(await visitor.browser.get('/api/v1/activity'), 200).json.data.some(item => item.recordId === note.id));
  const notices = status(await owner.browser.get('/api/v1/notifications'), 200).json;
  assert.ok(!notices.data.some(item => item.recordId === note.id));
  assert.equal(status(await owner.browser.get('/api/v1/notifications/count'), 200).json.data.unreadCount, notices.meta.unreadCount);
  assert.ok(notices.meta.unreadCount < unreadBeforePrivate);
});

test('notifications belong to their recipient and read updates the count', async () => {
  const owner = await verified(), actor = await verified();
  const note = status(await owner.browser.post('/api/v1/entities/notes', { data: { title: 'Notification' }, visibility: 'public' }), 201).json.data;
  status(await actor.browser.post(`/api/v1/entities/notes/${note.id}/comments`, { body: 'Hello' }), 201);
  const list = status(await owner.browser.get('/api/v1/notifications'), 200).json;
  const notification = list.data.find(item => item.recordId === note.id);
  assert.ok(notification);
  assert.equal(list.meta.unreadCount, 1);
  assert.equal(status(await owner.browser.get('/api/v1/notifications/count'), 200).json.data.unreadCount, 1);
  assert.ok(!status(await actor.browser.get('/api/v1/notifications'), 200).json.data.some(item => item.id === notification.id));
  status(await actor.browser.post('/api/v1/notifications/read', { ids: [notification.id] }), 204);
  assert.equal(status(await owner.browser.get('/api/v1/notifications/count'), 200).json.data.unreadCount, 1);
  status(await owner.browser.post('/api/v1/notifications/read', { ids: [notification.id] }), 204);
  assert.equal(status(await owner.browser.get('/api/v1/notifications/count'), 200).json.data.unreadCount, 0);
});

