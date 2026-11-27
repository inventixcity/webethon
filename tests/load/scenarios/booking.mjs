import { Visitor } from '../lib/client.mjs';
import { RUN_ID, BOOKING_OWNER_INDEX } from '../lib/config.mjs';
import { pool } from '../lib/accounts.mjs';
import { BUDGETS, atMost, check, exactly } from '../lib/budgets.mjs';
import { mapLimit } from '../lib/pool.mjs';
import { Recorder } from '../lib/stats.mjs';

export const id = 'booking';
export const title = '4. booking contention: 100 concurrent bookings for 5 slots of a capacity-1 resource';

const SLOTS = 5;
const ATTEMPTS = 100;

export async function run({ log }) {
  const accounts = await pool({ log });
  const owner = accounts[BOOKING_OWNER_INDEX];
  const bookers = accounts.slice(0, ATTEMPTS); // one distinct booker per attempt: no per-person caps apply
  const ownerVisitor = new Visitor();

  const created = await ownerVisitor.send('POST', '/api/v1/booking/resources', {
    token: owner.token,
    body: { name: `loadtest cap1 ${RUN_ID}`, timezone: 'UTC', slotMinutes: 60, capacity: 1, visibility: 'public' },
  });
  if (created.status !== 201) throw new Error(`create resource: ${created.status} ${created.code}`);
  const resource = created.json.data;
  const base = `/api/v1/booking/resources/${resource.id}`;

  try {
    const rules = await ownerVisitor.send('PUT', `${base}/availability`, {
      token: owner.token,
      body: { rules: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, startTime: '00:00', endTime: '24:00' })) },
    });
    if (rules.status !== 200) throw new Error(`set availability: ${rules.status} ${rules.code}`);

    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const listing = await ownerVisitor.send('GET', `${base}/slots?from=${from}&to=${to}`, { token: owner.token });
    if (listing.status !== 200) throw new Error(`list slots: ${listing.status} ${listing.code}`);
    const earliest = Date.now() + 2 * 3_600_000;
    const slots = listing.json.data.slots
      .filter(slot => Date.parse(slot.startsAt) >= earliest && slot.seatsLeft >= 1)
      .slice(0, SLOTS);
    if (slots.length < SLOTS) throw new Error(`only ${slots.length} free future slots`);

    log(`  ${ATTEMPTS} bookings released together on ${SLOTS} slots`);
    const recorder = new Recorder();
    const outcomes = await mapLimit(bookers.map((booker, index) => ({ booker, index })), ATTEMPTS, async ({ booker, index }) => {
      const slot = slots[index % SLOTS];
      const response = await new Visitor().send('POST', `${base}/bookings`, {
        token: booker.token,
        body: { startsAt: slot.startsAt, seats: 1 },
      });
      recorder.record('book', response);
      return { slot: slot.startsAt, response };
    });
    recorder.stop();

    const perSlot = new Map(slots.map(slot => [slot.startsAt, 0]));
    let succeeded = 0;
    let conflicts = 0;
    let unexpected = 0;
    for (const { slot, response } of outcomes) {
      if (response.status === 201) {
        succeeded++;
        perSlot.set(slot, perSlot.get(slot) + 1);
      } else if (response.status === 409 && response.code === 'CONFLICT') conflicts++;
      else unexpected++;
    }

    // What the database now says: one confirmed booking per slot, and no free seats left on those slots.
    const after = await ownerVisitor.send('GET', `${base}/bookings?when=upcoming&limit=100`, { token: owner.token });
    const confirmed = (after.json?.data ?? []).filter(booking => booking.status === 'confirmed');
    const distinctStarts = new Set(confirmed.map(booking => booking.startsAt)).size;
    const slotsAfter = await ownerVisitor.send('GET', `${base}/slots?from=${from}&to=${to}`, { token: owner.token });
    const freeAfter = (slotsAfter.json?.data?.slots ?? []).filter(slot => perSlot.has(slot.startsAt) && slot.seatsLeft > 0).length;

    const summary = recorder.summary();
    return {
      id,
      title,
      summary,
      checks: [
        exactly('successful bookings (201)', succeeded, BUDGETS.booking.seats),
        exactly('slots with exactly one booking', [...perSlot.values()].filter(count => count === 1).length, SLOTS),
        exactly('conflicting attempts (409 CONFLICT)', conflicts, ATTEMPTS - BUDGETS.booking.seats),
        atMost('responses that are neither 201 nor 409 CONFLICT', unexpected, 0),
        exactly('confirmed bookings stored (owner view)', confirmed.length, BUDGETS.booking.seats),
        exactly('distinct start times stored', distinctStarts, BUDGETS.booking.seats),
        exactly('slots still showing free seats afterwards', freeAfter, 0),
        atMost('p95 latency (booking attempts)', summary.latency.p95, BUDGETS.booking.p95Ms, ' ms'),
        check('owner view readable', after.status === 200, `${after.status}`, '200'),
      ],
      notes: [
        `resource ${resource.id.slice(0, 8)} (deleted at the end); slots used: ${slots.map(slot => slot.startsAt).join(', ')}`,
        `outcomes: ${Object.entries(summary.outcomes).map(([key, count]) => `${key}: ${count}`).join(', ')}`,
      ],
    };
  } finally {
    await ownerVisitor.send('DELETE', base, { token: owner.token });
  }
}
