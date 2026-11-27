"use client";

import { useState, type ReactNode } from "react";
import { AsciiCanvas } from "@/components/ascii/ascii-canvas";
import { DriftScene } from "@/components/ascii/scenes/drift";
import { Art, hasArt } from "@/components/ui/art";
import { cn } from "@/lib/utils";

/** Illustrations in public/images for empty screens. Each one shows only when its file exists. */
export type EmptyArt = "empty-exams" | "empty-questions" | "empty-results" | "offline";

type EmptyStateProps = {
  /** Mono caption, for example "Empty bank / 00". */
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  /** One or two buttons that resolve the emptiness. */
  actions?: ReactNode;
  /** An illustration shown above the message. Nothing renders when the file is absent. */
  art?: EmptyArt;
  /**
   * "panel" is the full empty state for a page or tab, with the live ASCII field beside it.
   * "inline" is one quiet ruled line for an empty group inside a page.
   */
  variant?: "panel" | "inline";
  className?: string;
};

/**
 * Says what is missing and what to do about it. The panel variant carries a slow ASCII field that answers the
 * pointer, so an empty screen still feels alive; it is decorative and hidden from screen readers.
 */
export function EmptyState({ eyebrow, title, description, actions, art, variant = "panel", className }: EmptyStateProps) {
  const illustration = art && hasArt(art) ? (
    <Art
      name={art}
      alt=""
      sizes="(min-width: 768px) 26rem, 100vw"
      className="aspect-[3/2] w-full max-w-sm border border-rule"
    />
  ) : null;

  if (variant === "inline") {
    return (
      <div className={cn("grid gap-3 border-t border-rule py-6", className)}>
        {illustration}
        <p className="text-base text-ink-soft">{title}</p>
        {description ? <p className="text-sm text-ink-muted">{description}</p> : null}
        {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
      </div>
    );
  }
  return (
    <section
      aria-label={typeof title === "string" ? title : undefined}
      className={cn("grid border-y border-ink md:grid-cols-12", className)}
    >
      <div className="grid content-center justify-items-start gap-5 py-10 md:col-span-7 md:py-14 md:pr-10">
        {illustration}
        {eyebrow ? (
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">{eyebrow}</p>
        ) : null}
        <p className="max-w-[24ch] text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.02] font-medium tracking-[-0.03em]">
          {title}
        </p>
        {description ? <p className="max-w-[52ch] text-base text-ink-soft">{description}</p> : null}
        {actions ? <div className="flex flex-wrap gap-3 pt-1">{actions}</div> : null}
      </div>
      <DriftField className="h-32 border-t border-rule md:col-span-5 md:h-auto md:min-h-56 md:border-t-0 md:border-l" />
    </section>
  );
}

/** The decorative field on its own, for any surface that wants it. */
export function DriftField({ className }: { className?: string }) {
  const [scene] = useState(() => new DriftScene());
  return (
    <div
      aria-hidden="true"
      className={cn("relative overflow-hidden text-ink", className)}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        scene.point((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
      }}
      onPointerLeave={() => scene.leave()}
    >
      <AsciiCanvas scene={scene} cell={13} className="absolute inset-0" />
    </div>
  );
}
