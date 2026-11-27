"use client";

import { AlertTriangle, Check, CloudOff, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { SaveState } from "./model";

function label(state: SaveState, queued: number, failed: number): string {
  switch (state) {
    case "saved":
      return "Saved";
    case "saving":
      return "Saving…";
    case "offline":
      return queued > 0 ? `Offline · ${queued} stored on device` : "Offline · stored on device";
    case "syncing":
      return queued > 0 ? `Syncing ${queued}` : "Syncing…";
    case "error":
      return failed === 1 ? "Error · 1 answer not saved" : `Error · ${failed} answers not saved`;
  }
}

/**
 * The save-status pill. It is deliberately NOT a live region: it changes on every keystroke. The announcer below
 * speaks only the transitions that matter (going offline, a failure, everything synced).
 */
export function SaveStatus({ state, queued, failed }: { state: SaveState; queued: number; failed: number }) {
  const Icon = state === "error" ? AlertTriangle : state === "offline" ? CloudOff : state === "saved" ? Check : RefreshCw;
  return (
    <p
      data-state={state}
      className={cn(
        "flex h-8 min-w-0 items-center gap-2 border px-2.5 font-mono text-[11px] tracking-[0.1em] uppercase",
        state === "error" && "border-ink bg-ink text-paper",
        state === "offline" && "border-ink text-ink",
        (state === "saved" || state === "saving" || state === "syncing") && "border-(--ws-line) text-ink-soft",
      )}
    >
      <Icon
        aria-hidden
        className={cn("size-3.5 shrink-0", (state === "saving" || state === "syncing") && "ws-spin")}
      />
      <span className="truncate">{label(state, queued, failed)}</span>
    </p>
  );
}

/** Speaks save-state transitions once each: polite for offline and recovery, assertive for failures. */
export function SaveAnnouncer({ state, failed }: { state: SaveState; failed: number }) {
  const [polite, setPolite] = useState("");
  const [urgent, setUrgent] = useState("");
  const previous = useRef<SaveState>(state);

  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (before === state) return;
    if (state === "error") {
      setUrgent(
        failed === 1
          ? "One answer could not be saved. It is marked Not saved on the question. Use Retry there."
          : `${failed} answers could not be saved. They are marked Not saved. Use Retry on each question.`,
      );
    } else if (state === "offline") {
      setPolite("You are offline. Answers are stored on this device. Your time is not paused.");
    } else if (state === "saved" && (before === "error" || before === "offline" || before === "syncing")) {
      setPolite("All answers saved.");
    }
  }, [state, failed]);

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {polite}
      </span>
      <span role="alert" aria-live="assertive" className="sr-only">
        {urgent}
      </span>
    </>
  );
}
