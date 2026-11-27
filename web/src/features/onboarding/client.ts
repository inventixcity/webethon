/** Onboarding calls through the same-origin /api/v1 proxy. Each function throws an ApiError on failure. */
import { api } from "@/lib/api/client";
import type { Profile } from "@/features/account/types";
import type { Answers } from "./answers";

export type OnboardingState = {
  answers: Answers;
  /** Set once the flow was finished or skipped. Null means the person still needs to go through it. */
  completedAt: string | null;
};

export function getOnboarding() {
  return api<OnboardingState>("/onboarding");
}

/** Replaces the saved answers. `completed` marks the flow finished, and is also set when it's skipped. */
export function saveOnboarding(answers: Answers, completed: boolean) {
  return api<OnboardingState>("/onboarding", { method: "PUT", body: { answers, completed } });
}

export function getProfile() {
  return api<Profile>("/me");
}
