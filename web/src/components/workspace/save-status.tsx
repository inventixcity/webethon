"use client";

import { cn } from "@/lib/utils";
import type { SaveState } from "./model";

const LABEL: Record<SaveState, (pending: number) => string> = {
  saved: () => "Saved",
  saving: () => "Saving…",
  offline: () => "Offline — answers stored on this device",
  syncing: (pending) => `Syncing ${pending}`,
  error: () => "Error",
};

/** Whether answers are safe. Announced politely, so a change is heard without interrupting the candidate. */
export function SaveStatus({ state, pendingCount }: { state: SaveState; pendingCount: number }) {
  const tone = state === "error" ? "error" : state === "offline" ? "offline" : "normal";
  return (
    <p
      role="status"
      aria-live="polite"
      data-state={state}
      className={cn(
        "flex min-w-0 items-center gap-2 border px-2.5 py-1.5 font-mono text-[11px] tracking-[0.1em] uppercase",
        tone === "error" ? "border-vermilion-deep text-vermilion-deep" : "border-(--ws-line) text-ink-soft",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0",
          state === "saved" && "bg-ink",
          state === "saving" && "animate-pulse bg-ink motion-reduce:animate-none",
          state === "syncing" && "border border-ink",
          state === "offline" && "border border-ink-muted",
          state === "error" && "bg-vermilion-deep",
        )}
      />
      <span className="truncate">{LABEL[state](pendingCount)}</span>
    </p>
  );
}
