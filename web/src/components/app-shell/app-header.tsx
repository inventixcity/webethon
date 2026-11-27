"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { api } from "@/lib/api/client";
import type { Role } from "@/lib/exam/types";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; exact?: boolean };

const SETTINGS: NavItem = { href: "/app/settings", label: "Settings" };

const EXAMINER_LINKS: NavItem[] = [
  { href: "/app/examiner", label: "Overview", exact: true },
  { href: "/app/examiner/exams", label: "Exams" },
  { href: "/app/examiner/questions", label: "Question bank" },
];

const ADMIN_LINKS: NavItem[] = [
  { href: "/admin", label: "Admin", exact: true },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/audit", label: "Audit" },
];

const CANDIDATE_LINKS: NavItem[] = [{ href: "/app/candidate", label: "My exams", exact: true }];

/** The links each role sees. The server decides what each role may do; this only decides what is shown. */
export function navigationFor(role: Role | null): NavItem[] {
  if (role === "candidate") return [...CANDIDATE_LINKS, SETTINGS];
  if (role === "examiner") return [...EXAMINER_LINKS, SETTINGS];
  if (role === "admin") return [...ADMIN_LINKS, ...EXAMINER_LINKS, SETTINGS];
  return [];
}

const ROLE_LABEL: Record<Role, string> = { candidate: "Candidate", examiner: "Examiner", admin: "Admin" };

function isActive(pathname: string, item: NavItem) {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AppHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // undefined while the session is being read, so the nav doesn't flash the wrong links.
  const [role, setRole] = useState<Role | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api<{ user: { role: string } | null }>("/auth/session")
      .then((session) => {
        if (!live) return;
        const value = session.user?.role;
        setRole(value === "admin" || value === "examiner" || value === "candidate" ? value : null);
      })
      .catch(() => {
        if (live) setRole(null);
      });
    return () => {
      live = false;
    };
  }, []);

  const items = navigationFor(role ?? null);
  const linkClass = (active: boolean) =>
    cn(
      "transition-opacity duration-(--duration-fast) ease-(--ease-enter)",
      active ? "underline underline-offset-4" : "opacity-70 hover:opacity-100",
    );

  const navigation = (mobile: boolean) =>
    items.map((item) => {
      const active = isActive(pathname, item);
      return (
        <Link
          key={item.href}
          href={item.href}
          aria-current={active ? "page" : undefined}
          onClick={mobile ? () => setOpen(false) : undefined}
          className={linkClass(active)}
        >
          {item.label}
        </Link>
      );
    });

  return (
    <header className="relative border-b border-ink font-mono text-[11px] tracking-[0.14em] uppercase">
      <div className="flex h-16 items-center justify-between gap-4 px-5 md:px-8">
        <Link href="/app" className="flex min-w-0 items-center gap-3" onClick={() => setOpen(false)}>
          <span className="grid size-7 shrink-0 place-items-center bg-ink text-xs font-bold text-paper">
            {siteConfig.mark}
          </span>
          <span className="truncate">{siteConfig.name}</span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-5 xl:flex">
          {navigation(false)}
        </nav>

        <div className="ml-auto flex items-center gap-4 xl:ml-0 xl:gap-5">
          {role && (
            <span className="hidden border border-ink px-2 py-1 sm:inline-block">{ROLE_LABEL[role]}</span>
          )}
          <ThemeToggle className="hidden uppercase opacity-70 transition-opacity duration-(--duration-fast) ease-(--ease-enter) hover:opacity-100 xl:flex" />
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-app-nav"
            onClick={() => setOpen(!open)}
            className="size-10 shrink-0 xl:hidden"
          >
            {open ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
          </Button>
        </div>
      </div>

      <nav
        id="mobile-app-nav"
        aria-label="Main"
        hidden={!open}
        className={cn(
          "absolute inset-x-0 top-full z-40 grid gap-4 border-b border-ink bg-paper px-5 py-5 xl:hidden",
          !open && "hidden",
        )}
      >
        {role && <p className="text-ink-muted">Signed in as {ROLE_LABEL[role]}</p>}
        {navigation(true)}
        <ThemeToggle className="w-fit uppercase" />
      </nav>
    </header>
  );
}
