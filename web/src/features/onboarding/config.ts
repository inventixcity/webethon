/**
 * The onboarding steps. Edit this file on the day to change the questions.
 *
 * The API only stores the answer keys it knows (`interests`, `notifications`; see
 * backend/crates/places/src/onboarding.rs). To ask something new, add its key there as well as a step
 * here. Interest values must be lowercase words with hyphens, at most 12 of them.
 */

export type Choice = { value: string; label: string; hint?: string };

type StepBase = { id: string; eyebrow: string; title: string; body: string };

export type OnboardingStep =
  | (StepBase & { kind: "intro" })
  | (StepBase & { kind: "profile" })
  | (StepBase & { kind: "multi"; key: "interests"; max: number; options: Choice[] })
  | (StepBase & { kind: "single"; key: "notifications"; options: Choice[] })
  | (StepBase & { kind: "done" });

export const onboardingSteps: OnboardingStep[] = [
  {
    id: "welcome",
    kind: "intro",
    eyebrow: "01 / WELCOME",
    title: "Let's set up your account",
    body: "Three quick questions, about a minute. You can change everything later in Settings.",
  },
  {
    id: "profile",
    kind: "profile",
    eyebrow: "02 / PROFILE",
    title: "What should we call you?",
    body: "Your name appears next to your activity. The picture is optional, and it must be a link that starts with https://.",
  },
  {
    id: "interests",
    kind: "multi",
    key: "interests",
    eyebrow: "03 / INTERESTS",
    title: "What are you into?",
    body: "Pick up to 12. This only tunes what we show you first.",
    max: 12,
    options: [
      { value: "music", label: "Music" },
      { value: "food", label: "Food" },
      { value: "travel", label: "Travel" },
      { value: "art", label: "Art" },
      { value: "tech", label: "Tech" },
      { value: "books", label: "Books" },
      { value: "games", label: "Games" },
      { value: "sport", label: "Sport" },
      { value: "outdoors", label: "Outdoors" },
      { value: "film", label: "Film" },
    ],
  },
  {
    id: "notifications",
    kind: "single",
    key: "notifications",
    eyebrow: "04 / NOTIFICATIONS",
    title: "How often should we nudge you?",
    body: "You can still open the app whenever you like.",
    options: [
      { value: "all", label: "Everything", hint: "Every update, as it happens" },
      { value: "important", label: "Important only", hint: "Replies and changes to your things" },
      { value: "none", label: "Nothing for now", hint: "I'll check in myself" },
    ],
  },
  {
    id: "done",
    kind: "done",
    eyebrow: "05 / READY",
    title: "You're all set",
    body: "Check the summary, then finish. Your answers are saved as you go.",
  },
];
