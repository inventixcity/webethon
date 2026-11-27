"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Every examiner exam section, in order. The slug is appended to /app/examiner/exams/{id}. */
export const EXAM_TABS = [
  { slug: "", label: "Overview" },
  { slug: "questions", label: "Questions" },
  { slug: "candidates", label: "Candidates" },
  { slug: "review", label: "Review" },
  { slug: "monitor", label: "Monitor" },
  { slug: "grading", label: "Grading" },
  { slug: "disputes", label: "Disputes" },
  { slug: "results", label: "Results" },
  { slug: "analytics", label: "Analytics" },
] as const;

/** Tab bar for the exam pages. Scrolls sideways on narrow screens instead of wrapping. */
export function ExamTabs({ examId, className }: { examId: string; className?: string }) {
  const pathname = usePathname();
  const base = `/app/examiner/exams/${encodeURIComponent(examId)}`;
  const listRef = useRef<HTMLUListElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>("[data-active='true']");
    if (!list || !active) return;
    setIndicator({ x: active.offsetLeft, width: active.offsetWidth });
    const scroller = list.parentElement;
    if (scroller && scroller.scrollWidth > scroller.clientWidth) {
      const left = active.offsetLeft - (scroller.clientWidth - active.offsetWidth) / 2;
      scroller.scrollTo({ left, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
    const observer = new ResizeObserver(() => setIndicator({ x: active.offsetLeft, width: active.offsetWidth }));
    observer.observe(list);
    return () => observer.disconnect();
  }, [pathname]);

  return (
    <nav aria-label="Exam sections" className={cn("scroll-fade relative -mx-5 overflow-x-auto px-5 md:mx-0 md:px-0", className)}>
      <ul ref={listRef} className="relative flex w-max min-w-full border border-ink bg-paper-raised">
        {EXAM_TABS.map((tab) => {
          const href = tab.slug ? `${base}/${tab.slug}` : base;
          const active = tab.slug
            ? pathname === href || pathname.startsWith(`${href}/`)
            : pathname === base || pathname === `${base}/`;
          return (
            <li key={tab.label}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                data-active={active ? "true" : undefined}
                className={cn(
                  "relative inline-flex h-11 items-center border-r border-ink px-4 font-mono text-[12.5px] font-semibold tracking-[0.1em] whitespace-nowrap uppercase transition-colors duration-(--duration-fast) ease-(--ease-enter) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
                  "",
                  active ? "bg-fill font-bold text-on-fill" : "text-ink-soft hover:bg-hover hover:text-ink",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
        {indicator && <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 h-[3px] origin-left bg-cobalt transition-transform duration-(--duration-slow) ease-(--ease-enter)" style={{ transform: `translateX(${indicator.x}px) scaleX(${indicator.width})` }} />}
      </ul>
    </nav>
  );
}
