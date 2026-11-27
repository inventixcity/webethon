let offsetMs = 0;

/** Update the server-clock offset from an RFC 3339 serverNow value. */
export function observeServerTime(serverNow: string): void {
  const parsed = Date.parse(serverNow);
  if (Number.isFinite(parsed)) offsetMs = parsed - performance.now();
}

/** Estimated server epoch milliseconds, based on monotonic time rather than the device clock. */
export function serverNowMs(): number {
  return performance.now() + offsetMs;
}

export function serverOffsetMs(): number {
  return offsetMs;
}
