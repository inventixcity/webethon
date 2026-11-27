import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verified } from './lib/fixtures.mjs';
import { status, error } from './lib/assert.mjs';
import { envelope } from './lib/error-contract.mjs';
import { adminSignin, enabled, needsStepUp, noSecrets, root, stepUp } from './lib/admin-fixture.mjs';

// Black-box tests for the wave-4 routes: webhooks, shares, flags, admin jobs, and CSV/JSON transfer.
// Expectations come from the real handlers in backend/crates. A route that answers differently is
// reported as a failing test; expectations are not relaxed to make it pass.

const api = '/api/v1';
const notes = `${api}/entities/notes`;
const webhooks = `${api}/webhooks`;
const shares = `${api}/shares`;
const adminFlags = `${api}/admin/flags`;
const adminJobs = `${api}/admin/jobs`;
const hookUrl = 'https://example.com/wave4-hook';
const events = ['record.created:notes'];

async function newWebhook(browser, overrides = {}) {
  return status(await browser.post(webhooks, { url: hookUrl, events, description: 'wave4 probe', ...overrides }), 200).json.data;
}
async function newNote(browser, title = `wave4 ${randomUUID()}`) {
  return status(await browser.post(notes, { data: { title } }), 201).json.data;
}
// Validation failures use the shared envelope; this checks the code and that the named field is in details.
function invalidField(response, path) {
  const e = envelope(response, 400, 'VALIDATION_FAILED');
  assert.ok(Array.isArray(e.details) && e.details.some(detail => detail.path === path), JSON.stringify(e.details));
}
function csvFile(text, name = 'notes.csv') {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), name);
  return form;
}

// ---------- 1. Webhooks ----------

test('webhook create returns the secret once; later reads never include it', async () => {
  const { browser } = await verified();
  const created = status(await browser.post(webhooks, { url: hookUrl, events, description: 'wave4 probe' }), 200).json.data;
  assert.match(created.secret, /^whsec_/);
  assert.equal(typeof created.webhook.id, 'string');
  noSecrets(created.webhook);
  const id = created.webhook.id;
  const one = status(await browser.get(`${webhooks}/${id}`), 200).json;
  assert.equal(one.data.id, id);
  noSecrets(one);
  const list = status(await browser.get(webhooks), 200).json;
  assert.ok(list.data.some(hook => hook.id === id));
  noSecrets(list);
});

test('webhook PATCH updates allowed fields and refuses a loopback URL', async () => {
  const { browser } = await verified();
  const hook = await newWebhook(browser);
  const updated = status(await browser.patch(`${webhooks}/${hook.webhook.id}`, { description: 'renamed' }), 200).json.data;
  assert.equal(updated.description, 'renamed');
  invalidField(await browser.patch(`${webhooks}/${hook.webhook.id}`, { url: 'http://127.0.0.1/hook' }), 'url');
});

test('webhook rotate-secret returns a new secret that differs from the first', async () => {
  const { browser } = await verified();
  const created = status(await browser.post(webhooks, { url: hookUrl, events, description: 'wave4 probe' }), 200).json.data;
  const rotated = status(await browser.post(`${webhooks}/${created.webhook.id}/rotate-secret`), 200).json.data;
  assert.match(rotated.secret, /^whsec_/);
  assert.notEqual(rotated.secret, created.secret);
  noSecrets(status(await browser.get(`${webhooks}/${created.webhook.id}`), 200).json);
});

test('webhook test queues one delivery, and deliveries?limit=1 returns at most one row', async () => {
  const { browser } = await verified();
  const hook = await newWebhook(browser);
  const id = hook.webhook.id;
  status(await browser.post(`${webhooks}/${id}/test`), 200);
  const page = status(await browser.get(`${webhooks}/${id}/deliveries?limit=1`), 200).json;
  assert.ok(Array.isArray(page.data));
  assert.equal(page.data.length, 1);
  assert.ok('nextCursor' in page.meta);
});

test('webhook deliveries rejects limit=0', async () => {
  const { browser } = await verified();
  const hook = await newWebhook(browser);
  invalidField(await browser.get(`${webhooks}/${hook.webhook.id}/deliveries?limit=0`), 'limit');
});

