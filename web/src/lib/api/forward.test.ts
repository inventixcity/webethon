import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signedVisitorHeaders, trustedVisitorIp } from "./forward";

// forward.ts imports server-only, which throws outside the React server build.
vi.mock("server-only", () => ({}));

const ENV_KEYS = ["VERCEL", "TRUSTED_IP_HEADER", "PROXY_SECRET"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("trustedVisitorIp on Vercel", () => {
  beforeEach(() => {
    process.env.VERCEL = "1";
  });

  it("reads x-vercel-forwarded-for", () => {
    expect(trustedVisitorIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("takes the first address when Vercel sends a list", () => {
    expect(trustedVisitorIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
  });

  it("ignores TRUSTED_IP_HEADER, because Vercel sets its own header", () => {
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
    expect(trustedVisitorIp(new Headers({ "cf-connecting-ip": "198.51.100.9" }))).toBeUndefined();
  });
});

describe("trustedVisitorIp when self-hosted", () => {
  it("reads the header named in TRUSTED_IP_HEADER", () => {
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
    expect(trustedVisitorIp(new Headers({ "cf-connecting-ip": "198.51.100.9" }))).toBe("198.51.100.9");
  });

  it("matches the header name regardless of case", () => {
    process.env.TRUSTED_IP_HEADER = "CF-Connecting-IP";
    expect(trustedVisitorIp(new Headers({ "cf-connecting-ip": "198.51.100.9" }))).toBe("198.51.100.9");
  });

  it("accepts an IPv6 address", () => {
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    expect(trustedVisitorIp(new Headers({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("returns undefined when TRUSTED_IP_HEADER is unset", () => {
    expect(trustedVisitorIp(new Headers({ "x-real-ip": "198.51.100.9", "cf-connecting-ip": "198.51.100.9" }))).toBeUndefined();
  });

  it("returns undefined when TRUSTED_IP_HEADER is set but the header is missing", () => {
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
    expect(trustedVisitorIp(new Headers({}))).toBeUndefined();
  });

  it.each([
    ["too many octets", "1.2.3.4.5"],
    ["octet out of range", "999.1.1.1"],
    ["markup", "<script>1.2.3.4</script>"],
    ["not an address", "not-an-ip"],
    ["separators only", ":::"],
    ["empty", ""],
  ])("rejects a malformed address (%s)", (_label, value) => {
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
    expect(trustedVisitorIp(new Headers({ "cf-connecting-ip": value }))).toBeUndefined();
  });

  it("ignores a forged x-forwarded-for when TRUSTED_IP_HEADER is unset", () => {
    expect(trustedVisitorIp(new Headers({ "x-forwarded-for": "10.0.0.1" }))).toBeUndefined();
  });

  it("ignores a forged x-forwarded-for when TRUSTED_IP_HEADER names another header", () => {
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    expect(trustedVisitorIp(new Headers({ "x-forwarded-for": "10.0.0.1" }))).toBeUndefined();
  });
});

describe("signedVisitorHeaders", () => {
  it("signs the trusted IP when PROXY_SECRET is set", () => {
    process.env.PROXY_SECRET = "a".repeat(32);
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";

    const headers = signedVisitorHeaders(new Headers({ "cf-connecting-ip": "198.51.100.9" }));

    expect(headers["x-client-ip"]).toBe("198.51.100.9");
    expect(headers["x-client-ip-signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns nothing without PROXY_SECRET", () => {
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
    expect(signedVisitorHeaders(new Headers({ "cf-connecting-ip": "198.51.100.9" }))).toEqual({});
  });

  it("returns nothing when there is no trustworthy IP", () => {
    process.env.PROXY_SECRET = "a".repeat(32);
    expect(signedVisitorHeaders(new Headers({ "x-forwarded-for": "10.0.0.1" }))).toEqual({});
  });
});
