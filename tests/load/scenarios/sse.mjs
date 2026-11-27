import { Visitor } from '../lib/client.mjs';
import { RUN_ID } from '../lib/config.mjs';
import { pool } from '../lib/accounts.mjs';
import { BUDGETS, atMost, check, exactly } from '../lib/budgets.mjs';
import { runFor, sleep, within } from '../lib/pool.mjs';
import { subscribe } from '../lib/sse.mjs';
import { summarize } from '../lib/stats.mjs';

export const id = 'sse';
export const title = '5. SSE: 300 realtime subscribers while 20 writers create notes';

// Each user may hold 5 streams (hub.acquire), so 300 subscribers need 60 users. Writers are the first 20 of
// those users, so each writer's own five streams receive its changes. The other 40 users subscribe and must
// receive nothing belonging to anyone else.
const USERS = 60;
const STREAMS_PER_USER = 5;
const WRITERS = 20;
const DRAIN_MS = 3000;

export async function run({ duration = 30, log }) {
  const accounts = await pool({ log });
  const streams = [];
  for (let user = 0; user < USERS; user++) {
    for (let s = 0; s < STREAMS_PER_USER; s++) {
      streams.push({
        userIndex: user,
        userId: accounts[user].id,
        subscriber: subscribe('/api/v1/entities/notes/events?scope=mine', accounts[user].token),
      });
    }
  }
  log(`  opening ${streams.length} streams`);
  const readiness = await Promise.all(streams.map(stream => within(stream.subscriber.ready, 20_000, false)));
  const open = readiness.filter(Boolean).length;
  await sleep(500);

  const created = []; // { id, ownerId, sentAt }
  const writerFailures = [];
  log(`  ${WRITERS} writers for ${duration} s`);
  const writerVisitors = Array.from({ length: WRITERS }, () => new Visitor());
  const writes = [];
  await runFor(duration * 1000, WRITERS, async writer => {
    const visitor = writerVisitors[writer];
    const sentAt = performance.now();
    const response = await visitor.send('POST', '/api/v1/entities/notes', {
      token: accounts[writer].token,
      body: { data: { title: `sse ${RUN_ID} w${writer} ${writes.length}` } },
    });
    writes.push(response.ms);
    if (response.status === 201) created.push({ id: response.json.data.id, ownerId: response.json.data.ownerId, sentAt });
    else writerFailures.push(`${response.status} ${response.code ?? ''}`.trim());
    await sleep(1200 + Math.random() * 600);
  });

  await sleep(DRAIN_MS);
  for (const stream of streams) stream.subscriber.controller.abort();
  await Promise.all(streams.map(stream => stream.subscriber.done));

  const createdById = new Map(created.map(record => [record.id, record]));
  const expectedPerStream = new Map();
  for (const record of created) expectedPerStream.set(record.ownerId, (expectedPerStream.get(record.ownerId) ?? 0) + 1);

  let delivered = 0;
  let leaks = 0;
  let unattributed = 0;
  let missing = 0;
  let resyncs = 0;
  let parseErrors = 0;
  let opDifferent = 0;
  const latencies = [];
  for (const stream of streams) {
    const seen = new Set();
    for (const frame of stream.subscriber.frames) {
      if (frame.event === 'resync') {
        resyncs++;
        continue;
      }
      if (frame.event !== 'change') continue;
      let payload;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        parseErrors++;
        continue;
      }
      const record = createdById.get(payload.id);
      if (!record) {
        unattributed++;
        continue;
      }
      if (record.ownerId !== stream.userId) {
        leaks++;
        continue;
      }
      if (payload.op !== 'insert' || payload.entity !== 'notes') opDifferent++;
      seen.add(payload.id);
      delivered++;
      latencies.push(frame.at - record.sentAt);
    }
    const owned = expectedPerStream.get(stream.userId) ?? 0;
    missing += owned - seen.size;
  }

  const latency = summarize(latencies);
  const writeLatency = summarize(writes);
  const writesOk = created.length;
  return {
    id,
    title,
    summary: null,
    latency,
    rps: writesOk / duration,
    requests: writes.length,
    checks: [
      exactly('streams opened (200 and first frame)', open, USERS * STREAMS_PER_USER),
      atMost('events delivered to another user (leaks)', leaks, BUDGETS.sse.maxLeaks),
      atMost('events for ids not created in this run', unattributed, 0),
      atMost('expected deliveries missing (per owner stream)', missing, BUDGETS.sse.maxMissing),
      atMost('writer failures', writerFailures.length, 0),
      atMost('p95 delivery latency (write sent to event received)', latency.p95, BUDGETS.sse.p95DeliveryMs, ' ms'),
      atMost('p99 delivery latency', latency.p99, BUDGETS.sse.p99DeliveryMs, ' ms'),
      atMost('malformed event payloads', parseErrors, 0),
      check('events for records of this run were delivered', delivered > 0, `${delivered}`, '> 0'),
    ],
    notes: [
      `writer POST latency (the write path alone): p50 ${writeLatency.p50} ms, p95 ${writeLatency.p95} ms, p99 ${writeLatency.p99} ms, max ${writeLatency.max} ms`,
      `writes: ${writesOk} created of ${writes.length} attempted; expected deliveries: ${created.length * STREAMS_PER_USER}; received: ${delivered}`,
      `resync frames: ${resyncs}; stream errors: ${streams.filter(stream => stream.subscriber.error).length}; non-200 opens: ${streams.filter(stream => stream.subscriber.status !== null && stream.subscriber.status !== 200).length}`,
      `events with a different op or entity than insert/notes: ${opDifferent}`,
      ...(writerFailures.length ? [`writer failures: ${[...new Set(writerFailures)].join(', ')}`] : []),
    ],
  };
}
