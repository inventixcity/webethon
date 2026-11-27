import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

type HeaderSource = Pick<Headers, "get">;

/**
 * The visitor's IP, taken only from a header the hosting platform sets itself and the visitor cannot forge:
 * - on Vercel, `x-vercel-forwarded-for` (Vercel overwrites it on every request);
 * - when self-hosted, only the header named in TRUSTED_IP_HEADER, and only if the ingress in front of this
 *   server strips and rewrites it (e.g. nginx `proxy_set_header X-Real-IP $remote_addr`).
 * Anything else returns undefined, and the API falls back to its own view of the caller.
 */
export function trustedVisitorIp(headers: HeaderSource): string | undefined {
  const name = process.env.VERCEL === "1" ? "x-vercel-forwarded-for" : process.env.TRUSTED_IP_HEADER?.toLowerCase();
  if (!name) return undefined;
  const value = headers.get(name)?.split(",")[0]?.trim();
  // isIP rejects shapes the old character-class check let through, such as "1.2.3.4.5" or ":::".
  return value && isIP(value) !== 0 ? value : undefined;
}

/** Same construction as kernel::crypto::hmac_sha256: each part is prefixed with its length (u64, big endian). */
function sign(secret: string, parts: string[]) {
  const mac = createHmac("sha256", secret);
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    mac.update(length);
    mac.update(bytes);
  }
  return mac.digest("hex");
}

/**
 * Headers that tell the API who the visitor is, signed with PROXY_SECRET so the API can rate limit per
 * person. Empty when there is no secret or no trustworthy IP.
 */
export function signedVisitorHeaders(headers: HeaderSource): Record<string, string> {
  const secret = process.env.PROXY_SECRET;
  const ip = trustedVisitorIp(headers);
  if (!secret || !ip) return {};
  return { "x-client-ip": ip, "x-client-ip-signature": sign(secret, ["client-ip", ip]) };
}
