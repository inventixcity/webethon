import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verified } from './lib/fixtures.mjs';
import { error, status } from './lib/assert.mjs';
import { adminSignin, enabled, noSecrets, root } from './lib/admin-fixture.mjs';

test('management and payment endpoints reject ordinary accounts', async () => {
  const user = await verified();
  for (const path of ['/places', '/jobs', '/teams', '/bookings', '/payments/purchases', '/payments/entitlements']) {
    error(await user.browser.get(root + path), 403, 'FORBIDDEN');
  }
  for (const path of ['/places/not-a-uuid/hide', '/places/not-a-uuid/unhide', '/jobs/not-a-uuid/retry', '/jobs/not-a-uuid/cancel', '/payments/entitlements/grant', '/payments/entitlements/revoke']) {
    error(await user.browser.post(root + path, {}), 403, 'FORBIDDEN');
  }
});

test('overview and system responses expose counters without secrets', { skip: !enabled }, async () => {
  const admin = await adminSignin();
  const overview = status(await admin.browser.get(`${root}/overview`), 200).json.data;
  for (const key of ['users', 'activeSessions', 'auditEvents', 'httpErrorRate', 'http429Rate']) assert.equal(typeof overview[key], 'number');
  const system = status(await admin.browser.get(`${root}/system`), 200).json.data;
  assert.equal(system.database, 'healthy');
  noSecrets(system);
});
