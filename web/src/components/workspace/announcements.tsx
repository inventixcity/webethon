"use client";

import { useEffect, useRef } from "react";
import type { Announcement } from "@/lib/exam/types";

/** Announcements from the examiner: a toast when one arrives (existing ones at load do not toast). */
export function useAnnouncementToasts(items: Announcement[], notify: (body: string) => void) {
  const seen = useRef<Set<string> | null>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(items.map((item) => item.id));
      return;
    }
    for (const item of items) {
      if (seen.current.has(item.id)) continue;
      seen.current.add(item.id);
      notifyRef.current(item.body);
    }
  }, [items]);
}

/** The persistent list. Assertive, because the examiner's instruction may change what the candidate must do. */
export function AnnouncementsPanel({ items }: { items: Announcement[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="ws-announcements-title" className="border-b border-ink bg-paper-raised px-4 py-3 sm:px-6">
      <h2 id="ws-announcements-title" className="font-mono text-[11px] tracking-[0.14em] uppercase">
        Announcements from the examiner ({items.length})
      </h2>
      <ul aria-live="assertive" className="mt-2 grid max-h-40 gap-2 overflow-y-auto">
        {items.map((item) => (
          <li key={item.id} className="border-l-2 border-ink pl-3 font-sans text-sm whitespace-pre-wrap">
            {item.body}
            <span className="block font-mono text-[11px] text-ink-muted">
              {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
