"use client";

import { SegmentError } from "@/components/errors/segment-error";

/** The root error boundary. Every route without a closer boundary lands here. */
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return <SegmentError error={error} retry={retry} />;
}
