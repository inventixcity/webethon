import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * Square mono chips for status and phase. Tone carries meaning, never decoration:
 *   solid  - the thing is happening now (ongoing, in progress, available)
 *   outline - a settled, positive state (scheduled, published, pass)
 *   dashed - not yet real (draft, pending)
 *   muted  - finished or inactive (archived, none, revoked)
 *   accent - needs a person to look (high review priority, failed check). Use sparingly: it is the one accent.
 */
const badgeVariants = cva(
  "inline-flex h-7 max-w-full shrink-0 items-center gap-2 px-2.5 font-mono text-[11px] leading-none tracking-[0.12em] whitespace-nowrap uppercase",
  {
    variants: {
      tone: {
        solid: "bg-ink text-paper",
        outline: "border border-ink text-ink",
        dashed: "border border-dashed border-ink-muted text-ink-soft",
        muted: "border border-rule text-ink-soft",
        accent: "bg-vermilion-deep text-paper",
      },
      size: {
        sm: "h-6 px-2 text-[10px]",
        md: "",
      },
    },
    defaultVariants: { tone: "outline", size: "md" },
  },
);

type BadgeProps = VariantProps<typeof badgeVariants> & {
  children: ReactNode;
  /** A small square before the label. "live" makes it breathe, for something running right now. */
  dot?: boolean | "live";
  /** Read before the label by screen readers, for example "Phase". */
  srLabel?: string;
  title?: string;
  className?: string;
};

export function Badge({ tone, size, dot, srLabel, title, className, children }: BadgeProps) {
  return (
    <span data-slot="badge" data-tone={tone ?? "outline"} title={title} className={cn(badgeVariants({ tone, size }), className)}>
      {dot ? <BadgeDot live={dot === "live"} accent={tone === "solid"} /> : null}
      {srLabel ? <span className="sr-only">{srLabel}: </span> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

function BadgeDot({ live, accent }: { live: boolean; accent: boolean }) {
  return (
    <span aria-hidden="true" className="relative inline-flex size-1.5 shrink-0">
      {live ? (
        <span className={cn("absolute inset-0 animate-breathe", accent ? "bg-vermilion" : "bg-current")} />
      ) : null}
      <span className={cn("relative size-1.5", accent ? "bg-vermilion" : "bg-current")} />
    </span>
  );
}

export { badgeVariants };
