"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { SidebarTide } from "./sidebar-tide";
import { LivePulse } from "@/components/ui/live-pulse";
import { ChevronLeft, ChevronRight, LogOut, Menu, X } from "lucide-react";
import { useExam } from "@/components/exams/use-resource";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Badge } from "@/components/ui/badge";
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
  const [collapsed, setCollapsed] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const groups = navGroupsFor(user.role);
  const home = homeFor(user.role);
  const pathname = usePathname();
  const crumbs = crumbsFor(pathname);

  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem("invigil-sidebar-collapsed") === "true"); } catch { /* Storage may be disabled. */ }
  }, []);
  const toggleCollapsed = () => setCollapsed((value) => {
    const next = !value;
    try { window.localStorage.setItem("invigil-sidebar-collapsed", String(next)); } catch { /* Keep the in-memory preference. */ }
    return next;
  });

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
        className={cn("fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-ink bg-paper transition-[width] duration-(--duration-slow) ease-(--ease-enter) lg:flex", collapsed ? "w-[76px]" : "w-[248px]")}
      >
        <SidebarBody {...frame} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </aside>

      <Drawer open={drawerOpen} onClose={closeDrawer}>
        <SidebarBody {...frame} onNavigate={closeDrawer} />
      </Drawer>

      <div className={cn("min-w-0 transition-[padding] duration-(--duration-slow) ease-(--ease-enter)", collapsed ? "lg:pl-[76px]" : "lg:pl-[248px]")}>
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

