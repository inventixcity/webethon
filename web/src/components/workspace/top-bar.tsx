"use client";

import { ClipboardCheck, NotebookPen, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NetworkIndicator } from "./network-banner";
import { SaveStatus } from "./save-status";
import { Timer } from "./timer";
import type { NetworkQuality, SaveState } from "./model";

type TopBarProps = {
  title: string;
  sandbox: boolean;
  remainingMs: number;
  timerStyle: "countdown" | "hidden_until_5min";
  saveState: SaveState;
  pendingCount: number;
  quality: NetworkQuality;
  onScratchpad: () => void;
  onPreferences: () => void;
  onReview: () => void;
};

export function TopBar({
  title,
  sandbox,
  remainingMs,
  timerStyle,
  saveState,
  pendingCount,
  quality,
  onScratchpad,
  onPreferences,
  onReview,
}: TopBarProps) {
  return (
    <header className="border-b border-ink bg-paper">
      <div className="flex items-center gap-4 px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
            Invigil{sandbox ? " · Sandbox" : ""}
          </p>
          <h1 className="truncate font-sans text-lg font-semibold tracking-[-0.02em] sm:text-xl">{title}</h1>
        </div>
        {sandbox && (
          <p className="hidden shrink-0 border border-ink px-2.5 py-1.5 font-mono text-[11px] tracking-[0.1em] uppercase sm:block">
            Sandbox — not recorded
          </p>
        )}
        <Timer remainingMs={remainingMs} style={timerStyle} className="shrink-0" />
      </div>

      {sandbox && (
        <p className="border-t border-(--ws-line) px-4 py-1.5 font-mono text-[11px] tracking-[0.1em] uppercase sm:hidden">
          Sandbox — not recorded
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-(--ws-line) px-4 py-2.5 sm:px-6">
        <SaveStatus state={saveState} pendingCount={pendingCount} />
        <NetworkIndicator quality={quality} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onScratchpad} aria-label="Open scratchpad">
            <NotebookPen className="size-4" aria-hidden />
            <span className="hidden sm:inline">Scratchpad</span>
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onPreferences} aria-label="Open preferences">
            <SlidersHorizontal className="size-4" aria-hidden />
            <span className="hidden sm:inline">Preferences</span>
          </Button>
          <Button type="button" size="sm" onClick={onReview}>
            <ClipboardCheck className="size-4" aria-hidden />
            Review &amp; submit
          </Button>
        </div>
      </div>
    </header>
  );
}
