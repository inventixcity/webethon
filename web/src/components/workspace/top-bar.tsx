"use client";

import { ClipboardCheck, CloudOff, NotebookPen, SlidersHorizontal, Wifi } from "lucide-react";
import { forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HelpPopover } from "./help-popover";
import { SaveStatus } from "./save-status";
import { TimeRule, Timer } from "./timer";
import { pad2, type SaveState } from "./model";

type TopBarProps = {
  title: string;
  sandbox: boolean;
  remainingMs: number;
  totalMs: number;
  timerStyle: "countdown" | "hidden_until_5min";
  saveState: SaveState;
  queued: number;
  failed: number;
  answered: number;
  total: number;
  simulated: boolean;
  helpOpen: boolean;
  onHelpOpenChange: (open: boolean) => void;
  onToggleSimulation: () => void;
  onScratchpad: () => void;
  onPreferences: () => void;
  onReview: () => void;
};

/**
 * One calm bar: what the exam is, how much time is left, whether answers are safe, and four actions.
 * It sticks to the top on normal screens and scrolls away on very short ones (200% zoom on a laptop), so the
 * questions always keep most of the height.
 */
export const TopBar = forwardRef<HTMLElement, TopBarProps>(function TopBar(
  {
    title,
    sandbox,
    remainingMs,
    totalMs,
    timerStyle,
    saveState,
    queued,
    failed,
    answered,
    total,
    simulated,
    helpOpen,
    onHelpOpenChange,
    onToggleSimulation,
    onScratchpad,
    onPreferences,
    onReview,
  },
  ref,
) {
  return (
    <header ref={ref} className="ws-header z-30 border-b border-ink bg-paper">
      <div className="ws-bar flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
        <div className="min-w-0 flex-1 basis-56">
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
            Invigil{sandbox ? " · Sandbox, not recorded" : ""}
            <span className="ml-3 tabular-nums">
              {pad2(answered)} / {pad2(total)} answered
            </span>
          </p>
          <h1 className="truncate font-sans text-lg font-semibold tracking-[-0.02em]">{title}</h1>
        </div>
        <Timer remainingMs={remainingMs} style={timerStyle} className="order-first shrink-0 sm:order-none" />
      </div>

      <div className="ws-bar flex flex-wrap items-center gap-2 border-t border-(--ws-line) py-2">
        <SaveStatus state={saveState} queued={queued} failed={failed} />
        {sandbox && (
          <button
            type="button"
            onClick={onToggleSimulation}
            aria-pressed={simulated}
            title="Demo aid: Shift+Alt+O"
            className={cn(
              "flex h-8 cursor-pointer items-center gap-2 border px-2.5 font-mono text-[11px] tracking-[0.1em] uppercase transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
              simulated ? "border-ink bg-ink text-paper" : "border-dashed border-ink text-ink-soft hover:bg-paper-sunk",
            )}
          >
            {simulated ? <Wifi className="size-3.5" aria-hidden /> : <CloudOff className="size-3.5" aria-hidden />}
            {simulated ? "Demo · Reconnect" : "Demo · Go offline"}
          </button>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1 sm:gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onScratchpad} aria-label="Scratchpad" title="Scratchpad (Alt+S)">
            <NotebookPen className="size-4" aria-hidden />
            <span className="hidden md:inline">Scratchpad</span>
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onPreferences} aria-label="Preferences" title="Preferences">
            <SlidersHorizontal className="size-4" aria-hidden />
            <span className="hidden md:inline">Preferences</span>
          </Button>
          <HelpPopover open={helpOpen} onOpenChange={onHelpOpenChange} sandbox={sandbox} />
          <Button type="button" size="sm" onClick={onReview} title="Review and submit (Alt+R)">
            <ClipboardCheck className="size-4" aria-hidden />
            <span className="hidden sm:inline">Review &amp; submit</span>
            <span className="sm:hidden">Submit</span>
          </Button>
        </div>
      </div>
      <TimeRule remainingMs={remainingMs} totalMs={totalMs} />
    </header>
  );
});
