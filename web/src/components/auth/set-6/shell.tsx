"use client";

import { IBM_Plex_Mono, IBM_Plex_Sans, Syne } from "next/font/google";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

const heading = Syne({ subsets: ["latin"], variable: "--font-head", display: "swap" });
const body = IBM_Plex_Sans({ subsets: ["latin"], variable: "--font-display", weight: ["400", "500"], display: "swap" });
const label = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-code", weight: ["400", "500"], display: "swap" });

/** The heading style for this set: wide, heavy and all capitals. */
export const titleClass =
  "font-heading text-[clamp(2rem,4.2vw,3.75rem)] leading-[1] font-extrabold tracking-[-0.01em] uppercase";

type ShellProps = {
  /** What's happening in the sky above the horizon. */
  sky: React.ReactNode;
  title: React.ReactNode;
  note: string;
  /** The form, set on the ground below the horizon. */
  children: React.ReactNode;
};

/** A big sky over a straight horizon, with the form standing on the ground beneath it. */
export function Shell({ sky, title, note, children }: ShellProps) {
  return (
    <main
      data-palette="polar"
      className={cn(heading.variable, body.variable, label.variable, "flex min-h-dvh flex-col bg-paper font-sans text-ink")}
    >
      <section className="relative min-h-[44dvh] flex-1 overflow-hidden">
        {sky}
        <div className="relative z-10 flex items-start justify-between gap-6 p-5 md:p-8">
          <div>
            <Link href="/" className="mb-4 block font-mono text-[11px] tracking-[0.2em] uppercase">
              {siteConfig.name}
            </Link>
            <h1 className={titleClass}>{title}</h1>
            <p className="mt-2 max-w-sm text-[15px] text-ink-soft">{note}</p>
          </div>
          <ThemeToggle className="shrink-0 font-mono text-[11px] tracking-[0.12em] uppercase opacity-80 hover:opacity-100" />
        </div>
      </section>
      <section className="border-t-2 border-ink pb-14">{children}</section>
    </main>
  );
}