function SidebarBody({ user, home, groups, onNavigate, collapsed = false, onToggleCollapsed }: FrameProps & { onNavigate?: () => void; collapsed?: boolean; onToggleCollapsed?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("relative flex h-16 shrink-0 items-center gap-2 overflow-hidden border-b border-ink px-4", collapsed ? "justify-center" : "justify-between")}>
        <SidebarTide />
        <Link href={home} onClick={onNavigate} className="relative flex min-w-0 items-center gap-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
          <span className="grid size-10 shrink-0 place-items-center bg-fill font-mono text-sm font-bold text-on-fill">{siteConfig.mark}</span>
          {!collapsed && <span className="truncate font-mono text-[12px] tracking-[0.1em] uppercase">{siteConfig.name}</span>}
        </Link>
        {!collapsed && <Badge tone="chip" className="relative h-7 px-2">{ROLE_LABEL[user.role] ?? "Account"}</Badge>}
      </div>

      <nav aria-label="Main" className={cn("relative grid min-h-0 flex-1 content-start gap-7 overflow-y-auto py-6", collapsed ? "px-2" : "px-3")}>
        <ActiveNavIndicator />
        {groups.map((group) => (
          <div key={group.label} className="grid gap-2">
            {!collapsed && <p className="px-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">{group.label} <span className="tabular-nums">({group.items.length})</span></p>}
            <ul className="grid gap-1">
              {group.items.map((item, index) => (
                <li key={item.href}>
                  <NavLink item={item} onNavigate={onNavigate} collapsed={collapsed} index={index} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className={cn("grid shrink-0 grid-cols-[minmax(0,1fr)] gap-4 border-t border-ink", collapsed ? "p-2" : "p-5")}>
        {!collapsed && <div className="min-w-0">
          <p className="truncate text-sm font-medium">{user.displayName}</p>
          <p className="truncate font-mono text-[11px] tracking-[0.04em] text-ink-muted">{user.email}</p>
        </div>}
        <div className={cn("flex items-center gap-3 font-mono text-[11px] tracking-[0.12em] uppercase", collapsed ? "flex-col" : "justify-between")}>
          <NavLink item={SETTINGS_ITEM} onNavigate={onNavigate} compact collapsed={collapsed} />
          <ThemeToggle className="h-10 px-2 text-ink-soft hover:text-ink" />
        </div>
        <SignOut compact={collapsed} />
        {onToggleCollapsed && <Button type="button" variant="ghost" size="icon" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggleCollapsed} className="size-10 justify-self-center"><span className="sr-only">{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>{collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}</Button>}
      </div>
    </div>
  );
}

function NavLink({ item, onNavigate, compact = false, collapsed = false, index = 0 }: { item: NavItem; onNavigate?: () => void; compact?: boolean; collapsed?: boolean; index?: number }) {
  const pathname = usePathname();
  const active = isActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      data-active={active ? "true" : undefined}
      onClick={onNavigate}
      className={cn(
        "group relative isolate flex min-h-11 items-center gap-3 overflow-hidden transition-[color,background-color,transform] duration-(--duration-fast) ease-(--ease-enter) active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        collapsed ? "justify-center px-2" : compact ? "px-2" : "px-3 font-mono text-[12px] tracking-[0.08em] uppercase",
        active ? "font-bold text-on-fill" : "text-ink-soft hover:text-ink",
        !active && "before:absolute before:inset-0 before:-z-10 before:-translate-x-full before:bg-hover before:transition-transform before:duration-(--duration-base) before:ease-(--ease-enter) before:content-[''] hover:before:translate-x-0",
        onNavigate && "animate-[fade-in_180ms_ease-out_both]",
      )}
      style={onNavigate ? { animationDelay: `${index * 35}ms` } : undefined}
    >
      <Icon aria-hidden="true" className={cn("relative size-4 shrink-0", active && "text-cobalt")} />
      {!collapsed && <span className="relative truncate">{item.label}</span>}
    </Link>
  );
}

function ActiveNavIndicator() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<number | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current ?? markerRef.current?.parentElement;
    if (!nav) return;
    navRef.current = nav;
    const measure = () => {
      const active = nav.querySelector<HTMLElement>("a[data-active='true']");
      if (active) setPosition(active.offsetTop);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [pathname]);

  const markerRef = useRef<HTMLSpanElement | null>(null);

  return <span ref={markerRef} aria-hidden="true" className={cn("pointer-events-none absolute left-3 right-3 h-11 bg-fill transition-transform duration-(--duration-slow) ease-(--ease-enter)", position === null && "hidden")} style={position === null ? undefined : { transform: `translateY(${position}px)` }}><span className="absolute inset-y-0 left-0 w-0.5 bg-cobalt" /></span>;
}

function SignOut({ compact = false }: { compact?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut(everywhere = false): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      await api(everywhere ? "/auth/signout-all" : "/auth/signout", { method: "POST" });
    } catch {
      setError("Could not sign out. Try again.");
      setPending(false);
      return false;
    }
    // The API has cleared the cookie, so the sign-in page is the right next stop.
    window.location.assign("/login");
    return true;
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <Button type="button" variant="secondary" size={compact ? "icon" : "sm"} aria-label={compact ? "Sign out" : undefined} title={compact ? "Sign out" : undefined} loading={pending} onClick={() => signOut(false)} className={compact ? "size-10 justify-self-center" : "w-full"}>
        <LogOut aria-hidden="true" />
        {!compact && (pending ? "Signing out" : "Sign out")}
      </Button>
      {!compact && <HoldSignOut onConfirm={() => signOut(true)} />}
      {error ? (
        <p role="alert" className="flex items-center gap-2 font-mono text-[11px] tracking-[0.04em] text-vermilion-deep">
          <span aria-hidden="true" className="size-1.5 shrink-0 bg-vermilion" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function HoldSignOut({ onConfirm }: { onConfirm: () => Promise<boolean> }) {
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const startAt = useRef<number | null>(null);
  const frame = useRef<number>(0);
  const duration = 1400;
  const stop = useCallback(() => {
    startAt.current = null;
    cancelAnimationFrame(frame.current);
    setProgress(0);
  }, []);
  const tick = useCallback((time: number) => {
    if (startAt.current === null) return;
    const next = Math.min(1, (time - startAt.current) / duration);
    setProgress(next);
    if (next >= 1) {
      startAt.current = null;
      setDone(true);
      void onConfirm()
        .then((success) => {
          if (success) return;
          setDone(false);
          setProgress(0);
        })
        .catch(() => {
          setDone(false);
          setProgress(0);
        });
      return;
    }
    frame.current = requestAnimationFrame(tick);
  }, [onConfirm]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const start = () => {
    if (done || startAt.current !== null) return;
    startAt.current = performance.now();
    frame.current = requestAnimationFrame(tick);
  };

  return (
    <div className="grid gap-1">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={done}
        aria-label={done ? "Signing out of all devices" : "Sign out of all devices. Press and hold, or hold Space or Enter, to confirm"}
        aria-describedby="signout-all-help"
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onKeyDown={(event) => {
          if ((event.key === " " || event.key === "Enter") && !event.repeat) {
            event.preventDefault();
            start();
          }
        }}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") stop();
        }}
        onBlur={stop}
        className="relative w-full touch-none"
      >
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1 bg-rule" />
        <span
          role="progressbar"
          aria-label="Hold progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-valuetext={`${Math.round(progress * 100)}% held`}
          className="absolute bottom-0 left-0 h-1 bg-cobalt transition-[width] duration-75"
          style={{ width: `${progress * 100}%` }}
        />
        <span className="relative">{done ? "Signing out everywhere" : progress ? "Keep holding" : "Sign out everywhere"}</span>
      </Button>
      <p id="signout-all-help" className="font-mono text-[11px] tracking-[0.04em] text-ink-muted">Hold to confirm · Space or Enter</p>
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
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(
        'a[href]:not([tabindex="-1"]), button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetWidth > 0 || element.offsetHeight > 0);
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
    <header className="sticky top-0 z-20 flex min-h-14 items-center gap-2 border-b border-rule bg-paper px-3 pt-[env(safe-area-inset-top)] sm:gap-4 sm:px-5 md:px-8">
      <Button type="button" variant="secondary" size="icon" aria-label="Open menu" aria-haspopup="dialog" onClick={onMenu} className="size-11 shrink-0 lg:hidden">
        <Menu aria-hidden="true" className="size-5" />
      </Button>
      <Link href={home} aria-label={siteConfig.name} className="grid size-11 shrink-0 place-items-center bg-fill font-mono text-sm font-bold text-on-fill lg:hidden">
        {siteConfig.mark}
      </Link>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1 overflow-hidden">
        <ol className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase sm:gap-2 sm:tracking-[0.12em]">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            // On a phone the trail keeps only its last two steps, so the current page always shows.
            const hidden = index < crumbs.length - 2;
            return (
              <li key={`${index}-${"label" in crumb ? crumb.label : crumb.examId}`} className={cn("flex min-w-0 items-center gap-1 sm:gap-2", hidden && "hidden sm:flex", last && "flex-1")}>
                {last ? (
                  <span aria-current="page" title={"label" in crumb ? crumb.label : undefined} className="block min-w-0 max-w-full truncate whitespace-nowrap font-semibold text-ink">
                    {"label" in crumb ? crumb.label : <ExamTitle examId={crumb.examId} />}
                  </span>
                ) : (
                  <>
                    <Link href={crumb.href ?? home} className="inline-flex min-h-11 min-w-11 max-w-[min(42vw,12rem)] shrink-0 items-center justify-center truncate px-2 py-1 underline-offset-4 transition-colors duration-(--duration-fast) hover:text-ink hover:underline">
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
