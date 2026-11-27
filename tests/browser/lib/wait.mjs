/**
 * Polls `check` until it returns a truthy value, or throws `message` once `timeout` passes. Used where the page
 * offers no event to wait on, such as a WebGL canvas that is only known to be drawn by looking at its pixels.
 * Each attempt is awaited, so checks never overlap.
 */
export async function eventually(check, { timeout = 45_000, interval = 500, message = "condition not met in time" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() >= deadline) throw new Error(`${message} (last value: ${JSON.stringify(last)})`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