test('webhook DELETE removes it and a second DELETE is 404', async () => {
  const { browser } = await verified();
  const hook = await newWebhook(browser);
  const id = hook.webhook.id;
  const removed = status(await browser.delete(`${webhooks}/${id}`), 200).json.data;
  assert.equal(removed.deleted, true);
  error(await browser.get(`${webhooks}/${id}`), 404, 'NOT_FOUND');
  error(await browser.delete(`${webhooks}/${id}`), 404, 'NOT_FOUND');
});

test('webhook create refuses a private-address target URL on the url path', async () => {
  const { browser } = await verified();
  invalidField(await browser.post(webhooks, { url: 'http://127.0.0.1/hook', events }), 'url');
});

test('another user gets 404 (not 403) on every webhook route', async () => {
  const owner = await verified(), other = await verified();
  const hook = await newWebhook(owner.browser);
  const id = hook.webhook.id;
  error(await other.browser.get(`${webhooks}/${id}`), 404, 'NOT_FOUND');
  error(await other.browser.patch(`${webhooks}/${id}`, { description: 'stolen' }), 404, 'NOT_FOUND');
  error(await other.browser.post(`${webhooks}/${id}/rotate-secret`), 404, 'NOT_FOUND');
  error(await other.browser.post(`${webhooks}/${id}/test`), 404, 'NOT_FOUND');
  error(await other.browser.get(`${webhooks}/${id}/deliveries`), 404, 'NOT_FOUND');
  error(await other.browser.delete(`${webhooks}/${id}`), 404, 'NOT_FOUND');
  // The owner's webhook is still there.
  assert.equal(status(await owner.browser.get(`${webhooks}/${id}`), 200).json.data.id, id);
});

test('webhook unknown id is 404 and wrong method is 405 with the shared envelope', async () => {
  const { browser } = await verified();
  const unknown = randomUUID();
  error(await browser.get(`${webhooks}/${unknown}`), 404, 'NOT_FOUND');
  error(await browser.patch(`${webhooks}/${unknown}`, { description: 'x' }), 404, 'NOT_FOUND');
  error(await browser.delete(`${webhooks}/${unknown}`), 404, 'NOT_FOUND');
  envelope(await browser.request(webhooks, { method: 'PUT', body: {} }), 405, 'METHOD_NOT_ALLOWED');
  envelope(await browser.request(`${webhooks}/${unknown}`, { method: 'PUT', body: {} }), 405, 'METHOD_NOT_ALLOWED');
});

// ---------- 2. Shares ----------

test('share create returns an id and URL, and GET /shares lists it without secrets', async () => {
  const { browser } = await verified();
  const item = await newNote(browser);
  const share = status(await browser.post(shares, { entity: 'notes', recordId: item.id }), 200).json.data;
  assert.equal(typeof share.id, 'string');
  assert.match(share.url, /\/s\/[^/]+$/);
  const list = status(await browser.get(shares), 200).json;
  const entry = list.data.find(s => s.id === share.id);
  assert.ok(entry, 'created share missing from list');
  assert.equal(entry.recordId, item.id);
  assert.equal(entry.entity, 'notes');
  noSecrets(list);
});

test('public share returns the record without owner or creator ids', async () => {
  const { browser } = await verified();
  const item = await newNote(browser, 'wave4 public');
  const share = status(await browser.post(shares, { entity: 'notes', recordId: item.id }), 200).json.data;
  const token = share.url.split('/s/')[1];
  const response = status(await browser.get(`${api}/public/shares/${token}`), 200);
  assert.equal(response.json.data.id, item.id);
  assert.equal(response.json.data.data.title, 'wave4 public');
  assert.doesNotMatch(response.text, /ownerId|owner_id|creatorId|creator_id|teamId|team_id/);
});

test('revoked share disappears from the public route; second revoke is 404', async () => {
  const { browser } = await verified();
  const item = await newNote(browser);
  const share = status(await browser.post(shares, { entity: 'notes', recordId: item.id }), 200).json.data;
  const token = share.url.split('/s/')[1];
  assert.equal(status(await browser.delete(`${shares}/${share.id}`), 200).json.data.id, share.id);
  error(await browser.get(`${api}/public/shares/${token}`), 404, 'NOT_FOUND');
  error(await browser.delete(`${shares}/${share.id}`), 404, 'NOT_FOUND');
});

