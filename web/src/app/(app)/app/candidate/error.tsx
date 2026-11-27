"use client";

import { SegmentError } from "@/components/errors/segment-error";

/** Covers every candidate route. Client-side API failures are shown inline by each panel instead. */
export default function CandidateError({ error, reset }: { error: unknown; reset: () => void }) {
  return <SegmentError error={error} retry={reset} />;
}
