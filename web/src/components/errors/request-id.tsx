"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Copies the id to the clipboard. `copied` is true for two seconds afterwards. */
function useCopyRequestId(id: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The clipboard can be blocked. The id is on screen, so it can still be selected by hand.
    }
  }

  return { copied, copy };
}

/** The id to quote to support, with a copy button that shows "Copied" for a moment. */
export function RequestId({ id }: { id: string }) {
  const { copied, copy } = useCopyRequestId(id);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-rule pt-5">
      <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Request id</span>
      <code className="font-mono text-sm break-all text-ink-soft select-all">{id}</code>
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </Button>
      <span role="status" className="sr-only">
        {copied ? "Request id copied to the clipboard" : ""}
      </span>
    </div>
  );
}

/**
 * The same request id, drawn as the Shark404 details strip. Its row and border come from the `details`
 * slot, so this renders only the pieces inside it.
 */
export function SharkRequestId({ id }: { id: string }) {
  const { copied, copy } = useCopyRequestId(id);

  return (
    <>
      <span className="shark-404-details-label">Request id</span>
      <code className="shark-404-details-id">{id}</code>
      <Button type="button" variant="secondary" size="sm" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </Button>
      <span role="status" className="sr-only">
        {copied ? "Request id copied to the clipboard" : ""}
      </span>
    </>
  );
}
