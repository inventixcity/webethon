import { describe, expect, it } from "vitest";
import { boundedRows } from "../../bounds";

describe("exam PDF row bounds", () => {
  it("caps rendered candidates and marks the report truncated", () => {
    const result = boundedRows(Array.from({ length: 2001 }, (_, index) => index));
    expect(result.rows).toHaveLength(2000);
    expect(result.truncated).toBe(true);
  });

  it("keeps complete cohorts at or below the cap", () => {
    const result = boundedRows(["one", "two"]);
    expect(result.rows).toEqual(["one", "two"]);
    expect(result.truncated).toBe(false);
  });
});
