"use client";

import { Fraunces, Hanken_Grotesk } from "next/font/google";
import Link from "next/link";
import { LiveCanvas, type LiveScene } from "@/components/canvas/live-canvas";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

const heading = Fraunces({
  subsets: ["latin"],
  variable: "--font-head",
  axes: ["SOFT", "WONK", "opsz"],
  display: "swap",
});
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const label = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-code", display: "swap" });

/** The heading style for this set: a soft, light, old-style serif. */
export const titleClass =
  "font-heading text-[clamp(2.5rem,3.8vw,3.5rem)] leading-[1.04] font-light tracking-[-0.02em] [font-variation-settings:'SOFT'_100,'WONK'_1]";

type ShellProps = {
  scene: LiveScene;
  children: React.ReactNode;
};

/** A living scene fills the page, and the form floats over it on a single sheet. */
export function Shell({ scene, children }: ShellProps) {
  return (
    <main
      data-palette="botanica"
      className={cn(heading.variable, body.variable, label.variable, "relative min-h-dvh bg-paper font-sans text-ink")}
    >
      <div className="absolute inset-0 overflow-hidden">
        <LiveCanvas scene={scene} />
      </div>

      <div className="relative z-10 flex min-h-dvh flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between px-5 md:px-8">
          <Link href="/" className="font-heading text-xl font-light italic">
            {siteConfig.name}
          </Link>
          <ThemeToggle className="min-h-6 bg-paper-raised px-3 py-1.5 text-[11px] tracking-[0.08em] uppercase" />
        </header>
        <div className="flex flex-1 items-center justify-end px-4 pb-6 max-lg:items-end max-lg:pt-[32dvh] md:px-10">
          <section className="w-full max-w-[27rem] border border-rule bg-paper-raised p-7 sm:p-9">{children}</section>
        </div>
      </div>
    </main>
  );
}
