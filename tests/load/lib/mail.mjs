import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAILPIT_URL } from './config.mjs';
import { sleep } from './pool.mjs';

// CODE_SOURCE=api-log reads codes from the API's own log instead of Mailpit. The kind overlay runs the API with
// its development log sender ("email (not sent: development log sender)"), so codes never reach Mailpit there.
// API_LOG_COMMAND is the command that prints the API log, split on spaces, e.g.
// "kubectl -n invigil logs deploy/api --since=10m". It is run without a shell.
const CODE_SOURCE = process.env.CODE_SOURCE || 'mailpit';
const API_LOG_COMMAND = (process.env.API_LOG_COMMAND || 'kubectl -n invigil logs deploy/api --since=15m').split(' ');
const run = promisify(execFile);

// Every code the API has logged for this address, oldest first.
async function codesFromApiLog(email) {
  const [program, ...args] = API_LOG_COMMAND;
  const { stdout } = await run(program, args, { maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const codes = [];
  // tracing colours field names, so strip ANSI escape codes before matching.
  for (const line of stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    if (!line.includes(`to: ${email},`)) continue;
    const code = line.match(/Your code: (\d{6})(?!\d)/)?.[1];
    if (code) codes.push(code);
  }
  return codes;
}

// Reads verification codes from Mailpit, as the e2e suite does. Mailpit's search endpoint is used so that
// the lookup is filtered by recipient even when the inbox is large.

export function extractCode(message) {
  return [message.Text, message.HTML, message.text, message.html]
    .filter(Boolean)
    .join('\n')
    .replace(/<[^>]*>/g, ' ')
    .match(/(?<!\d)\d{6}(?!\d)/)?.[0];
}

async function listByRecipient(email) {
  const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=100`);
  if (search.ok) {
    const payload = await search.json();
    return (payload.messages || []).map(message => message.ID);
  }
  // Older Mailpit builds: fall back to the list endpoint and filter locally.
  const response = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`);
  if (!response.ok) throw new Error(`Mailpit list failed: HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.messages || [])
    .filter(message => (message.To || []).some(to => to.Address?.toLowerCase() === email.toLowerCase()))
    .map(message => message.ID);
}

// The identifiers that exist before a signup: Mailpit message IDs, or the codes already in the API log.
export async function messageIds(email) {
  return CODE_SOURCE === 'api-log' ? codesFromApiLog(email) : listByRecipient(email);
}

// Waits for a code that was not already present when the signup started.
export async function waitForCode(email, previous = [], timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  if (CODE_SOURCE === 'api-log') {
    while (Date.now() < deadline) {
      const fresh = (await codesFromApiLog(email)).filter(code => !previous.includes(code));
      if (fresh.length) return fresh.at(-1);
      await sleep(1000);
    }
    throw new Error(`Timed out waiting for a verification code for ${email} in the API log`);
  }
  while (Date.now() < deadline) {
    for (const id of await messageIds(email)) {
      if (previous.includes(id)) continue;
      const response = await fetch(`${MAILPIT_URL}/api/v1/message/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`Mailpit message failed: HTTP ${response.status}`);
      const code = extractCode(await response.json());
      if (code) return code;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for a verification code for ${email}`);
}
