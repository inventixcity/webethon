import { Visitor } from '../lib/client.mjs';
import { DOCKER_CONTAINER, RUN_ID } from '../lib/config.mjs';
import { pool } from '../lib/accounts.mjs';
import { BUDGETS, atMost, check, skipped } from '../lib/budgets.mjs';
import { containerMemory } from '../lib/docker.mjs';
import { seedNotes } from '../lib/seed.mjs';
import { Pacer, runFor, sleep } from '../lib/pool.mjs';
import { Recorder } from '../lib/stats.mjs';
import { subscribe } from '../lib/sse.mjs';
import { readUser } from '../lib/steps.mjs';

export const id = 'soak';
export const title = '6. soak: mixed traffic for 10 minutes, with memory of the API container';

// Mixed steady traffic: 60 readers, 10 writers, 20 realtime streams. The point is the trend, not a peak:
// memory is sampled before the load, once a minute during it, and after it.
export async function run({ duration = 600, log }) {
  const accounts = await pool({ log });
  const owners = accounts.slice(0, 50);
  await seedNotes(owners, 200, { log });

  const memory = [];
  const sample = async label => {
    const reading = await containerMemory(DOCKER_CONTAINER);
    memory.push({ label, ...reading, at: new Date().toISOString() });
    return reading;
  };
  const before = await sample('before');
  log(`  memory before: ${before.error ? `unavailable (${before.error})` : `${before.mib} MiB`}`);

  const readers = Array.from({ length: 60 }, (_, vu) =>
    readUser({ visitor: new Visitor(), token: owners[vu % owners.length].token, vu, thinkMs: 2000 }),
  );

  const writers = accounts.slice(0, 10).map((owner, index) => ({
    owner,
    index,
    visitor: new Visitor(),
    pacer: new Pacer(800),
    note: null,
    expected: null,
  }));
  for (const writer of writers) {
    const created = await writer.visitor.send('POST', '/api/v1/entities/notes', {
      token: writer.owner.token,
      body: { data: { title: `soak ${RUN_ID} ${writer.index}`, body: 'start' } },
    });
    if (created.status !== 201) throw new Error(`soak writer setup: ${created.status} ${created.code}`);
    writer.note = created.json.data.id;
    writer.expected = created.json.data.version;
  }

  const streams = [];
  for (let user = 0; user < 4; user++) {
    for (let s = 0; s < 5; s++) {
      streams.push(subscribe('/api/v1/entities/notes/events?scope=mine', accounts[user].token));
    }
  }
  await Promise.all(streams.map(stream => stream.ready));

  const recorder = new Recorder();
  const unexpected = { count: 0, first: null };
  const note = (response, expectConflict = false) => {
    const ok = response.status === 200 || response.status === 201 || response.status === 204 || (expectConflict && response.status === 409);
    if (!ok) {
      unexpected.count++;
      unexpected.first ??= `${response.status} ${response.code ?? ''}`.trim();
    }
  };

  const samplerDone = (async () => {
    const until = Date.now() + duration * 1000;
    while (Date.now() < until) {
      await sleep(Math.min(60_000, until - Date.now()));
      if (Date.now() < until) await sample('during');
    }
  })();

  const readerErrors = await runFor(duration * 1000, readers.length + writers.length, async vu => {
    if (vu < readers.length) {
      await readers[vu](recorder);
      return;
    }
    const writer = writers[vu - readers.length];
    await writer.pacer.turn();
    const body = `soak ${Date.now()}`;
    const response = await writer.visitor.send('PATCH', `/api/v1/entities/notes/${writer.note}`, {
      token: writer.owner.token,
      headers: { 'if-match': `"${writer.expected}"` },
      body: { data: { body } },
    });
    recorder.record('write', response);
    if (response.status === 200) writer.expected = response.json.data.version;
    else if (response.status === 409 && response.code === 'VERSION_CONFLICT') writer.expected = response.json.error.details.currentVersion;
    note(response, true);
  });
  recorder.stop();
  await samplerDone;

  const streamErrors = streams.filter(stream => stream.error || stream.status !== 200).length;
  const frames = streams.reduce((sum, stream) => sum + stream.frames.length, 0);
  for (const stream of streams) stream.controller.abort();
  await Promise.all(streams.map(stream => stream.done));

  const after = await sample('after');
  const growth = before.mib && after.mib ? ((after.mib - before.mib) / before.mib) * 100 : null;
  const memoryChecks = before.error || after.error || growth === null
    ? [skipped('memory growth over the soak', before.error ?? after.error ?? 'docker stats unavailable')]
    : [atMost('memory growth over the soak (%)', Math.round(growth * 10) / 10, BUDGETS.soak.maxMemoryGrowthPct, '%')];

  const summary = recorder.summary();
  return {
    id,
    title,
    summary,
    checks: [
      atMost('p95 latency (reads and writes)', summary.latency.p95, BUDGETS.soak.p95Ms, ' ms'),
      atMost('unexpected responses (not 2xx, 409 on writes allowed)', unexpected.count, BUDGETS.soak.maxUnexpectedErrors),
      atMost('reader or writer exceptions', readerErrors.length, 0),
      atMost('realtime streams that errored or closed early', streamErrors, 0),
      check('realtime frames received', frames > 0, `${frames}`, '> 0'),
      ...memoryChecks,
    ],
    notes: [
      `memory samples (MiB): ${memory.map(item => `${item.label} ${item.error ? 'n/a' : item.mib}`).join(', ')}`,
      `memory before ${before.error ?? `${before.mib} MiB`}, after ${after.error ?? `${after.mib} MiB`}${growth === null ? '' : ` (${growth.toFixed(1)}%)`}`,
      unexpected.first ? `first unexpected response: ${unexpected.first}` : 'no unexpected responses',
      ...(readerErrors.length ? [`first exception: ${readerErrors[0]}`] : []),
    ],
    memory,
  };
}
