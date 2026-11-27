"use client";

import { GripVertical } from "lucide-react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type KanbanCard = { id: string; title: string; tag: string };
export type KanbanColumn = { id: string; title: string; cards: KanbanCard[] };

export type KanbanBoardProps = {
  columns: KanbanColumn[];
  onChange: (columns: KanbanColumn[]) => void;
  /** Fires when a card is picked up or put down, so live updates can wait. */
  onDragChange?: (dragging: boolean) => void;
  className?: string;
};

type Lift = {
  card: KanbanCard;
  column: string;
  index: number;
  width: number;
  height: number;
  startX: number;
  startY: number;
  grabX: number;
  grabY: number;
};

const SPRING = { type: "spring", stiffness: 480, damping: 38 } as const;
const KEYS: Record<string, [column: number, row: number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Moves a card, and returns a new board. */
export function moveCard(columns: KanbanColumn[], card: KanbanCard, toColumn: string, toIndex: number) {
  const next = columns.map((column) => ({ ...column, cards: column.cards.filter((item) => item.id !== card.id) }));
  next.find((column) => column.id === toColumn)?.cards.splice(toIndex, 0, card);
  return next;
}

/** A board with a card you can really throw: it tilts with your hand, and the others part to make room. */
export function KanbanBoard({ columns, onChange, onDragChange, className }: KanbanBoardProps) {
  const reduced = useReducedMotion() ?? false;
  const group = useId();
  const host = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState<Lift | null>(null);
  const [notice, setNotice] = useState("");
  const liftRef = useRef<Lift | null>(null);
  const columnsRef = useRef(columns);
  const pointer = useRef({ x: 0, y: 0 });
  const refocus = useRef<string | null>(null);
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => {
    columnsRef.current = columns;
    if (!refocus.current) return;
    host.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = null;
  }, [columns]);

  useEffect(() => () => detach.current?.(), []);

  const lifted = lift !== null;
  useEffect(() => {
    if (!lifted) return;
    let raf = 0;
    let lastX = pointer.current.x;
    let tilt = 0;
    const step = () => {
      const state = liftRef.current;
      const { x, y } = pointer.current;
      const lean = reduced ? 0 : Math.max(-11, Math.min(11, (x - lastX) * 0.9));
      lastX = x;
      tilt += (lean - tilt) * 0.2;
      if (state && ghost.current) {
        ghost.current.style.transform = `translate(${x - state.grabX}px, ${y - state.grabY}px) rotate(${tilt.toFixed(2)}deg)`;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [lifted, reduced]);

  function update(next: Lift | null) {
    if (Boolean(next) !== Boolean(liftRef.current)) onDragChange?.(Boolean(next));
    liftRef.current = next;
    setLift(next);
  }

  function findSlot(x: number, y: number) {
    const state = liftRef.current;
    const board = host.current;
    if (!state || !board) return;

    const distance = (box: DOMRect) =>
      Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
    let nearest: HTMLElement | null = null;
    let best = Infinity;
    for (const element of board.querySelectorAll<HTMLElement>("[data-column]")) {
      const away = distance(element.getBoundingClientRect());
      if (away < best) {
        best = away;
        nearest = element;
      }
    }
    const column = nearest?.dataset.column;
    if (!nearest || !column) return;

    const cards = [...nearest.querySelectorAll<HTMLElement>("[data-card]")];
    const found = cards.findIndex((element) => {
      const box = element.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
    const index = found < 0 ? cards.length : found;
    if (column !== state.column || index !== state.index) update({ ...state, column, index });
  }

  function drop() {
    const state = liftRef.current;
    if (!state) return;
    const finish = () => {
      onChange(moveCard(columnsRef.current, state.card, state.column, state.index));
      update(null);
    };
    const slot = host.current?.querySelector("[data-slot]")?.getBoundingClientRect();
    const element = ghost.current;
    if (!slot || !element || reduced) {
      finish();
      return;
    }
    const flight = element.animate(
      [{ transform: element.style.transform }, { transform: `translate(${slot.left}px, ${slot.top}px) rotate(0deg)` }],
      { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
    );
    flight.onfinish = finish;
  }

  function onPointerDown(event: React.PointerEvent<HTMLElement>, card: KanbanCard, column: string, index: number) {
    if (event.button !== 0) return;
    // On a phone, cards only lift from the grip, so the page can still scroll.
    if (event.pointerType === "touch" && !(event.target as Element).closest("[data-grip]")) return;

    const box = event.currentTarget.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    const grabX = event.clientX - box.left;
    const grabY = event.clientY - box.top;
    let picked = false;
    pointer.current = start;

    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      detach.current = null;
    };
    const onMove = (move: PointerEvent) => {
      pointer.current = { x: move.clientX, y: move.clientY };
      if (!picked) {
        if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < 6) return;
        picked = true;
        update({ card, column, index, width: box.width, height: box.height, startX: box.left, startY: box.top, grabX, grabY });
      }
      findSlot(move.clientX, move.clientY);
    };
    const onUp = () => {
      stop();
      if (picked) drop();
    };
    const onCancel = () => {
      stop();
      if (picked) update(null);
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key === "Escape") onCancel();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    detach.current = stop;
  }

  function onKeyDown(event: React.KeyboardEvent, card: KanbanCard, columnIndex: number, cardIndex: number) {
    const step = KEYS[event.key];
    const target = step && columns[columnIndex + step[0]];
    if (!step || !target) return;
    event.preventDefault();
    const sameColumn = step[0] === 0;
    const index = sameColumn
      ? Math.max(0, Math.min(target.cards.length - 1, cardIndex + step[1]))
      : Math.min(cardIndex, target.cards.length);
    if (sameColumn && index === cardIndex) return;
    refocus.current = card.id;
    onChange(moveCard(columns, card, target.id, index));
    setNotice(`${card.title} moved to ${target.title}, position ${index + 1}.`);
  }

  const slot = lift && (
    <motion.div
      key="slot"
      data-slot
      layoutId="slot"
      transition={SPRING}
      className="border border-dashed border-ink"
      style={{ height: lift.height }}
    />
  );

  return (
    <LayoutGroup id={group}>
      <div ref={host} className={cn("grid w-full max-w-5xl gap-2 md:grid-cols-3", className)}>
        {columns.map((column, columnIndex) => {
          const cards = column.cards.filter((card) => card.id !== lift?.card.id);
          const here = lift?.column === column.id ? lift.index : -1;
          return (
            <section
              key={column.id}
              data-column={column.id}
              aria-label={column.title}
              className={cn("flex min-h-64 flex-col gap-2 bg-paper-sunk p-3 md:min-h-[26rem]", here >= 0 && "outline outline-ink")}
            >
              <header className="flex items-baseline justify-between px-1 pb-1">
                <h2 className="font-mono text-[11px] tracking-[0.12em] uppercase">{column.title}</h2>
                <span className="font-mono text-xs text-ink-muted tabular-nums">{column.cards.length}</span>
              </header>
              {cards.map((card, index) => (
                <Fragment key={card.id}>
                  {here === index && slot}
                  <motion.button
                    type="button"
                    data-card={card.id}
                    layoutId={card.id}
                    transition={SPRING}
                    aria-roledescription="draggable card"
                    aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
                    onPointerDown={(event) => onPointerDown(event, card, column.id, index)}
                    onKeyDown={(event) => onKeyDown(event, card, columnIndex, index)}
                    className="flex w-full cursor-grab touch-pan-y items-start gap-2 border border-ink bg-paper-raised p-3 text-left select-none active:cursor-grabbing"
                  >
                    <CardBody card={card} />
                  </motion.button>
                </Fragment>
              ))}
              {here >= cards.length && slot}
            </section>
          );
        })}
      </div>

      {lift && (
        <div
          ref={ghost}
          aria-hidden="true"
          className="pointer-events-none fixed top-0 left-0 z-50 flex cursor-grabbing items-start gap-2 border border-ink bg-paper-raised p-3 shadow-[8px_8px_0_-2px_var(--ink)]"
          style={{ width: lift.width, height: lift.height, transform: `translate(${lift.startX}px, ${lift.startY}px)` }}
        >
          <CardBody card={lift.card} />
        </div>
      )}

      <p role="status" className="sr-only">
        {notice}
      </p>
    </LayoutGroup>
  );
}

function CardBody({ card }: { card: KanbanCard }) {
  return (
    <>
      <span data-grip className="-m-1 touch-none p-1 text-ink-muted">
        <GripVertical className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{card.title}</span>
        <span className="mt-1 block font-mono text-[11px] tracking-[0.06em] text-ink-muted">{card.tag}</span>
      </span>
    </>
  );
}
