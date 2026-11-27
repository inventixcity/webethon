import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verified } from './lib/fixtures.mjs';
import { status, error } from './lib/assert.mjs';

const put = (b, path, body) => b.request(path, { method: 'PUT', body });
test('slots respect DST, capacity under concurrency, cancellation and limits', async () => {
  const owner = await verified(), booker = await verified();
  const resource = status(await owner.browser.post('/api/v1/booking/resources', { name: 'E2E seat', timezone: 'Europe/London', slotMinutes: 60, capacity: 1, visibility: 'public' }), 201).json.data;
  const path = `/api/v1/booking/resources/${resource.id}`;
  status(await put(owner.browser, `${path}/availability`, { rules: Array.from({length: 7}, (_, weekday) => ({ weekday, startTime: '00:00', endTime: '24:00' })) }), 200);
  const year = new Date().getUTCFullYear() + 1;
  const lastSunday = month => { const d = new Date(Date.UTC(year, month + 1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.toISOString().slice(0, 10); };
  for (const [date, count] of [[lastSunday(2), 23], [lastSunday(9), 25]]) {
    const data = status(await owner.browser.get(`${path}/slots?from=${date}&to=${date}`), 200).json.data;
    assert.equal(data.timezone, 'Europe/London');
    assert.equal(data.slots.length, count);
  }
  error(await owner.browser.get(`${path}/slots?from=${year}-01-01&to=${year}-04-01`), 400);
  const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const slot = status(await owner.browser.get(`${path}/slots?from=${date}&to=${date}`), 200).json.data.slots[0];
  const results = await Promise.all(Array.from({length: 20}, () => booker.browser.post(`${path}/bookings`, { startsAt: slot.startsAt })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 19);
  assert.ok(results.every(r => r.status < 500), 'no 5xx under concurrent booking');
  for (const r of results.filter(r => r.status === 409)) assert.equal(r.json?.error?.code, 'CONFLICT');
  const booking = results.find(r => r.status === 201).json.data;
  assert.equal(status(await owner.browser.post(`/api/v1/booking/bookings/${booking.id}/cancel`, {}), 200).json.data.status, 'cancelled');
  assert.equal(status(await booker.browser.post(`/api/v1/booking/bookings/${booking.id}/cancel`, {}), 200).json.data.status, 'cancelled');
  error(await booker.browser.post(`${path}/bookings`, { startsAt: slot.startsAt, seats: 2 }), 400);
});
