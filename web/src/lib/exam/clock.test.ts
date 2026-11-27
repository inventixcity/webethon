import { afterEach, expect, it, vi } from "vitest";
import { observeServerTime, serverNowMs } from "@/lib/exam/clock";
import { leaseElapsed, type JournalMeta } from "@/lib/exam/journal";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("keeps deadline time monotonic when the device wall clock jumps", () => {
  let elapsed = 100;
  vi.stubGlobal("performance", { now: () => elapsed, timeOrigin: 1 });
  observeServerTime("2026-11-27T06:00:00Z");
  const initial = serverNowMs();
  vi.spyOn(Date, "now").mockReturnValue(0);
  elapsed += 15_000;
  expect(serverNowMs()).toBe(initial + 15_000);
  vi.mocked(Date.now).mockReturnValue(9_000_000_000_000);
  elapsed += 250;
  expect(serverNowMs()).toBe(initial + 15_250);
});

it("recognizes a reload even when the new performance counter exceeds the old receipt counter", async () => {
  vi.stubGlobal("performance", { now: () => 20, timeOrigin: 2 });
  vi.spyOn(Date, "now").mockReturnValue(6000);
  const meta: JournalMeta = { genesis: null, head: null, seq: 0, clientSeq: 0, lease: { attemptId: "attempt", issuedAt: 1000, deadlineAt: 3000, mac: "test" }, leaseReceivedAt: 10, receivedAtWall: 1000, timeOrigin: 1 };
  // Preserve the elapsed expiry for the caller to reject, instead of backdating a late answer.
  expect(await leaseElapsed(meta)).toBe(5000);
});
