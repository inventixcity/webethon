import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The compact opening of an exam sub-page. The exam header above already carries the page title, phase, window and
 * the one figure, so this only names the section, says what it is for, and holds its actions. No image here.
 */
export function SectionIntro({
  eyebrow,
  title,
  summary,
  actions,
  children,
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("grid gap-3 border-b border-rule pb-5", className)}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid min-w-0 gap-2">
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">{eyebrow}</p>
          <h2 className="text-2xl leading-tight font-medium tracking-[-0.02em] sm:text-[28px]">{title}</h2>
          {summary ? <p className="max-w-[62ch] text-sm text-ink-soft">{summary}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
