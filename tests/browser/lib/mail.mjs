import { MAILPIT_URL } from "./config.mjs";

/** Extracts a six-digit code from a Mailpit message (text or HTML part). */
export function extractCode(message) {
  const body = [message.Text, message.HTML].filter(Boolean).join("\n").replace(/<[^>]*>/g, " ");
  return body.match(/(?<!\d)\d{6}(?!\d)/)?.[0];
}

async function mailpit(path, init) {
  const response = await fetch(`${MAILPIT_URL}${path}`, init);
  if (!response.ok) throw new Error(`Mailpit ${init?.method || "GET"} ${path} returned ${response.status}`);
  return response;
}

/** Ids of every message addressed to `email`. Take this snapshot before the action that sends mail. */
export async function messageIds(email) {
  const payload = await (await mailpit("/api/v1/messages?limit=200")).json();
  const wanted = email.toLowerCase();
  return (payload.messages || [])
    .filter((message) => (message.To || []).some((to) => to.Address?.toLowerCase() === wanted))
    .map((message) => message.ID);
}

/**
 * Waits for a six-digit code in a message to `email` that wasn't in `previous`. Polls Mailpit, which is a
 * network call, so the wait is bounded by a deadline rather than a fixed sleep.
 */
/**
 * Waits for a message to `email` whose text matches `pattern` and returns the first match. Messages in
 * `previous` are ignored. Used for links such as a team invitation.
 */
export async function waitForMatch(email, pattern, previous = [], { timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const id of await messageIds(email)) {
      if (previous.includes(id)) continue;
      const message = await (await mailpit(`/api/v1/message/${encodeURIComponent(id)}`)).json();
      const text = [message.Text, message.HTML].filter(Boolean).join("\n");
      const match = text.match(pattern);
      if (match) return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No new email matching ${pattern} arrived for ${email} within ${timeout} ms`);
}

export async function waitForCode(email, previous = [], { timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const id of await messageIds(email)) {
      if (previous.includes(id)) continue;
      const message = await (await mailpit(`/api/v1/message/${encodeURIComponent(id)}`)).json();
      const code = extractCode(message);
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No new email code arrived for ${email} within ${timeout} ms (is Mailpit reachable at ${MAILPIT_URL}?)`);
}
