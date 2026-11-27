"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { SidebarTide } from "./sidebar-tide";
import { LivePulse } from "@/components/ui/live-pulse";
import { LogOut, Menu, X } from "lucide-react";
import { useExam } from "@/components/exams/use-resource";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { HoldButton } from "@/components/effects/hold-button";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { crumbsFor, homeFor, isActive, navGroupsFor, ROLE_LABEL, SETTINGS_ITEM, type Crumb, type NavItem } from "./nav";

export type ShellUser = { displayName: string; email: string; role: string };

/**
 * The signed-in frame for every role: a fixed sidebar from lg up, a drawer behind a menu button below it, and a slim
 * top bar with the breadcrumb. The page content sits in one main landmark, capped at 1280px.
 */
export function AppShell({ user, children }: { user: ShellUser; children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const groups = navGroupsFor(user.role);
  const home = homeFor(user.role);
  const pathname = usePathname();
  const crumbs = crumbsFor(pathname);

  const frame = { user, home, groups };

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:bg-paper focus:px-4 focus:py-3 focus:outline-2 focus:outline-focus"
      >
        Skip to content
      </a>

      <aside
        aria-label="Sidebar"
        className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-ink bg-paper lg:flex"
      >
        <SidebarBody {...frame} />
      </aside>

      <Drawer open={drawerOpen} onClose={closeDrawer}>
        <SidebarBody {...frame} onNavigate={closeDrawer} />
      </Drawer>

      <div className="min-w-0 lg:pl-[248px]">
        <TopBar crumbs={crumbs} home={home} onMenu={() => setDrawerOpen(true)} />
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1280px] min-w-0 px-5 pt-8 pb-20 focus:outline-none md:px-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

type FrameProps = { user: ShellUser; home: string; groups: ReturnType<typeof navGroupsFor> };

function SidebarBody({ user, home, groups, onNavigate }: FrameProps & { onNavigate?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex h-24 shrink-0 items-end overflow-hidden border-b border-ink px-5 pb-4">
        <SidebarTide />
        <Link href={home} onClick={onNavigate} className="relative flex min-w-0 items-center gap-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
          <span className="grid size-8 shrink-0 place-items-center bg-fill font-mono text-sm font-bold text-on-fill">{siteConfig.mark}</span>
          <span className="truncate font-mono text-[12px] tracking-[0.14em] uppercase">{siteConfig.name}</span>
        </Link>
      </div>

      <div className="shrink-0 px-5 pt-5">
        <Badge tone="chip">{ROLE_LABEL[user.role] ?? "Account"}</Badge>
      </div>

      <nav aria-label="Main" className="grid min-h-0 flex-1 content-start gap-7 overflow-y-auto px-3 py-6">
        {groups.map((group) => (
          <div key={group.label} className="grid gap-2">
            <p className="px-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">{group.label}</p>
            <ul className="grid gap-1">
              {group.items.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-4 border-t border-ink p-5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{user.displayName}</p>
          <p className="truncate font-mono text-[11px] tracking-[0.04em] text-ink-muted">{user.email}</p>
        </div>
        <div className="flex items-center justify-between gap-3 font-mono text-[11px] tracking-[0.12em] uppercase">
          <NavLink item={SETTINGS_ITEM} onNavigate={onNavigate} compact />
          <ThemeToggle className="h-10 px-2 text-ink-soft hover:text-ink" />
        </div>
        <SignOut />
      </div>
    </div>
  );
}

function NavLink({ item, onNavigate, compact = false }: { item: NavItem; onNavigate?: () => void; compact?: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-3 transition-colors duration-(--duration-fast) ease-(--ease-enter) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        compact ? "h-10 px-2 text-ink-soft hover:text-ink" : "h-10 px-3 font-mono text-[12px] tracking-[0.08em] uppercase",
        !compact && (active ? "relative bg-fill text-on-fill before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-cobalt" : "text-ink-soft hover:bg-hover hover:text-ink"),
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function SignOut() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut(everywhere = false) {
    setPending(true);
    setError(null);
    try {
      await api(everywhere ? "/auth/signout-all" : "/auth/signout", { method: "POST" });
    } catch {
      setError("Could not sign out. Try again.");
      setPending(false);
      return;
    }
    // The API has cleared the cookie, so the sign-in page is the right next stop.
    window.location.assign("/login");
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <Button type="button" variant="secondary" size="sm" loading={pending} onClick={() => signOut(false)} className="w-full">
        <LogOut aria-hidden="true" />
        {pending ? "Signing out" : "Sign out"}
      </Button>
      <HoldButton
        label="Hold: all devices"
        doneLabel="Signing out everywhere"
        duration={1400}
        onConfirm={() => void signOut(true)}
        className="w-full min-w-0 overflow-hidden"
      />
      {error ? (
        <p role="alert" className="flex items-center gap-2 font-mono text-[11px] tracking-[0.04em] text-vermilion-deep">
          <span aria-hidden="true" className="size-1.5 shrink-0 bg-vermilion" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The mobile navigation: a dialog that traps focus, closes on Escape and returns focus to the menu button. */
function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    panel.current?.querySelector<HTMLElement>("a[href]")?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      returnTo?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button type="button" aria-label="Close menu" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-scrim" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="absolute inset-y-0 left-0 flex w-[min(86vw,300px)] flex-col border-r border-ink bg-paper"
      >
        <div className="flex h-16 shrink-0 items-center justify-end border-b border-ink px-4">
          <Button type="button" variant="secondary" size="icon" aria-label="Close menu" onClick={onClose} className="size-10">
            <X aria-hidden="true" className="size-5" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

function TopBar({ crumbs, home, onMenu }: { crumbs: Crumb[]; home: string; onMenu: () => void }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b border-rule bg-paper px-5 md:px-8">
      <Button type="button" variant="secondary" size="icon" aria-label="Open menu" aria-haspopup="dialog" onClick={onMenu} className="size-10 shrink-0 lg:hidden">
        <Menu aria-hidden="true" className="size-5" />
      </Button>
      <Link href={home} aria-label={siteConfig.name} className="grid size-8 shrink-0 place-items-center bg-fill font-mono text-sm font-bold text-on-fill lg:hidden">
        {siteConfig.mark}
      </Link>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            // On a phone the trail keeps only its last two steps, so the current page always shows.
            const hidden = index < crumbs.length - 2;
            return (
              <li key={`${index}-${"label" in crumb ? crumb.label : crumb.examId}`} className={cn("flex min-w-0 items-center gap-2", hidden && "hidden sm:flex")}>
                {last ? (
                  <span aria-current="page" className="min-w-0 max-w-[36ch] truncate text-ink">
                    {"label" in crumb ? crumb.label : <ExamTitle examId={crumb.examId} />}
                  </span>
                ) : (
                  <>
                    <Link href={crumb.href ?? home} className="shrink-0 underline-offset-4 transition-colors duration-(--duration-fast) hover:text-ink hover:underline">
                      {"label" in crumb ? crumb.label : <ExamTitle examId={crumb.examId} />}
                    </Link>
                    <span aria-hidden="true" className="shrink-0">/</span>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <OnlineStatus />
    </header>
  );
}

const subscribeOnline = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};

/** The connection state in the top bar. Cobalt and pulsing when online, vermilion when the browser is offline. */
function OnlineStatus() {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  return (
    <p role="status" className="hidden shrink-0 items-center gap-2 font-mono text-[11px] tracking-[0.12em] uppercase sm:flex">
      {online ? (
        <>
          <LivePulse />
          <span className="text-cobalt-deep">Online</span>
        </>
      ) : (
        <>
          <span aria-hidden="true" className="size-2 bg-vermilion" />
          <span className="text-vermilion-deep">Offline</span>
        </>
      )}
    </p>
  );
}

/** The live title of the exam in the breadcrumb. It reloads when the exam changes anywhere in the app. */
function ExamTitle({ examId }: { examId: string }) {
  const { data } = useExam(examId);
  return <>{data?.title ?? "Exam"}</>;
}
