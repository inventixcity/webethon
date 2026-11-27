import { describe, expect, it } from "vitest";
import { answeredCount, checkProfile, progressFor, sanitizeAnswers, toggleInterest } from "./answers";
import { onboardingSteps } from "./config";

describe("sanitizeAnswers", () => {
  it("keeps only the accepted keys and shapes", () => {
    expect(
      sanitizeAnswers({
        interests: ["music", "Music", "food", "food", "x y", 3, "tech"],
        notifications: "important",
        role: "admin",
      }),
    ).toEqual({ interests: ["music", "food", "tech"], notifications: "important" });
  });

  it("drops a notification choice that isn't on the list, and any non-object", () => {
    expect(sanitizeAnswers({ notifications: "always" })).toEqual({ interests: undefined, notifications: undefined });
    expect(sanitizeAnswers(null)).toEqual({});
    expect(sanitizeAnswers(["music"])).toEqual({});
  });

  it("caps interests at twelve", () => {
    const many = Array.from({ length: 20 }, (_, index) => `topic-${index}`);
    expect(sanitizeAnswers({ interests: many }).interests).toHaveLength(12);
  });
});

describe("toggleInterest", () => {
  it("adds, removes and refuses past the limit", () => {
    expect(toggleInterest(undefined, "art")).toEqual(["art"]);
    expect(toggleInterest(["art"], "art")).toEqual([]);
    expect(toggleInterest(["a", "b"], "c", 2)).toEqual(["a", "b"]);
  });
});

describe("progressFor and answeredCount", () => {
  it("runs from 0 to 1 and clamps", () => {
    expect(progressFor(0, 5)).toBe(0);
    expect(progressFor(4, 5)).toBe(1);
    expect(progressFor(9, 5)).toBe(1);
    expect(progressFor(0, 1)).toBe(1);
  });

  it("counts the answers given", () => {
    expect(answeredCount({})).toBe(0);
    expect(answeredCount({ interests: ["art"], notifications: "all" })).toBe(2);
  });
});

describe("checkProfile", () => {
  it("requires a name and an https avatar when one is given", () => {
    expect(checkProfile({ displayName: "  ", avatarUrl: "" })).toHaveProperty("displayName");
    expect(checkProfile({ displayName: "Ada", avatarUrl: "" })).toEqual({});
    expect(checkProfile({ displayName: "Ada", avatarUrl: "http://example.com/a.png" })).toHaveProperty("avatarUrl");
    expect(checkProfile({ displayName: "Ada", avatarUrl: "javascript:alert(1)" })).toHaveProperty("avatarUrl");
    expect(checkProfile({ displayName: "Ada", avatarUrl: "https://example.com/a.png" })).toEqual({});
  });
});

describe("the step config", () => {
  it("ends with a done step and has unique ids", () => {
    expect(onboardingSteps.at(-1)?.kind).toBe("done");
    expect(new Set(onboardingSteps.map((step) => step.id)).size).toBe(onboardingSteps.length);
  });
});
