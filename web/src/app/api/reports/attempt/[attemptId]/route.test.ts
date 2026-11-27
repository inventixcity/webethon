import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=test" }) }));
vi.mock("@/lib/api/forward", () => ({ signedVisitorHeaders: () => ({}) }));
vi.mock("@react-pdf/renderer", () => ({
  Document: "pdf-document",
  Page: "pdf-page",
  Image: "pdf-image",
  Text: "pdf-text",
  View: "pdf-view",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: async () => Buffer.from("%PDF-1.4 test"),
}));

import { GET } from "./route";

describe("attempt PDF report route", () => {
  const originalOrigin = process.env.API_ORIGIN;

  beforeEach(() => {
    process.env.API_ORIGIN = "http://api.test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.API_ORIGIN = originalOrigin;
  });

  it("renders a non-cached PDF with a verification QR code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {
      candidate: "A. K****n",
      examTitle: "Final assessment",
      date: "2026-11-27T10:00:00Z",
      score: 8,
      totalMarks: 10,
      percent: 80,
      passed: true,
      items: [{ position: 1, stem: "Question one", marks: 10, awarded: 8, feedback: "" }],
      verifyCode: "ABCD-EFGH-JKMP",
      verifyUrl: "https://invigil.test/verify/ABCD-EFGH-JKMP",
    } }), { status: 200, headers: { "content-type": "application/json" } })));

    const response = await GET(new Request("http://web.test/api/reports/attempt/id"), {
      params: Promise.resolve({ attemptId: "00000000-0000-4000-8000-000000000001" }),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toContain("%PDF");
  });

  it("preserves an upstream authorization denial as JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })));
    const response = await GET(new Request("http://web.test/api/reports/attempt/id"), {
      params: Promise.resolve({ attemptId: "00000000-0000-4000-8000-000000000001" }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
