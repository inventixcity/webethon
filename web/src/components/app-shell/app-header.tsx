"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { NotificationsBell } from "@/components/social";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { siteConfig } from "@/config/site";
import { Button } from "@/components/ui/button";

const links = [
  { href: "/app", label: "Home" },
  { href: "/app/dashboard", label: "Dashboard" },
  { href: "/app/data", label: "Data" },
  { href: "/app/ai", label: "AI" },
  { href: "/app/activity", label: "Activity" },
  { href: "/app/files", label: "Files" },
  { href: "/app/teams", label: "Teams" },
  { href: "/app/booking", label: "Booking" },
  { href: "/app/places", label: "Places" },
  { href: "/app/billing", label: "Billing" },
  { href: "/app/settings", label: "Settings" },
];

export function AppHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { let live = true; api<{ user: { role: string } | null }>("/auth/session").then(session => { if (live) setIsAdmin(session.user?.role === "admin"); }).catch(() => {}); return () => { live = false; }; }, []);
  const navigation = (mobile: boolean) => links.map(({ href, label }) => {
    const active = pathname === href || (href !== "/app" && pathname.startsWith(href + "/"));
    return <Link key={href} href={href} aria-current={active ? "page" : undefined} onClick={mobile ? () => setOpen(false) : undefined} className={active ? "underline underline-offset-4" : "opacity-70 transition-opacity duration-(--duration-fast) ease-(--ease-enter) hover:opacity-100"}>{label}</Link>;
  }).concat(isAdmin ? [<Link key="admin" href="/admin" onClick={mobile ? () => setOpen(false) : undefined} className="opacity-70 transition-opacity duration-(--duration-fast) ease-(--ease-enter) hover:opacity-100">Admin</Link>] : []);

  return (
    <header className="relative border-b border-ink font-mono text-[11px] tracking-[0.14em] uppercase">
      <div className="flex h-16 items-center justify-between gap-4 px-5 md:px-8">
        <Link href="/app" className="flex min-w-0 items-center gap-3" onClick={() => setOpen(false)}>
          <span className="grid size-7 shrink-0 place-items-center bg-ink text-xs font-bold text-paper">{siteConfig.mark}</span>
          <span className="truncate">{siteConfig.name}</span>
        </Link>
        <nav aria-label="App" className="hidden items-center gap-5 xl:flex">
          {navigation(false)}
          <ThemeToggle className="uppercase opacity-70 transition-opacity duration-(--duration-fast) ease-(--ease-enter) hover:opacity-100" />
        </nav>
        <div className="ml-auto xl:ml-0">
          <NotificationsBell />
        </div>
        <Button type="button" variant="secondary" size="icon" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="mobile-app-nav" onClick={() => setOpen(!open)} className="size-10 shrink-0 xl:hidden">
          {open ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
        </Button>
      </div>
      <nav id="mobile-app-nav" aria-label="App" className={open ? "absolute inset-x-0 top-full z-40 grid gap-4 border-b border-ink bg-paper px-5 py-5 xl:hidden" : "hidden"}>
        {navigation(true)}
        <ThemeToggle className="w-fit uppercase" />
      </nav>
    </header>
  );
}
