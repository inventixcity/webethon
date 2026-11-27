"use client";

import { SegmentError } from "@/components/errors/segment-error";

/** The admin segment boundary. Same behaviour as the root boundary. */
export default function AdminError({ error, retry }: { error: unknown; retry: () => void }) {
  return <SegmentError error={error} retry={retry} />;
}
