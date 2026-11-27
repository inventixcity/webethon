"use client";

import { SegmentError } from "@/components/errors/segment-error";

/** Route error boundary for the question bank, editor and import screens. */
export default function QuestionsError({ error, reset }: { error: unknown; reset: () => void }) {
  return <SegmentError error={error} retry={reset} />;
}
