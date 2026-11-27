"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { SectionLink } from "@/components/app-shell/section-link";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "#method", label: "Method" },
  { href: "#resilience", label: "Resilience" },
  { href: "#integrity", label: "Integrity" },
  { href: "#security", label: "Security" },
  { href: "#roles", label: "Roles" },
] as const;

export function SiteNav() {
  const pathname = usePathname();
  const onHome = pathname === "/";
  const [compact, setCompact] = useState(false);
  const [active, setActive] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const update = () => setCompact(window.scrollY > 24);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  useEffect(() => {
    const sections = NAV.map(({ href }) => document.querySelector(href)).filter((item): item is Element => !!item);
    if (!sections.length) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible?.target.id) setActive(`#${visible.target.id}`);
    }, { rootMargin: "-18% 0px -68% 0px", threshold: [0, 0.25, 0.5] });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  function closeMenu() { setMenuOpen(false); }

  return (
    <header className={cn("sticky top-0 z-30 border-b border-rule bg-paper transition-[height] duration-(--duration-base) ease-(--ease-enter)", compact ? "h-14" : "h-16")}>
      <div className="mx-auto flex h-full items-center justify-between gap-4 px-5 font-mono text-[11px] tracking-[0.12em] uppercase md:px-8">
        <Link href="/" className="flex min-w-0 items-center gap-3 focus-visible:outline-2 focus-visible:outline-focus">
          <span className="grid size-7 shrink-0 place-items-center bg-fill text-xs font-bold text-on-fill">{siteConfig.mark}</span>
          <span className="truncate">Inventix Invigil</span>
        </Link>
        <nav aria-label="Page sections" className="hidden h-full items-center gap-5 lg:flex">
          {NAV.map((item) => !onHome ? <Link key={item.href} href={`/${item.href}`} className="relative inline-flex h-full items-center text-ink-soft transition-colors hover:text-ink">{item.label}</Link> : <SectionLink key={item.href} href={item.href} aria-current={active === item.href ? "location" : undefined} className={cn("relative inline-flex h-full items-center text-ink-soft transition-colors hover:text-ink", active === item.href && "font-bold text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-cobalt")}>{item.label}</SectionLink>)}
          <Link href="/verify" className="inline-flex h-full items-center text-ink-soft transition-colors hover:text-ink">Verify</Link>
          <Link href="/contact" aria-current={pathname === "/contact" ? "page" : undefined} className={cn("relative inline-flex h-full items-center text-ink-soft transition-colors hover:text-ink", pathname === "/contact" && "font-bold text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-cobalt")}>Contact</Link>
        </nav>
        <div className="flex items-center gap-3">
          <ThemeToggle className="hidden min-h-6 min-w-6 py-1 uppercase sm:flex" />
          <Button asChild size="sm" className="hidden sm:inline-flex"><Link href="/contact">Contact us</Link></Button>
          <Button type="button" variant="secondary" size="icon" className="size-10 lg:hidden" aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={menuOpen} aria-controls="site-mobile-nav" onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}</Button>
        </div>
      </div>
      {menuOpen && <nav id="site-mobile-nav" aria-label="Mobile page sections" className="absolute inset-x-0 top-full grid border-b border-ink bg-paper px-5 pb-4 md:px-8 lg:hidden">
        {NAV.map((item) => !onHome ? <Link key={item.href} href={`/${item.href}`} onClick={closeMenu} className="min-h-11 border-t border-rule py-3 text-ink-soft">{item.label}</Link> : <SectionLink key={item.href} href={item.href} onClick={closeMenu} aria-current={active === item.href ? "location" : undefined} className={cn("min-h-11 border-t border-rule py-3 text-ink-soft", active === item.href && "border-l-2 border-l-cobalt pl-3 font-bold text-ink")}>{item.label}</SectionLink>)}
        <Link href="/verify" onClick={closeMenu} className="min-h-11 border-t border-rule py-3">Verify</Link>
        <Link href="/contact" onClick={closeMenu} aria-current={pathname === "/contact" ? "page" : undefined} className={cn("min-h-11 border-t border-rule py-3", pathname === "/contact" && "border-l-2 border-l-cobalt pl-3 font-bold")}>Contact</Link>
        <Link href="/login" onClick={closeMenu} className="min-h-11 border-t border-rule py-3 font-bold">Sign in</Link>
      </nav>}
    </header>
  );
}
