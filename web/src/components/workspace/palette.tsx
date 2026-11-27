"use client";

import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Drawer } from "./drawer";
import { pad2 } from "./model";

export type PaletteItem = { id: string; index: number; answered: boolean; flagged: boolean };

type PaletteProps = {
  items: PaletteItem[];
  currentIndex: number;
  side: "left" | "right";
  onSelect: (index: number) => void;
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
};

/** Question palette: a side column on large screens, a bottom sheet below them. */
export function Palette({ items, currentIndex, side, onSelect, sheetOpen, onSheetOpenChange }: PaletteProps) {
  const answered = items.filter((item) => item.answered).length;
  const flagged = items.filter((item) => item.flagged).length;
  const unanswered = items.length - answered;
  const body = (
    <PaletteBody
      items={items}
      currentIndex={currentIndex}
      onSelect={(index) => {
        onSelect(index);
        onSheetOpenChange(false);
      }}
      answered={answered}
      unanswered={unanswered}
      flagged={flagged}
    />
  );

  return (
    <>
      <aside
        aria-label="Question palette"
        className={cn(
          "hidden w-56 shrink-0 flex-col gap-5 overflow-y-auto p-5 lg:flex",
          side === "left" ? "border-r border-(--ws-line)" : "border-l border-(--ws-line)",
        )}
      >
        {body}
      </aside>
      <Drawer
        open={sheetOpen}
        onOpenChange={onSheetOpenChange}
        side="bottom"
        title="Questions"
        description={`${answered} answered, ${unanswered} unanswered, ${flagged} flagged`}
      >
        <div className="p-5">{body}</div>
      </Drawer>
    </>
  );
}

/** The trigger that opens the bottom sheet on small screens. */
export function PaletteTrigger({
  currentIndex,
  total,
  onOpen,
}: {
  currentIndex: number;
  total: number;
  onOpen: () => void;
}) {
  return (
    <Button type="button" variant="secondary" size="sm" className="lg:hidden" onClick={onOpen} aria-haspopup="dialog">
      <ListChecks className="size-4" aria-hidden />
      Questions {pad2(currentIndex + 1)} / {pad2(total)}
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
      <dl className="grid grid-cols-3 gap-2 font-mono text-[11px] tracking-[0.08em] uppercase lg:grid-cols-1">
        <Legend swatch="filled" label="Answered" count={answered} />
        <Legend swatch="outline" label="Unanswered" count={unanswered} />
        <Legend swatch="flag" label="Flagged" count={flagged} />
      </dl>
      <ol className="grid grid-cols-6 gap-2 lg:grid-cols-5" aria-label="Questions">
        {items.map((item, index) => {
          const current = index === currentIndex;
          const state = item.answered ? "answered" : "unanswered";
          const label = `Question ${index + 1}, ${state}${item.flagged ? ", flagged" : ""}${current ? ", current" : ""}`;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-label={label}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "relative grid aspect-square w-full cursor-pointer place-items-center font-mono text-xs tracking-[0.04em] transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion",
                  item.answered ? "bg-ink text-paper" : "border border-ink text-ink hover:bg-paper-sunk",
                  current && "outline-2 outline-offset-2 outline-ink",
                  current && !item.answered && "border-2",
                )}
              >
                {pad2(index + 1)}
                {item.flagged && (
                  <span
                    aria-hidden="true"
                    className="absolute top-0 right-0 size-3 bg-vermilion [clip-path:polygon(100%_0,0_0,100%_100%)]"
                  />
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function Legend({ swatch, label, count }: { swatch: "filled" | "outline" | "flag"; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="flex items-center">
        <span aria-hidden="true" className="relative inline-grid size-4 place-items-center">
          {swatch === "filled" && <span className="size-4 bg-ink" />}
          {swatch === "outline" && <span className="size-4 border border-ink" />}
          {swatch === "flag" && <span className="size-4 border border-ink" />}
          {swatch === "flag" && (
            <span className="absolute top-0 right-0 size-1.5 bg-vermilion [clip-path:polygon(100%_0,0_0,100%_100%)]" />
          )}
        </span>
        <span className="ml-2 text-ink-soft">{label}</span>
      </dt>
      <dd className="ml-auto tabular-nums">{count}</dd>
    </div>
  );
}
