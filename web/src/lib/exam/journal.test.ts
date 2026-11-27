import { describe, expect, it } from "vitest";
import { canonicalJson, chainNext } from "@/lib/exam/journal";

describe("offline journal encoding", () => {
  it("matches the Rust fixed hash-chain vector", async () => {
    const genesis = Uint8Array.from({ length: 32 }, (_, index) => index);
    const actual = await chainNext(genesis, 1, "00000000-0000-0000-0000-000000000001", { selected: ["a"] }, 1700000000000);
    expect(actual).toBe("tgxQ9Uz3atQE2HXaLEqFzwBDMs1Y21zcWeXiHNfPb5o");
  });

  it("sorts nested object keys without changing arrays", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, c: 3 }, choices: ["b", "a"] })).toBe('{"a":{"c":3,"d":2},"choices":["b","a"],"z":1}');
  });
});
