import { Visitor } from './client.mjs';
import { Pacer, mapLimit, sleep } from './pool.mjs';

// Deterministic note content: the same (owner, index) always produces the same body, so a replayed
// idempotency key is a true replay of the same request.
const WORDS = ['garden', 'budget', 'invoice', 'meeting', 'groceries', 'travel', 'recipe', 'project', 'reading',
  'workout', 'garage', 'holiday', 'school', 'council', 'library', 'weekly', 'review', 'ideas', 'quotes', 'movies'];
const TAGS = ['home', 'work', 'family', 'health', 'finance', 'ideas'];

function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedNote(ownerIndex, index) {
  const random = generator(ownerIndex * 100_003 + index * 7 + 1);
  const pick = list => list[Math.floor(random() * list.length)];
  const words = Array.from({ length: 20 + Math.floor(random() * 40) }, () => pick(WORDS));
  const tags = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(TAGS));
  return {
    data: {
      title: `Seed ${ownerIndex}-${index} ${pick(WORDS)} ${pick(WORDS)}`.slice(0, 200),
      body: words.join(' '),
      pinned: random() < 0.2,
      tags: [...new Set(tags)],
    },
  };
}

// Counts the caller's notes via the analytics stats endpoint. Null if the endpoint is unavailable.
export async function countNotes(token) {
  const response = await new Visitor().send('GET', '/api/v1/entities/notes/stats?metric=count&scope=mine', { token });
  if (response.status !== 200) return null;
  return Number(response.json?.data?.[0]?.value ?? 0);
}

// Creates a record and retries 429 (after Retry-After) and 5xx. Used only for setup, never for measurements.
export async function createWithRetry(visitor, token, body, key) {
  for (let attempt = 1; ; attempt++) {
    const response = await visitor.send('POST', '/api/v1/entities/notes', {
      token,
      body,
      headers: { 'idempotency-key': key },
    });
    if (response.status === 200 || response.status === 201) return response;
    const retryable = response.status === 429 || response.status === 0 || response.status >= 500;
    if (!retryable || attempt >= 6) return response;
    await sleep((response.retryAfter ?? 2) * 1000 + 100);
  }
}

// Seeds `perOwner` notes for each owner, idempotently: keys are fixed per (owner, index), so a rerun replays
// rather than duplicates. Owners that already have enough notes are skipped without any writes.
export async function seedNotes(owners, perOwner, { log } = {}) {
  let created = 0;
  let skipped = 0;
  await mapLimit(owners, owners.length, async (owner, ownerIndex) => {
    const existing = await countNotes(owner.token);
    if (existing !== null && existing >= perOwner) {
      skipped++;
      return;
    }
    const visitor = new Visitor();
    const pacer = new Pacer(520); // stays under 120 writes/min for this owner's IP
    for (let index = 0; index < perOwner; index++) {
      await pacer.turn();
      const key = `seed-v1-u${String(ownerIndex).padStart(3, '0')}-n${String(index).padStart(4, '0')}`;
      const response = await createWithRetry(visitor, owner.token, seedNote(ownerIndex, index), key);
      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`seeding owner ${ownerIndex} index ${index}: ${response.status} ${response.code}`);
      }
      created++;
    }
    if (log && ownerIndex % 10 === 0) log(`  seeded owner ${ownerIndex}`);
  });
  return { created, skippedOwners: skipped };
}
