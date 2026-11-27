"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { MagneticButton } from "@/components/effects/magnetic-button";
import { cn } from "@/lib/utils";

/**
 * The primary call to action on a dashboard. It leans toward the pointer (reduced motion gets a still button) and
 * navigates on click. It is a button, so the destination is pushed through the router.
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
  const router = useRouter();
  return (
    <MagneticButton
      type="button"
      // The vermilion fill keeps paper text in both modes only in the light theme (5.3:1), so this panel stays light.
      data-theme={tone === "vermilion" ? "light" : undefined}
      onClick={() => router.push(href)}
      className={cn(
        "inline-flex h-14 items-center justify-center gap-3 px-8 font-mono text-[12px] tracking-[0.14em] uppercase transition-colors duration-(--duration-base) ease-(--ease-enter) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        // The base is paper and the fill layer is ink, with a difference-blended label. Each tone overrides both,
        // so the label stays paper-coloured on a solid fill.
        tone === "ink"
          ? "border-fill bg-fill text-on-fill [&>span:first-child]:bg-vermilion-deep [&>span:nth-child(2)]:mix-blend-normal [&>span:nth-child(2)]:text-on-fill"
          : "border-vermilion-deep bg-vermilion-deep [&>span:first-child]:bg-fill [&>span:nth-child(2)]:mix-blend-normal [&>span:nth-child(2)]:text-on-fill",
        className,
      )}
    >
      {children}
    </MagneticButton>
  );
}
