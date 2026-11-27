"use client";

import { Bodoni_Moda, Jost } from "next/font/google";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

const heading = Bodoni_Moda({
  subsets: ["latin"],
  variable: "--font-head",
  style: ["normal", "italic"],
  axes: ["opsz"],
  display: "swap",
});
const body = Jost({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const label = Jost({ subsets: ["latin"], variable: "--font-code", display: "swap" });

/** The heading style for this set: a high-contrast fashion italic. */
export const titleClass = "font-heading text-[clamp(2.75rem,4.6vw,4.25rem)] leading-[1.02] italic";

export function Shell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <main
      data-palette="maison"
      className={cn(
        heading.variable,
        body.variable,
        label.variable,
        "relative flex min-h-dvh flex-col overflow-hidden bg-paper font-sans text-ink",
        className,
      )}
    >
      <header className="relative z-20 grid h-16 shrink-0 grid-cols-3 items-center bg-paper px-5 text-[11px] tracking-[0.3em] uppercase md:px-8">
        <span aria-hidden="true" className="text-ink-muted">
          Maison
        </span>
        <Link href="/" className="justify-self-center">
          <span className="font-heading text-2xl tracking-normal normal-case italic">{siteConfig.mark}</span>
        </Link>
        <ThemeToggle className="min-h-6 min-w-6 justify-self-end py-1 uppercase" />
      </header>
      {children}
    </main>
  );
}
