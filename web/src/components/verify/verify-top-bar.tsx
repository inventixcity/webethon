"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { useSmartBack } from "./smart-back";

/** The bar above the verify pages: the Invigil mark, a smart Back, and sign in. */
export function VerifyTopBar() {
  const back = useSmartBack("/");

  return (
    <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-ink bg-paper px-3 sm:gap-4 sm:px-5 md:px-8">
      <Link href="/" className="flex min-h-11 min-w-0 items-center gap-2 font-mono text-[11px] tracking-[0.14em] uppercase sm:gap-3">
        <span className="grid size-10 shrink-0 place-items-center bg-ink text-xs font-bold text-paper">{siteConfig.mark}</span>
        <span className="truncate">{siteConfig.name}</span>
      </Link>
      <div className="flex shrink-0 items-center gap-1 font-mono text-[11px] tracking-[0.12em] uppercase sm:gap-3">
        <Button type="button" variant="ghost" size="icon" aria-label="Go back" onClick={back} className="size-11 sm:w-auto sm:px-3">
          <ArrowLeft aria-hidden="true" />
          <span className="hidden sm:inline">Back</span>
        </Button>
        <Link href="/login" className="inline-flex min-h-11 items-center px-2 py-1 underline underline-offset-4 hover:text-cobalt-deep">
          Sign in
        </Link>
        <ThemeToggle className="min-h-11 min-w-11 uppercase" />
      </div>
    </header>
  );
}
