"use client";

import { ChevronDown, Megaphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Announcement } from "@/lib/exam/types";
import { cn } from "@/lib/utils";

/** Calls `notify` once for each announcement that arrives after load. Ones present at load stay silent. */
export function useAnnouncementToasts(items: Announcement[], notify: (item: Announcement) => void) {
  const seen = useRef<Set<string> | null>(null);
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  });

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(items.map((item) => item.id));
      return;
    }
    for (const item of items) {
      if (seen.current.has(item.id)) continue;
      seen.current.add(item.id);
      notifyRef.current(item);
    }
  }, [items]);
}

function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The persistent list of examiner announcements. The newest is always visible; earlier ones fold away. It is not
 * a live region: new arrivals are spoken once by the assertive workspace toast, so nothing is read twice.
 */
export function AnnouncementsPanel({ items }: { items: Announcement[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const [latest, ...earlier] = sorted;

  return (
    <section aria-labelledby="ws-announcements-title" className="border-b border-(--ws-line) bg-paper-raised">
      <div className="ws-bar grid gap-2 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h2
            id="ws-announcements-title"
            className="flex items-center gap-2 font-mono text-[11px] tracking-[0.14em] uppercase"
          >
            <Megaphone className="size-3.5" aria-hidden />
            From the examiner
          </h2>
          <span className="font-mono text-[11px] tracking-[0.1em] text-ink-muted">{time(latest.createdAt)}</span>
        </div>
        <p className="max-w-[68ch] font-sans text-[15px] leading-relaxed whitespace-pre-wrap text-ink">{latest.body}</p>
        {earlier.length > 0 && (
          <div>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls="ws-announcements-earlier"
              onClick={() => setExpanded((value) => !value)}
              className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 font-mono text-[11px] tracking-[0.12em] text-ink-soft uppercase underline-offset-4 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
            >
              <ChevronDown
                className={cn("size-3.5 transition-transform duration-(--duration-base)", expanded && "rotate-180")}
                aria-hidden
              />
              {expanded ? "Hide" : "Show"} {earlier.length} earlier
            </button>
            {expanded && (
              <ul id="ws-announcements-earlier" className="mt-1 grid gap-3 border-l border-(--ws-line) pl-4">
                {earlier.map((item) => (
                  <li key={item.id} className="font-sans text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">
                    <span className="mr-2 font-mono text-[11px] text-ink-muted">{time(item.createdAt)}</span>
                    {item.body}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
