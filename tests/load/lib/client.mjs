import { createHmac, randomInt } from 'node:crypto';
import { API_URL, PROXY_SECRET } from './config.mjs';

// Same signing as tests/e2e/lib/http.mjs and the Next.js proxy: HMAC-SHA256 over length-prefixed parts.
function sign(secret, parts) {
  const mac = createHmac('sha256', secret);
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    mac.update(length);
    mac.update(bytes);
  }
  return mac.digest('hex');
}

// Every simulated user gets a distinct IP in this process, because the API's read, write and sign-in budgets
// are keyed by client IP. Reusing one IP would make the test measure its own shared budget.
const issued = new Set();
export function nextIp() {
  for (;;) {
    const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
    if (!issued.has(ip)) {
      issued.add(ip);
      return ip;
    }
  }
}

export class Visitor {
  constructor(ip = nextIp()) {
    this.ip = ip;
  }

  signedHeaders(headers) {
    if (PROXY_SECRET) {
      headers.set('x-client-ip', this.ip);
      headers.set('x-client-ip-signature', sign(PROXY_SECRET, ['client-ip', this.ip]));
    }
    return headers;
  }

  // One JSON request. Never throws: network errors come back as status 0 with code NETWORK or TIMEOUT.
  // Latency is measured until the body is fully read, which is what a user would wait for.
  async send(method, path, { token, body, headers = {}, timeoutMs = 30_000 } = {}) {
    const requestHeaders = this.signedHeaders(new Headers(headers));
    if (token) requestHeaders.set('authorization', `Bearer ${token}`);
    let payload;
    if (body !== undefined) {
      requestHeaders.set('content-type', 'application/json');
      payload = JSON.stringify(body);
    }
    const started = performance.now();
    try {
      const response = await fetch(`${API_URL}${path}`, {
        method,
        headers: requestHeaders,
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const ms = performance.now() - started;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return {
        status: response.status,
        ms,
        text,
        json,
        code: json?.error?.code ?? null,
        retryAfter: Number(response.headers.get('retry-after')) || null,
        requestId: response.headers.get('x-request-id'),
      };
    } catch (error) {
      const ms = performance.now() - started;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return {
        status: 0,
        ms,
        text: '',
        json: undefined,
        code: timedOut ? 'TIMEOUT' : 'NETWORK',
        retryAfter: null,
        requestId: null,
        error: String(error?.cause?.code ?? error?.message ?? error),
      };
    }
  }

  // Opens a streaming GET (Server-Sent Events). Returns the fetch Response; the caller reads its body.
  async open(path, { token, signal }) {
    const requestHeaders = this.signedHeaders(new Headers({ accept: 'text/event-stream' }));
    if (token) requestHeaders.set('authorization', `Bearer ${token}`);
    return fetch(`${API_URL}${path}`, { method: 'GET', headers: requestHeaders, redirect: 'manual', signal });
  }
}
