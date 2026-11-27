"use client";

import { Keyboard, X } from "lucide-react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { useWorkspaceRoot } from "./drawer";

export type Shortcut = { keys: string[]; action: string };

/** The workspace shortcuts. Letters are matched by physical key (event.code), so they hold on any layout. */
export function shortcutList(sandbox: boolean): Shortcut[] {
  const list: Shortcut[] = [
    { keys: ["Alt", "N"], action: "Next question" },
    { keys: ["Alt", "P"], action: "Previous question" },
    { keys: ["Alt", "F"], action: "Flag or unflag this question" },
    { keys: ["Alt", "J"], action: "Jump to the question palette" },
    { keys: ["Alt", "S"], action: "Open the scratchpad" },
    { keys: ["Alt", "R"], action: "Review and submit" },
    { keys: ["Alt", "K"], action: "Show these shortcuts" },
    { keys: ["Esc"], action: "Close a panel or dialog" },
  ];
  if (sandbox) list.push({ keys: ["Shift", "Alt", "O"], action: "Demo: simulate going offline, or reconnect" });
  return list;
}

export function ShortcutTable({ sandbox }: { sandbox: boolean }) {
  return (
    <dl className="grid gap-2.5">
      {shortcutList(sandbox).map((shortcut) => (
        <div key={shortcut.action} className="flex items-baseline justify-between gap-4">
          <dt className="font-sans text-sm text-ink-soft">{shortcut.action}</dt>
          <dd className="flex shrink-0 gap-1">
            {shortcut.keys.map((key) => (
              <kbd
                key={key}
                className="border border-(--ws-line) bg-paper px-1.5 py-0.5 font-mono text-[11px] tracking-[0.06em] text-ink"
              >
                {key}
              </kbd>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The shortcuts popover in the top bar. Controlled, so Alt+K can open it too. */
export function HelpPopover({
  open,
  onOpenChange,
  sandbox,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandbox: boolean;
}) {
  const root = useWorkspaceRoot();
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (Alt+K)">
          <Keyboard className="size-4" aria-hidden />
          <span className="hidden xl:inline">Keys</span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal container={root ?? undefined}>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={16}
          aria-label="Keyboard shortcuts"
          className="ws-modal z-50 w-[min(24rem,calc(100vw-2rem))] border border-ink bg-paper-raised p-5 text-ink focus:outline-none"
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <p className="font-mono text-[11px] tracking-[0.14em] uppercase">Keyboard shortcuts</p>
            <Popover.Close
              aria-label="Close shortcuts"
              className="-mt-2 -mr-2 grid size-10 cursor-pointer place-items-center text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <X className="size-4" aria-hidden />
            </Popover.Close>
          </div>
          <ShortcutTable sandbox={sandbox} />
          <p className="mt-4 border-t border-(--ws-line) pt-3 font-sans text-sm text-ink-soft">
            Everything also works with Tab, Space and Enter. Arrow keys move between options in a question.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
