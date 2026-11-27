// A small async worker pool. No dependencies.

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Resolves with `promise`, or with `fallback` after `ms`. The timer is unref'd and cleared, so it never keeps
// the process alive on its own.
export function within(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs fn over items with at most `limit` in flight. Results keep the input order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// Runs `workers` concurrent loops until the deadline. `step(vu)` runs once per iteration. Exceptions are
// caught and returned, so one failing iteration never stops a virtual user.
export async function runFor(durationMs, workers, step) {
  const deadline = performance.now() + durationMs;
  const errors = [];
  await Promise.all(
    Array.from({ length: workers }, (_, vu) =>
      (async () => {
        while (performance.now() < deadline) {
          try {
            await step(vu, deadline);
          } catch (error) {
            errors.push(String(error?.message ?? error));
          }
        }
      })(),
    ),
  );
  return errors;
}

// Spaces calls at least `intervalMs` apart. One pacer can be shared by several workers that act as one user.
export class Pacer {
  constructor(intervalMs) {
    this.interval = intervalMs;
    this.next = 0;
  }

  async turn() {
    const now = performance.now();
    const at = Math.max(now, this.next);
    this.next = at + this.interval;
    if (at > now) await sleep(at - now);
  }
}
