// Checks for the suite's own helpers. They need no browser and no running app.
import assert from "node:assert/strict";
import { test } from "node:test";
import { base32Decode, hotp, totp } from "../lib/totp.mjs";
import { decodePng, encodePng, visibleFraction } from "../lib/png.mjs";
import { extractCode } from "../lib/mail.mjs";

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890" for SHA-1.
const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("base32 decoding matches the RFC test secret", () => {
  assert.equal(base32Decode(RFC_SECRET_BASE32).toString("ascii"), "12345678901234567890");
});

test("HOTP matches the RFC 4226 vectors", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");
  assert.equal(hotp(secret, 0), "755224");
  assert.equal(hotp(secret, 1), "287082");
  assert.equal(hotp(secret, 2), "359152");
});

test("TOTP matches the RFC 6238 SHA-1 vectors (six-digit suffixes)", () => {
  // Times from the RFC table; expected values are the last six digits of its eight-digit codes.
  assert.equal(totp(RFC_SECRET_BASE32, 59 * 1000), "287082");
  assert.equal(totp(RFC_SECRET_BASE32, 1111111109 * 1000), "081804");
  assert.equal(totp(RFC_SECRET_BASE32, 1111111111 * 1000), "050471");
  assert.equal(totp(RFC_SECRET_BASE32, 1234567890 * 1000), "005924");
  assert.equal(totp(RFC_SECRET_BASE32, 2000000000 * 1000), "279037");
});

test("PNG encode and decode round-trip the pixels", () => {
  const png = encodePng(7, 5, (x, y) => [x * 30, y * 40, 200]);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 7);
  assert.equal(decoded.height, 5);
  assert.equal(decoded.channels, 3);
  assert.deepEqual([...decoded.pixels.subarray(0, 3)], [0, 0, 200]);
  const last = (4 * 7 + 6) * 3;
  assert.deepEqual([...decoded.pixels.subarray(last, last + 3)], [180, 160, 200]);
});

test("visibleFraction is 0 for a blank image and high for a rendered one", () => {
  const blank = decodePng(encodePng(40, 40, () => [255, 255, 255]));
  const busy = decodePng(encodePng(40, 40, (x, y) => ((x + y) % 2 ? [0, 0, 0] : [255, 0, 0])));
  assert.equal(visibleFraction(blank), 0);
  assert.ok(visibleFraction(busy) > 0.3);
});

test("extractCode reads a six-digit code from text or HTML and ignores longer numbers", () => {
  assert.equal(extractCode({ Text: "Your code: 012345\nExpires in 15 minutes." }), "012345");
  assert.equal(extractCode({ HTML: "<b>987654</b>" }), "987654");
  assert.equal(extractCode({ Text: "order 1234567 only" }), undefined);
});
