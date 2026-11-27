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
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-ink bg-paper px-5 md:px-8">
      <Link href="/" className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] uppercase">
        <span className="grid size-7 place-items-center bg-ink text-xs font-bold text-paper">{siteConfig.mark}</span>
        {siteConfig.name}
      </Link>
      <div className="flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] uppercase sm:gap-5">
        <Button type="button" variant="ghost" size="sm" onClick={back}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
        <Link href="/login" className="inline-flex min-h-6 items-center py-1 underline underline-offset-4 hover:text-cobalt-deep">
          Sign in
        </Link>
        <ThemeToggle className="min-h-6 min-w-6 py-1 uppercase" />
      </div>
    </header>
  );
}
