const base = (process.env.MAILPIT_URL || 'http://localhost:8025').replace(/\/$/, '');
export function extractCode(message) {
  return [message.Text, message.HTML, message.text, message.html].filter(Boolean).join('\n').replace(/<[^>]*>/g, ' ').match(/(?<!\d)\d{6}(?!\d)/)?.[0];
}
export async function messageIds(email) {
  const response = await fetch(`${base}/api/v1/messages`);
  if (!response.ok) throw new Error(`Mailpit list: ${response.status}`);
  const payload = await response.json();
  return (payload.messages || []).filter(message => (message.To || []).some(to => to.Address?.toLowerCase() === email.toLowerCase())).map(message => message.ID);
}
export async function waitForCode(email, previous = [], timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const id of await messageIds(email)) {
      if (previous.includes(id)) continue;
      const response = await fetch(`${base}/api/v1/message/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`Mailpit message: ${response.status}`);
      const code = extractCode(await response.json());
      if (code) return code;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for a new code for ${email}`);
}
export async function clearMail() {
  const response = await fetch(`${base}/api/v1/messages`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Mailpit delete: ${response.status}`);
}
