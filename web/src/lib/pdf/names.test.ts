import { describe, expect, it } from "vitest";
import { pdfDisposition, safeSlug } from "./names";

describe("PDF export names", () => {
  it("uses bounded ASCII slugs without ids", () => {
    expect(safeSlug("COMSATS Final: Éxam / 2026")).toBe("comsats-final-exam-2026");
    expect(safeSlug("a".repeat(120))).toHaveLength(80);
    expect(safeSlug("東京")).toBe("result");
  });
  it("sends both safe ASCII and RFC 5987 filenames", () => {
    expect(pdfDisposition("a report.pdf")).toBe("attachment; filename=\"a report.pdf\"; filename*=UTF-8''a%20report.pdf");
  });
});
