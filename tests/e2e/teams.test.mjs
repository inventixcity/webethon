import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verified } from './lib/fixtures.mjs';
import { messageIds } from './lib/mail.mjs';
import { status, error } from './lib/assert.mjs';

async function inviteToken(address, before) {
  const base = (process.env.MAILPIT_URL || 'http://localhost:8025').replace(/\/$/, '');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const id of await messageIds(address)) {
      if (before.includes(id)) continue;
      const response = await fetch(`${base}/api/v1/message/${encodeURIComponent(id)}`);
      assert.equal(response.status, 200);
      const mail = await response.json();
      const match = [mail.Text, mail.HTML].filter(Boolean).join(' ').match(/[?&]token=([a-zA-Z0-9_-]+)/);
      if (match) return match[1];
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Timed out waiting for team invite');
}

test('team invitations, roles, transfer and removal', async () => {
  const owner = await verified(), member = await verified(), outsider = await verified();
  const team = status(await owner.browser.post('/api/v1/teams', { name: 'E2E workspace' }), 201).json.data;
  const path = `/api/v1/teams/${team.id}`;
  error(await outsider.browser.get(path), 404);
  const before = await messageIds(member.address);
  const invite = status(await owner.browser.post(`${path}/invites`, { email: member.address, role: 'viewer' }), 201).json.data;
  assert.equal(invite.token, undefined);
  const token = await inviteToken(member.address, before);
  error(await outsider.browser.post('/api/v1/teams/invites/accept', { token }), 403);
  assert.equal(status(await member.browser.post('/api/v1/teams/invites/accept', { token }), 200).json.data.role, 'viewer');
  error(await member.browser.post('/api/v1/teams/invites/accept', { token }), 404);
  error(await member.browser.patch(path, { name: 'No' }), 403);
  const members = status(await member.browser.get(`${path}/members`), 200).json.data;
  assert.ok(members.every(m => m.email == null));
  status(await owner.browser.patch(`${path}/members/${member.user.id}`, { role: 'admin' }), 200);
  error(await member.browser.delete(`${path}/members/${owner.user.id}`), 403);
  error(await owner.browser.delete(`${path}/members/${owner.user.id}`), 409);
  status(await owner.browser.post(`${path}/transfer`, { userId: member.user.id }), 200);
  assert.equal(status(await member.browser.get(path), 200).json.data.role, 'owner');
  status(await member.browser.delete(`${path}/members/${owner.user.id}`), 204);
  error(await member.browser.delete(`${path}/members/${owner.user.id}`), 404);
  error(await owner.browser.get(path), 404);
});


