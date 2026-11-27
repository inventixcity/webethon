import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decodes an RFC 4648 base32 string (the format authenticator apps use for secrets). */
export function base32Decode(text) {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error(`Invalid base32 character: ${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP: HMAC-SHA1 of the big-endian counter, dynamically truncated. */
export function hotp(secret, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The 30-second time step that `at` (milliseconds since the epoch) falls in. */
export function timeStep(at = Date.now(), period = 30) {
  return Math.floor(at / 1000 / period);
}

/** RFC 6238 TOTP for a base32 secret, at `at` milliseconds (defaults to now). */
export function totp(secretBase32, at = Date.now()) {
  return hotp(base32Decode(secretBase32), timeStep(at));
}

/**
 * Resolves once the clock has moved past `step`. Servers reject a code that was already used, so a second
 * code must come from a later step. This waits on the clock, not on a guessed delay.
 */
export async function waitForStepAfter(step, { period = 30 } = {}) {
  for (;;) {
    const now = Date.now();
    if (timeStep(now, period) > step) return timeStep(now, period);
    const nextBoundary = (step + 1) * period * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, nextBoundary - now)));
  }
}
