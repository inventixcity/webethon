"use client";

import { ListChecks } from "lucide-react";
import { forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Drawer } from "./drawer";
import { pad2 } from "./model";

export type PaletteItem = {
  id: string;
  index: number;
  answered: boolean;
  flagged: boolean;
  /** The last save of this answer failed. */
  failed: boolean;
  /** Stored on this device, not yet on the server. */
  queued: boolean;
};

type PaletteProps = {
  items: PaletteItem[];
  currentIndex: number;
  side: "left" | "right";
  onSelect: (index: number) => void;
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
};

export function paletteLabel(item: PaletteItem, current: boolean): string {
  return [
    `Question ${item.index + 1}`,
    item.answered ? "answered" : "unanswered",
    item.flagged ? "flagged" : null,
    item.failed ? "not saved" : item.queued ? "stored on this device" : null,
    current ? "current" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Question palette: a sticky side column on large screens, a bottom sheet below them (including 360 px and
 * 200% zoom). States are carried by fill, outline weight, a corner mark and the accessible name, never by colour
 * alone. Vermilion marks flags only.
 */
export const Palette = forwardRef<HTMLElement, PaletteProps>(function Palette(
  { items, currentIndex, side, onSelect, sheetOpen, onSheetOpenChange },
  ref,
) {
  const counts = {
    answered: items.filter((item) => item.answered).length,
    flagged: items.filter((item) => item.flagged).length,
  };
  const unanswered = items.length - counts.answered;

  return (
    <>
      <aside
        ref={ref}
        aria-label="Question palette"
        className={cn(
          "ws-palette hidden w-60 shrink-0 flex-col gap-6 self-start overflow-y-auto px-5 py-8 lg:flex",
          side === "left" ? "order-first border-r border-(--ws-line)" : "order-last border-l border-(--ws-line)",
        )}
      >
        <PaletteBody
          items={items}
          currentIndex={currentIndex}
          onSelect={onSelect}
          answered={counts.answered}
          unanswered={unanswered}
          flagged={counts.flagged}
        />
      </aside>
      <Drawer
        open={sheetOpen}
        onOpenChange={onSheetOpenChange}
        side="bottom"
        title="Questions"
        description={`${counts.answered} answered, ${unanswered} unanswered, ${counts.flagged} flagged`}
      >
        <div className="grid gap-5 p-5">
          <PaletteBody
            items={items}
            currentIndex={currentIndex}
            onSelect={(index) => {
              onSheetOpenChange(false);
              onSelect(index);
            }}
            answered={counts.answered}
            unanswered={unanswered}
            flagged={counts.flagged}
          />
        </div>
      </Drawer>
    </>
  );
});

/** Opens the bottom sheet on small screens. */
export function PaletteTrigger({
  currentIndex,
  total,
  answered,
  onOpen,
}: {
  currentIndex: number;
  total: number;
  answered: number;
  onOpen: () => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="lg:hidden"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Questions: on ${currentIndex + 1} of ${total}, ${answered} answered. Open the question palette.`}
    >
      <ListChecks className="size-4" aria-hidden />
      {pad2(currentIndex + 1)} / {pad2(total)}
      <span className="text-ink-muted">· {answered} answered</span>
    </Button>
  );
}

function PaletteBody({
  items,
  currentIndex,
  onSelect,
  answered,
  unanswered,
  flagged,
}: {
  items: PaletteItem[];
  currentIndex: number;
  onSelect: (index: number) => void;
  answered: number;
  unanswered: number;
  flagged: number;
}) {
  return (
    <>
      <p className="font-mono text-[11px] tracking-[0.14em] uppercase">Questions</p>
      <ol className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-2" aria-label="Questions">
        {items.map((item, index) => {
          const current = index === currentIndex;
          return (
            <li key={item.id}>
              <button
                type="button"
                data-palette-index={index}
                data-answered={item.answered}
                data-current={current}
                onClick={() => onSelect(index)}
                aria-label={paletteLabel(item, current)}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "ws-cell relative grid aspect-square w-full min-w-11 cursor-pointer place-items-center font-mono text-xs tabular-nums transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                  item.answered ? "bg-ink text-paper" : "border border-ink text-ink hover:bg-paper-sunk",
                  item.failed && "border-2 border-dashed border-ink bg-paper text-ink",
                  current && "ring-2 ring-ink ring-offset-2 ring-offset-paper",
                )}
              >
                {pad2(index + 1)}
                {item.flagged && (
                  <span
                    aria-hidden="true"
                    className="ws-flag-mark absolute top-0 right-0 size-3 bg-vermilion [clip-path:polygon(100%_0,0_0,100%_100%)]"
                  />
                )}
                {item.queued && !item.failed && (
                  <span aria-hidden="true" className="absolute bottom-1 left-1/2 h-px w-3 -translate-x-1/2 bg-current" />
                )}
              </button>
            </li>
          );
        })}
      </ol>
      <dl className="grid gap-2 border-t border-(--ws-line) pt-4 font-mono text-[11px] tracking-[0.08em] uppercase">
        <Legend swatch="filled" label="Answered" count={answered} />
        <Legend swatch="outline" label="Unanswered" count={unanswered} />
        <Legend swatch="flag" label="Flagged" count={flagged} />
      </dl>
      <p className="font-sans text-xs text-ink-muted">
        A short underline means stored on this device and waiting to sync. A dashed box means the last save failed.
      </p>
    </>
  );
}

function Legend({ swatch, label, count }: { swatch: "filled" | "outline" | "flag"; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="flex items-center gap-2 text-ink-soft">
        <span aria-hidden="true" className="relative inline-block size-3.5">
          <span className={cn("absolute inset-0", swatch === "filled" ? "bg-ink" : "border border-ink")} />
          {swatch === "flag" && (
            <span className="ws-flag-mark absolute top-0 right-0 size-2 bg-vermilion [clip-path:polygon(100%_0,0_0,100%_100%)]" />
          )}
        </span>
        {label}
      </dt>
      <dd className="ml-auto tabular-nums">{count}</dd>
    </div>
  );
}
