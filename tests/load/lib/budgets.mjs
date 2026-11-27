// Pass/fail budgets. Each one is justified in tests/load/README.md; keep the two in step.
//
// Numbers are for the local debug build (wa-api-dev, Docker Desktop on Windows, Postgres in a container), which
// is slower than a release build on a real host. They are deliberately generous for latency and strict for
// correctness: a lost update, a leaked record id or an unexpected 5xx is never acceptable at any speed.
export const BUDGETS = {
  read: {
    p95Ms: 500, // page-load threshold a person notices; a list or read of a few hundred notes stays under it
    p99Ms: 1500, // tail ceiling for a debug build; catches stalls such as lock waits or pool starvation
    minRps: 100, // closed-loop runs (think time 0) only: a floor so the run cannot pass by sending almost nothing
    offeredShare: 0.9, // with think time, achieved throughput must reach 90% of VUs / (think + mean latency)
    maxNon2xx: 0, // paced under 600 reads/min per IP, so any 429 or 5xx is a regression
    minNotesSeeded: 10_000, // precondition: the scenario must actually test a 10k-note dataset
  },
  write: {
    p95Ms: 800, // a PATCH runs validation, a row lock and an event; allow about 1.6x the read p95
    p99Ms: 2000,
    minRps: 20,
    max429: 0, // paced under 120 writes/min per IP
    maxUnknown: 0, // timeouts and 5xx leave the outcome unknown; none are allowed in a clean run
    maxLostUpdates: 0, // final version must equal 1 + successful updates
    maxWrongOwner: 0, // any record with a foreign ownerId, or any missing record, is a data-isolation failure
  },
  auth: {
    healthP95Ms: 200, // health probe during the storm; liveness must not degrade under auth load
    healthMaxNon200: 0,
    expectedAccepted401: 390, // IP phase 100 + account phase 40 + background 250
    expectedRateLimited: 110, // IP phase 50 + account phase 60
  },
  booking: {
    seats: 5, // exactly one success per slot on a capacity-1 resource, across 5 slots
    p95Ms: 1000, // a booking takes a transaction, an advisory lock and a constraint check
  },
  sse: {
    subscribers: 300,
    p95DeliveryMs: 500, // notify-driven delivery should be near immediate; 500 ms covers debug and Docker
    p99DeliveryMs: 1000,
    maxLeaks: 0, // a scope=mine stream must never carry an id owned by another user
    maxMissing: 0, // every change from a writer must reach each of its owner's five streams
  },
  soak: {
    p95Ms: 500,
    maxUnexpectedErrors: 0,
    maxMemoryGrowthPct: 25, // allocator and cache warm-up is normal; more than 25% in 10 minutes needs a look
  },
};

export function check(name, pass, actual, budget) {
  return { name, pass: Boolean(pass), actual, budget };
}

// A check that could not be measured in this environment. It is reported as SKIP and does not fail the run.
export function skipped(name, reason) {
  return { name, pass: true, skipped: true, actual: `skipped: ${reason}`, budget: '' };
}

// Compare a measured value with an upper bound. An unavailable value (null) fails, so a missing metric
// cannot make a check pass by accident.
export function atMost(name, actual, limit, unit = '') {
  return check(name, actual !== null && actual !== undefined && actual <= limit, `${actual}${unit}`, `<= ${limit}${unit}`);
}

export function atLeast(name, actual, limit, unit = '') {
  return check(name, actual !== null && actual !== undefined && actual >= limit, `${actual}${unit}`, `>= ${limit}${unit}`);
}

export function exactly(name, actual, expected) {
  return check(name, actual === expected, `${actual}`, `= ${expected}`);
}
