"use client";

import { ArrowLeft, ArrowRight, LayoutGrid } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { type AuthScreenId, type AuthSetId, authHref, authSets, kitItems } from "@/config/kit";
import { cn } from "@/lib/utils";

const cell = "flex h-10 items-center gap-2 px-3 transition-colors duration-(--duration-base) hover:bg-ink hover:text-paper";

/** A review bar for moving through every screen. The root layout only shows it in development. */
export function KitNav() {
  const pathname = usePathname();
  const router = useRouter();

  const index = kitItems.findIndex((item) => item.href.split("?")[0] === pathname);
  const total = kitItems.length;
  const previous = index >= 0 ? kitItems[(index - 1 + total) % total] : undefined;
  const next = index >= 0 ? kitItems[(index + 1) % total] : undefined;
  const auth = pathname.match(/^\/auth\/(\d+)\/([a-z-]+)$/);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea")) return;
      if (event.key === "ArrowLeft" && previous) router.push(previous.href);
      if (event.key === "ArrowRight" && next) router.push(next.href);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previous, next, router]);

  return (
    <nav
      data-kit-nav
      aria-label="Kit review"
      className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-stretch divide-x divide-ink border border-ink bg-paper font-mono text-[11px] tracking-[0.1em] whitespace-nowrap text-ink uppercase"
    >
      {previous && (
        <Link href={previous.href} prefetch={false} className={cell} aria-label={`Previous: ${previous.name}`}>
          <ArrowLeft className="size-3.5" />
          <span className="hidden xl:inline">{previous.name}</span>
        </Link>
      )}
      {pathname !== "/kit" && (
        <Link href="/kit" prefetch={false} className={cell}>
          <LayoutGrid className="size-3.5" />
          {index >= 0 ? `${index + 1} / ${total}` : "All screens"}
        </Link>
      )}
      {auth &&
        authSets.map((set) => (
          <Link
            key={set.id}
            href={authHref(set.id as AuthSetId, auth[2] as AuthScreenId)}
            prefetch={false}
            aria-label={`Set ${set.id}: ${set.name}`}
            aria-current={String(set.id) === auth[1] ? "page" : undefined}
            className={cn(cell, String(set.id) === auth[1] && "bg-ink text-paper")}
          >
            {set.id}
          </Link>
        ))}
      <ThemeToggle className={cell} />
      {next && (
        <Link href={next.href} prefetch={false} className={cell} aria-label={`Next: ${next.name}`}>
          <span className="hidden xl:inline">{next.name}</span>
          <ArrowRight className="size-3.5" />
        </Link>
      )}
    </nav>
  );
}
