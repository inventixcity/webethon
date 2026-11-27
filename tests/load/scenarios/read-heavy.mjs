import { Visitor } from '../lib/client.mjs';
import { pool } from '../lib/accounts.mjs';
import { BUDGETS, atLeast, atMost } from '../lib/budgets.mjs';
import { countNotes, seedNotes } from '../lib/seed.mjs';
import { runFor } from '../lib/pool.mjs';
import { Recorder } from '../lib/stats.mjs';
import { readUser } from '../lib/steps.mjs';

export const id = 'read-heavy';
export const title = '1. read-heavy: 200 virtual users list and read notes';

const USERS = 50; // owners of the seeded notes
const NOTES_PER_OWNER = 200; // 50 x 200 = 10,000 notes
const VUS = 200; // each VU is one visitor with its own IP; VU i reads as owner i % 50

export async function run({ duration = 60, thinkMs = 2000, log }) {
  const accounts = await pool({ log });
  const owners = accounts.slice(0, USERS);

  log(`  seeding ${USERS * NOTES_PER_OWNER} notes (idempotent, keyed per owner and index)`);
  const seed = await seedNotes(owners, NOTES_PER_OWNER, { log });

  let seededTotal = 0;
  for (const owner of owners) seededTotal += (await countNotes(owner.token)) ?? 0;

  log(`  ${VUS} virtual users for ${duration} s, think time ${thinkMs} ms (0 = closed loop)`);
  const users = Array.from({ length: VUS }, (_, vu) =>
    readUser({ visitor: new Visitor(), token: owners[vu % USERS].token, vu, thinkMs }),
  );
  const recorder = new Recorder();
  const errors = await runFor(duration * 1000, VUS, vu => users[vu](recorder));
  recorder.stop();

  const summary = recorder.summary();
  const non2xx = recorder.countStatus(status => status < 200 || status >= 300);
  const outcomeLines = Object.entries(summary.outcomes).map(([key, count]) => `${key}: ${count}`);
  const { latency, byOp, rps } = summary;

  // With think time, throughput is set by the users, not the server: each VU issues one request per iteration,
  // so the offered rate is VUs / (think + latency). The check catches a client that stalls, not a slow server.
  // A closed loop (no think time) is a saturation test, so its floor is the absolute 100 req/s.
  const offered = thinkMs > 0 ? VUS / (thinkMs / 1000 + latency.mean / 1000) : null;
  const throughput = offered
    ? atLeast('throughput vs offered load (VUs / (think + mean latency))', rps, Math.round(offered * BUDGETS.read.offeredShare * 10) / 10, ' req/s')
    : atLeast('throughput (closed loop)', rps, BUDGETS.read.minRps, ' req/s');

  return {
    id,
    title,
    summary,
    checks: [
      atLeast('notes in the seeded dataset', seededTotal, BUDGETS.read.minNotesSeeded),
      atMost('p95 latency (all reads)', latency.p95, BUDGETS.read.p95Ms, ' ms'),
      atMost('p99 latency (all reads)', latency.p99, BUDGETS.read.p99Ms, ' ms'),
      throughput,
      atMost('non-2xx responses', non2xx, BUDGETS.read.maxNon2xx),
    ],
    notes: [
      `seeded this run: ${seed.created} submissions across ${seed.skippedOwners} owners that already had enough notes`,
      `outcomes: ${outcomeLines.join(', ')}`,
      `per operation p95: ${Object.entries(byOp).map(([op, value]) => `${op} ${value.p95} ms`).join(', ')}`,
      ...(errors.length ? [`${errors.length} client-side exceptions, first: ${errors[0]}`] : []),
    ],
  };
}
