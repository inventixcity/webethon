// Latency percentiles and outcome counts. Percentiles use nearest rank on the sorted samples.

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

const round = value => (value === null || value === undefined ? null : Math.round(value * 10) / 10);

export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? null),
    mean: round(mean),
  };
}

// Collects every response a scenario makes. Outcome keys look like "200", "429 RATE_LIMITED", "0 TIMEOUT".
export class Recorder {
  constructor() {
    this.byOp = new Map();
    this.outcomes = new Map();
    this.total = 0;
    this.started = performance.now();
    this.finished = null;
  }

  record(op, response) {
    this.total++;
    if (!this.byOp.has(op)) this.byOp.set(op, []);
    this.byOp.get(op).push(response.ms);
    const key = `${response.status}${response.code ? ` ${response.code}` : ''}`;
    this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);
  }

  stop() {
    this.finished = performance.now();
  }

  get elapsedSeconds() {
    return ((this.finished ?? performance.now()) - this.started) / 1000;
  }

  allLatencies() {
    return [...this.byOp.values()].flat();
  }

  // Count of outcomes whose HTTP status matches the predicate.
  countStatus(predicate) {
    let total = 0;
    for (const [key, count] of this.outcomes) {
      if (predicate(Number(key.split(' ')[0]))) total += count;
    }
    return total;
  }

  summary() {
    const seconds = this.elapsedSeconds;
    return {
      requests: this.total,
      seconds: round(seconds),
      rps: seconds > 0 ? round(this.total / seconds) : null,
      latency: summarize(this.allLatencies()),
      byOp: Object.fromEntries([...this.byOp].map(([op, values]) => [op, summarize(values)])),
      outcomes: Object.fromEntries([...this.outcomes].sort(([a], [b]) => a.localeCompare(b))),
    };
  }
}