test('another user cannot revoke a share (404) and unknown share ids are 404', async () => {
  const owner = await verified(), other = await verified();
  const item = await newNote(owner.browser);
  const share = status(await owner.browser.post(shares, { entity: 'notes', recordId: item.id }), 200).json.data;
  error(await other.browser.delete(`${shares}/${share.id}`), 404, 'NOT_FOUND');
  error(await owner.browser.delete(`${shares}/${randomUUID()}`), 404, 'NOT_FOUND');
  // Still live for the owner.
  status(await owner.browser.get(`${api}/public/shares/${share.url.split('/s/')[1]}`), 200);
});

test('shares wrong method returns 405 with the shared envelope', async () => {
  const { browser } = await verified();
  envelope(await browser.request(shares, { method: 'PUT', body: {} }), 405, 'METHOD_NOT_ALLOWED');
  envelope(await browser.request(`${shares}/${randomUUID()}`, { method: 'PUT', body: {} }), 405, 'METHOD_NOT_ALLOWED');
});

// ---------- 3. Flags ----------

test('GET /flags answers a signed-in user with a flag map', async () => {
  const { browser } = await verified();
  const body = status(await browser.get(`${api}/flags`), 200).json;
  assert.equal(typeof body.data, 'object');
  assert.ok(body.data !== null && !Array.isArray(body.data));
});

test('GET /admin/flags refuses a non-admin (reports 403 or 404)', async () => {
  const user = await verified();
  const response = await user.browser.get(adminFlags);
  assert.ok([403, 404].includes(response.status), `HTTP ${response.status}: ${response.text.slice(0, 300)}`);
  envelope(response, response.status, response.status === 403 ? 'FORBIDDEN' : 'NOT_FOUND');
});

test('non-admin PUT and DELETE on /admin/flags/{key} are refused with 403', async () => {
  const user = await verified();
  const key = `wave4.nonadmin.${randomUUID().slice(0, 8)}`;
  error(await user.browser.request(`${adminFlags}/${key}`, { method: 'PUT', body: { description: 'x', enabled: false, rollout: 0 } }), 403, 'FORBIDDEN');
  error(await user.browser.delete(`${adminFlags}/${key}`), 403, 'FORBIDDEN');
});

test('admin PUT needs step-up, then creates; flag is listed and DELETE removes it', { skip: !enabled }, async () => {
  const admin = await adminSignin();
  const key = `wave4.probe.${randomUUID().slice(0, 8)}`;
  const body = { description: 'wave4 probe', enabled: true, rollout: 100 };
  needsStepUp(await admin.browser.request(`${adminFlags}/${key}`, { method: 'PUT', body }));
  await stepUp(admin);
  const saved = status(await admin.browser.request(`${adminFlags}/${key}`, { method: 'PUT', body }), 200).json.data;
  assert.equal(saved.key, key);
  assert.equal(saved.enabled, true);
  const listed = status(await admin.browser.get(adminFlags), 200).json.data;
  assert.ok(listed.some(flag => flag.key === key));
  const pub = status(await admin.browser.get(`${api}/flags`), 200).json.data;
  assert.equal(pub[key].enabled, true);
  assert.equal(status(await admin.browser.delete(`${adminFlags}/${key}`), 200).json.data.deleted, true);
  error(await admin.browser.delete(`${adminFlags}/${key}`), 404, 'NOT_FOUND');
});

test('flags wrong method returns 405 with the shared envelope', async () => {
  const { browser } = await verified();
  envelope(await browser.request(`${api}/flags`, { method: 'POST', body: {} }), 405, 'METHOD_NOT_ALLOWED');
  envelope(await browser.request(adminFlags, { method: 'POST', body: {} }), 405, 'METHOD_NOT_ALLOWED');
});

// ---------- 4. Admin jobs ----------

test('GET /admin/jobs answers an admin with a list', { skip: !enabled }, async () => {
  const admin = await adminSignin();
  const body = status(await admin.browser.get(adminJobs), 200).json;
  assert.ok(Array.isArray(body.data));
});

test('GET /admin/jobs refuses a non-admin with 403', async () => {
  const user = await verified();
  error(await user.browser.get(adminJobs), 403, 'FORBIDDEN');
});

test('admin jobs wrong method returns 405 with the shared envelope', async () => {
  const { browser } = await verified();
  envelope(await browser.request(adminJobs, { method: 'POST', body: {} }), 405, 'METHOD_NOT_ALLOWED');
});

// ---------- 5. Transfer (export / import) ----------

