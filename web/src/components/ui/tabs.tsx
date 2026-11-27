"use client";

import Link from "next/link";
import { Tabs as TabsPrimitive } from "radix-ui";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * Three tab shapes, one look: mono uppercase labels on a hairline, with an ink bar that slides to the active item.
 *   NavTabs          - links between routes (aria-current="page")
 *   SegmentedControl - a filter over one list (aria-pressed buttons)
 *   Tabs             - panels inside one page (Radix, roving focus with the arrow keys)
 */

const itemClass =
  "relative inline-flex h-12 shrink-0 items-center gap-2 px-4 font-mono text-[11px] tracking-[0.12em] whitespace-nowrap uppercase transition-colors duration-(--duration-fast) ease-(--ease-enter) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-vermilion";

function Count({ value, active }: { value: number; active: boolean }) {
  return (
    <span
      className={cn(
        "inline-grid h-5 min-w-5 place-items-center px-1 text-[10px] tabular-nums",
        active ? "bg-ink text-paper" : "border border-rule text-ink-muted",
      )}
    >
      {value}
    </span>
  );
}

/** Moves one ink bar under whichever item is active. Transform only, so it never triggers layout. */
function useIndicator(activeKey: string | null) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>("[data-active='true']");
      setBox(active ? { x: active.offsetLeft, w: active.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeKey]);

  const indicator = box ? (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0 left-0 h-0.5 w-px origin-left bg-ink transition-transform duration-(--duration-slow) ease-(--ease-enter)"
      style={{ transform: `translateX(${box.x}px) scaleX(${box.w})` }}
    />
  ) : null;

  return { listRef, indicator };
}

export type NavTab = { href: string; label: string; count?: number; active: boolean };

export function NavTabs({ items, label, className }: { items: NavTab[]; label: string; className?: string }) {
  const activeKey = items.find((item) => item.active)?.href ?? null;
  const { listRef, indicator } = useIndicator(activeKey);
  return (
    <nav aria-label={label} className={cn("-mx-5 overflow-x-auto px-5 md:mx-0 md:px-0", className)}>
      <div ref={listRef} className="relative w-max min-w-full">
      <ul className="flex border-b border-rule">
        {items.map((item) => (
          <li key={item.href} data-active={item.active ? "true" : undefined}>
            <Link
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={cn(itemClass, item.active ? "text-ink" : "text-ink-muted hover:text-ink")}
            >
              {item.label}
              {item.count !== undefined ? <Count value={item.count} active={item.active} /> : null}
            </Link>
          </li>
        ))}
      </ul>
      {indicator}
      </div>
    </nav>
  );
}

export type SegmentOption<T extends string> = { value: T; label: string; count?: number };

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers, for example "Filter exams by status". */
  label: string;
  className?: string;
}) {
  const { listRef, indicator } = useIndicator(value);
  return (
    <div className={cn("-mx-5 max-w-[calc(100%+2.5rem)] overflow-x-auto px-5 md:mx-0 md:max-w-full md:px-0", className)}>
      <div ref={listRef} role="group" aria-label={label} className="relative flex w-max border-b border-rule">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              data-active={active ? "true" : undefined}
              onClick={() => onChange(option.value)}
              className={cn(itemClass, "cursor-pointer", active ? "text-ink" : "text-ink-muted hover:text-ink")}
            >
              {option.label}
              {option.count !== undefined ? <Count value={option.count} active={active} /> : null}
            </button>
          );
        })}
        {indicator}
      </div>
    </div>
  );
}

export function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn("grid gap-6", className)} {...props} />;
}

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex w-full overflow-x-auto border-b border-rule", className)} {...props} />;
}

export function TabsTrigger({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger> & { children: ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        itemClass,
        "-mb-px cursor-pointer border-b-2 border-transparent text-ink-muted hover:text-ink data-[state=active]:border-ink data-[state=active]:text-ink",
        className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("min-w-0 focus-visible:outline-none", className)} {...props} />;
}
