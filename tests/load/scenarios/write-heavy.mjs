import { randomBytes } from 'node:crypto';
import { Visitor } from '../lib/client.mjs';
import { RUN_ID } from '../lib/config.mjs';
import { pool } from '../lib/accounts.mjs';
import { BUDGETS, atLeast, atMost, check } from '../lib/budgets.mjs';
import { createWithRetry } from '../lib/seed.mjs';
import { Pacer, mapLimit, runFor, sleep } from '../lib/pool.mjs';
import { Recorder } from '../lib/stats.mjs';

export const id = 'write-heavy';
export const title = '2. write-heavy: 50 users update notes with If-Match';

const USERS = 50;
const WORKERS_PER_USER = 2; // two concurrent workers per user, sharing one IP and one pacer
const SETUP_NOTES = 4;
const CREATE_SHARE = 0.1;

// Writes go through the owner's own visitor, so all of one user's traffic shares one IP as in production.
export async function run({ duration = 60, log }) {
  const accounts = await pool({ log });
  const owners = accounts.slice(0, USERS);
  const users = owners.map((owner, index) => ({
    owner,
    index,
    visitor: new Visitor(),
    pacer: new Pacer(700), // at most ~85 writes/min per user, under the 120/min budget
    notes: [],
    counter: 0,
  }));

  // Setup: each user gets a few notes to contend over. Not measured.
  log(`  creating ${USERS * SETUP_NOTES} notes for contention`);
  await mapLimit(users, USERS, async user => {
    for (let k = 0; k < SETUP_NOTES; k++) {
      await user.pacer.turn();
      const body = `setup ${RUN_ID} owner ${user.index} note ${k}`;
      const response = await createWithRetry(
        user.visitor,
        user.owner.token,
        { data: { title: `wr ${RUN_ID} ${user.index}-${k}`, body } },
        `wr-${RUN_ID}-u${String(user.index).padStart(3, '0')}-n${k}`,
      );
      if (response.status !== 201 && response.status !== 200) throw new Error(`setup create: ${response.status} ${response.code}`);
      user.notes.push(tracked(response.json.data, body));
    }
  });

  const recorder = new Recorder();
  log(`  ${USERS * WORKERS_PER_USER} workers for ${duration} s`);
  const errors = await runFor(duration * 1000, USERS * WORKERS_PER_USER, async vu => {
    const user = users[vu % USERS];
    await user.pacer.turn();
    const { visitor, owner } = user;
    if (user.notes.length === 0 || Math.random() < CREATE_SHARE) {
      const body = `created by worker ${vu} at ${Date.now()}`;
      const response = await visitor.send('POST', '/api/v1/entities/notes', {
        token: owner.token,
        body: { data: { title: `wr ${RUN_ID} new`, body } },
      });
      recorder.record('create', response);
      if (response.status === 201) user.notes.push(tracked(response.json.data, body));
      return;
    }
    const note = user.notes[Math.floor(Math.random() * user.notes.length)];
    user.counter++;
    const body = `u${user.index} n${user.counter} ${randomBytes(6).toString('hex')}`;
    const response = await visitor.send('PATCH', `/api/v1/entities/notes/${note.id}`, {
      token: owner.token,
      headers: { 'if-match': `"${note.expected}"` },
      body: { data: { body } },
    });
    recorder.record('patch', response);
    if (response.status === 200) {
      note.expected = response.json.data.version;
      note.versions.push(note.expected);
      note.bodies.set(note.expected, body);
      note.successes++;
    } else if (response.status === 409 && response.code === 'VERSION_CONFLICT') {
      // The documented path: adopt the current version from details and try again later.
      note.conflicts++;
      note.expected = response.json.error.details.currentVersion;
    } else if (response.status === 429) {
      await sleep((response.retryAfter ?? 1) * 1000);
    } else {
      // Timeout, network error or 5xx: the write may or may not have been applied. Count it and re-read.
      note.unknown++;
      const current = await visitor.send('GET', `/api/v1/entities/notes/${note.id}`, { token: owner.token });
      if (current.status === 200) note.expected = current.json.data.version;
    }
  });
  recorder.stop();

  // Verification: re-read every tracked note and list every user's notes.
  const verification = await verify(users, log);
  const summary = recorder.summary();
  const { latency, rps } = summary;
  const unknown = recorder.countStatus(status => status === 0 || status >= 500);
  const rateLimited = recorder.countStatus(status => status === 429);
  const successes = verification.totalSuccesses;
  const conflicts = recorder.outcomes.get('409 VERSION_CONFLICT') ?? 0;

  return {
    id,
    title,
    summary,
    checks: [
      atMost('p95 latency (writes)', latency.p95, BUDGETS.write.p95Ms, ' ms'),
      atMost('p99 latency (writes)', latency.p99, BUDGETS.write.p99Ms, ' ms'),
      atLeast('throughput', rps, BUDGETS.write.minRps, ' req/s'),
      atMost('429 responses', rateLimited, BUDGETS.write.max429),
      atMost('unknown outcomes (timeouts, network, 5xx)', unknown, BUDGETS.write.maxUnknown),
      atMost('lost or phantom updates (final version outside 1 + successes .. + unknown)', verification.versionMismatches, BUDGETS.write.maxLostUpdates),
      atMost('duplicate or gapped versions across successful updates', verification.sequenceErrors, 0),
      atMost('body differs from the body written at the final version', verification.bodyMismatches, 0),
      atMost('wrong-owner or missing records (GET and list)', verification.wrongOwner + verification.missing, BUDGETS.write.maxWrongOwner),
      check('successful updates observed', successes > 0, `${successes}`, '> 0'),
    ],
    notes: [
      `notes tracked: ${verification.notes}; successful updates: ${successes}; version conflicts (409, expected under contention): ${conflicts}`,
      `outcomes: ${Object.entries(summary.outcomes).map(([key, count]) => `${key}: ${count}`).join(', ')}`,
      ...(errors.length ? [`${errors.length} client-side exceptions, first: ${errors[0]}`] : []),
    ],
  };
}