test('CSV export without a scope parameter is refused with a dotted field path', async () => {
  // Scope is required on purpose: an export must say whose rows it covers. The UI always sends mine or team.
  const { browser } = await verified();
  await newNote(browser, 'wave4 export literal');
  const response = await browser.get(`${notes}/export?format=csv`);
  assert.equal(response.status, 400, `HTTP ${response.status}: ${response.text.slice(0, 300)}`);
  assert.match(response.text, /"path":"scope"/);
});

test('CSV export with scope=mine returns 200, a file body, and Content-Disposition', async () => {
  const { browser } = await verified();
  const title = `wave4 csv ${randomUUID()}`;
  const item = await newNote(browser, title);
  const response = status(await browser.get(`${notes}/export?format=csv&scope=mine`), 200);
  assert.match(response.headers.get('content-type') ?? '', /csv/i);
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment/);
  assert.ok(response.text.includes(title));
  assert.ok(response.text.includes(item.id));
});

test('JSON export with scope=mine returns a JSON array containing the note', async () => {
  const { browser } = await verified();
  const item = await newNote(browser);
  const response = status(await browser.get(`${notes}/export?format=json&scope=mine`), 200);
  // The JSON export is a versioned envelope (the importer accepts it back), not a bare array.
  const exported = JSON.parse(response.text);
  assert.equal(exported.version, 1);
  assert.ok(Array.isArray(exported.records));
  assert.ok(exported.records.some(row => row.id === item.id));
});

test('export with scope=team and no teamId is a validation error on teamId', async () => {
  const { browser } = await verified();
  invalidField(await browser.get(`${notes}/export?format=csv&scope=team`), 'teamId');
});

test('CSV import dryRun=true returns the import shape and writes nothing', async () => {
  const { browser } = await verified();
  const a = `wave4 dry A ${randomUUID()}`, b = `wave4 dry B ${randomUUID()}`;
  const response = status(await browser.request(`${notes}/import?dryRun=true`, { method: 'POST', raw: csvFile(`title\n${a}\n${b}\n`) }), 200);
  assert.equal(typeof response.json.data.created, 'number');
  assert.ok(Array.isArray(response.json.data.failed));
  assert.equal(response.json.data.created, 0);
  const listed = status(await browser.get(notes), 200).json.data;
  assert.ok(!listed.some(item => item.data?.title === a || item.data?.title === b));
});

test('CSV import creates two notes when not a dry run', async () => {
  const { browser } = await verified();
  const a = `wave4 real A ${randomUUID()}`, b = `wave4 real B ${randomUUID()}`;
  const response = status(await browser.request(`${notes}/import`, { method: 'POST', raw: csvFile(`title\n${a}\n${b}\n`) }), 200);
  assert.equal(response.json.data.created, 2);
  assert.deepEqual(response.json.data.failed, []);
});

test('CSV import reports an empty title in failed[] with path title', async () => {
  const { browser } = await verified();
  const good = `wave4 good ${randomUUID()}`;
  // A fully blank line is skipped by the CSV reader, so the empty title is written as a quoted empty field.
  const response = status(await browser.request(`${notes}/import?dryRun=true`, { method: 'POST', raw: csvFile(`title\n${good}\n""\n`) }), 200);
  const { created, failed } = response.json.data;
  assert.equal(typeof created, 'number');
  assert.equal(failed.length, 1);
  assert.equal(typeof failed[0].row, 'number');
  assert.ok(failed[0].errors.some(e => e.path === 'title' && typeof e.message === 'string' && e.message.length > 0), JSON.stringify(failed));
});

test('import of an unknown entity is 404 and a non-multipart body is 415', async () => {
  const { browser } = await verified();
  error(await browser.request(`${api}/entities/no_such_entity/import`, { method: 'POST', raw: csvFile('title\nx\n') }), 404, 'NOT_FOUND');
  error(await browser.request(`${notes}/import`, { method: 'POST', body: [{ title: 'x' }] }), 415, 'UNSUPPORTED_MEDIA_TYPE');
});

test('transfer wrong method returns 405 with the shared envelope', async () => {
  const { browser } = await verified();
  envelope(await browser.request(`${notes}/import`, { method: 'GET' }), 405, 'METHOD_NOT_ALLOWED');
  envelope(await browser.request(`${notes}/export?format=csv&scope=mine`, { method: 'PUT', body: {} }), 405, 'METHOD_NOT_ALLOWED');
});
