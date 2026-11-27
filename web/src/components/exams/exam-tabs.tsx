"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

  return (
    <nav aria-label="Exam sections" className={cn("-mx-5 overflow-x-auto px-5 md:mx-0 md:px-0", className)}>
      <ul className="flex w-max min-w-full border border-ink bg-paper-raised">
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
                className={cn(
                  "relative inline-flex h-11 items-center border-r border-ink px-4 font-mono text-[12.5px] font-semibold tracking-[0.1em] whitespace-nowrap uppercase transition-colors duration-(--duration-fast) ease-(--ease-enter) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
                  "after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:bg-cobalt",
                  active ? "bg-ink text-paper after:block" : "text-ink-soft after:hidden hover:bg-paper-sunk hover:text-ink",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
