import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The primary call to action on a dashboard: a still, solid button link (no pointer-following motion).
 * The colour wipe on hover comes from the shared button styles.
 */
export function MagneticCta({
  href,
  children,
  tone = "ink",
  className,
}: {
  href: string;
  children: ReactNode;
  tone?: "ink" | "vermilion";
  className?: string;
}) {
  return (
    <Link
      href={href}
      // The vermilion fill keeps paper text at 5.3:1 only in the light theme, so this control stays light.
      data-theme={tone === "vermilion" ? "light" : undefined}
      className={cn(
        "inline-flex h-14 items-center justify-center gap-3 border px-8 font-mono text-[12px] tracking-[0.14em] uppercase transition-colors duration-(--duration-base) ease-(--ease-enter) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        tone === "ink"
          ? "border-fill bg-fill text-on-fill hover:border-cobalt hover:bg-cobalt hover:text-paper"
          : "border-vermilion-deep bg-vermilion-deep text-paper hover:bg-vermilion",
        className,
      )}
    >
      {children}
    </Link>
  );
}