function tracked(record, body) {
  return {
    id: record.id,
    ownerId: record.ownerId,
    expected: record.version,
    versions: [record.version],
    bodies: new Map([[record.version, body]]),
    successes: 0,
    unknown: 0,
    conflicts: 0,
  };
}

async function verify(users, log) {
  const result = { totalSuccesses: 0, notes: 0, versionMismatches: 0, sequenceErrors: 0, bodyMismatches: 0, wrongOwner: 0, missing: 0 };
  await mapLimit(users, USERS, async user => {
    const { visitor, owner } = user;
    for (const note of user.notes) {
      result.notes++;
      result.totalSuccesses += note.successes;
      const response = await visitor.send('GET', `/api/v1/entities/notes/${note.id}`, { token: owner.token });
      if (response.status !== 200) {
        result.missing++;
        continue;
      }
      if (response.json.data.ownerId !== owner.id) result.wrongOwner++;
      const final = response.json.data.version;
      const low = 1 + note.successes;
      const high = low + note.unknown;
      if (final < low || final > high) result.versionMismatches++;
      const sorted = [...note.versions].sort((a, b) => a - b);
      const contiguous = sorted.every((version, i) => version === i + 1);
      if (note.unknown === 0 && (!contiguous || new Set(note.versions).size !== note.versions.length)) result.sequenceErrors++;
      if (note.unknown === 0 && note.bodies.has(final) && note.bodies.get(final) !== response.json.data.data.body) {
        result.bodyMismatches++;
      }
    }
    // Listing must contain only this user's records, and every tracked record must appear in it.
    const listed = new Set();
    let cursor = null;
    do {
      const page = await visitor.send('GET', `/api/v1/entities/notes?scope=mine&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { token: owner.token });
      if (page.status !== 200) {
        result.missing++;
        break;
      }
      for (const record of page.json.data) {
        if (record.ownerId !== owner.id) result.wrongOwner++;
        listed.add(record.id);
      }
      cursor = page.json.meta?.nextCursor ?? null;
    } while (cursor);
    for (const note of user.notes) if (!listed.has(note.id)) result.missing++;
  });
  log(`  verified ${result.notes} notes across ${users.length} users`);
  return result;
}
