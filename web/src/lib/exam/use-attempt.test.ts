import { expect, it } from "vitest";
import { restoreAnswers } from "@/lib/exam/use-attempt";
import type { AttemptPayload, JournalEntry } from "@/lib/exam/types";

it("restores unsynced journal entries over server answers and retains the newest local edit", () => {
  const payload = { journal: { seq: 3 }, answers: [
    { itemId: "a", response: { text: "Server version" }, flagged: false },
    { itemId: "b", response: { selected: ["b"] }, flagged: true },
  ] } as AttemptPayload;
  const entries = [
    { seq: 2, itemId: "b", response: { selected: ["a"] }, flagged: false },
    { seq: 4, itemId: "a", response: { text: "Local version" }, flagged: false },
    { seq: 5, itemId: "a", response: { text: "Latest version" }, flagged: true },
  ] as JournalEntry[];
  expect(restoreAnswers(payload, entries)).toEqual({
    a: { response: { text: "Latest version" }, flagged: true, state: "queued" },
    b: { response: { selected: ["b"] }, flagged: true, state: "saved" },
  });
});
