import { createHmac, randomInt } from 'node:crypto';

// With PROXY_SECRET set (the same value the API uses), each Browser presents its own client IP, signed the
// way the Next.js proxy signs it. Per-IP rate limits then apply per simulated visitor, as in production,
// instead of every test sharing one budget. Without it, all requests share this machine's IP.
const PROXY_SECRET = process.env.PROXY_SECRET;
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
const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

export const API_URL = (process.env.API_URL || 'http://localhost:8080').replace(/\/$/, '');
export class CookieJar {
  constructor() { this.cookies = new Map(); }
  store(headers) {
    for (const cookie of headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';');
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
      if (!value || attributes.some(item => /^\s*max-age\s*=\s*0\s*$/i.test(item))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
}
export class Browser {
  constructor({ ip = randomIp() } = {}) { this.jar = new CookieJar(); this.ip = ip; }
  async request(path, { method = 'GET', body, headers = {}, raw, cookies = true } = {}) {
    const requestHeaders = new Headers(headers);
    if (cookies && this.jar.header() && !requestHeaders.has('cookie')) requestHeaders.set('cookie', this.jar.header());
    if (PROXY_SECRET && !requestHeaders.has('x-client-ip')) {
      requestHeaders.set('x-client-ip', this.ip);
      requestHeaders.set('x-client-ip-signature', sign(PROXY_SECRET, ['client-ip', this.ip]));
    }
    if (body !== undefined && !requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
    const response = await fetch(`${API_URL}${path}`, { method, headers: requestHeaders, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
    this.jar.store(response.headers);
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, headers: response.headers, text, json };
  }
  get(path, options) { return this.request(path, options); }
  post(path, body, options = {}) { return this.request(path, { ...options, method: 'POST', body }); }
  patch(path, body, options = {}) { return this.request(path, { ...options, method: 'PATCH', body }); }
  delete(path, options = {}) { return this.request(path, { ...options, method: 'DELETE' }); }
}
