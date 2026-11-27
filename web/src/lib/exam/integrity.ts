import { useRef } from "react";
import type { ExamSettings, IntegrityEventInput, IntegrityEventKind } from "@/lib/exam/types";

export const CANDIDATE_NOTICE = "Invigil records when the exam tab loses focus or becomes hidden, fullscreen exits when enabled, paste character counts (never pasted text), copy and context menu actions, connectivity signals, and written answer typing counts (keystrokes, paste counts, pasted characters and active time). These indicators support human review and are not evidence of misconduct. No webcam, microphone, screen capture or keystroke contents are collected.";

type Telemetry = { keystrokes: number; pastes: number; pastedChars: number; activeMs: number };
type Options = { attemptId: string; deviceId: string; settings: ExamSettings; onWarning?: (message: string) => void };

export function startIntegrity({ attemptId, deviceId, settings, onWarning }: Options): () => void {
  const pending: IntegrityEventInput[] = [];
  let stopped = false;
  let focusAt: number | null = null;
  let hiddenAt: number | null = null;
  const send = async (keepalive = false) => {
    if (!pending.length) return;
    const batch = pending.splice(0, 50);
    try {
      await fetch(`/api/v1/attempts/${encodeURIComponent(attemptId)}/events`, {
        method: "POST", credentials: "same-origin", keepalive,
        headers: { "content-type": "application/json", "X-Attempt-Device": deviceId },
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      if (!stopped) pending.unshift(...batch);
    }
  };
  const push = (kind: IntegrityEventKind, detail?: IntegrityEventInput["detail"], durationMs?: number) => {
    pending.push({ kind, clientAt: new Date().toISOString(), ...(detail ? { detail } : {}), ...(durationMs === undefined ? {} : { durationMs }) });
    if (pending.length >= 20) void send();
  };
  const visibility = () => {
    const now = Date.now();
    if (document.visibilityState === "hidden") {
      hiddenAt = now; push("visibility_hidden");
    } else if (hiddenAt !== null) {
      push("visibility_hidden", undefined, Math.min(86_400_000, now - hiddenAt)); hiddenAt = null;
    }
  };
  const blur = () => { if (focusAt === null) { focusAt = Date.now(); push("focus_lost"); } };
  const focus = () => { if (focusAt !== null) { push("focus_lost", undefined, Math.min(86_400_000, Date.now() - focusAt)); focusAt = null; } };
  const fullscreen = () => { if (settings.integrity.fullscreen && !document.fullscreenElement) push("fullscreen_exit"); };
  const root = document.querySelector("[data-exam-root]") ?? document;
  const paste = (event: Event) => {
    const e = event as ClipboardEvent;
    const pastedChars = e.clipboardData?.getData("text").length ?? 0;
    push("paste", { pastedChars });
    if (pastedChars >= 200) onWarning?.("A large paste was recorded as an indicator for review.");
  };
  const copy = () => push("copy");
  const context = () => push("context_menu");
  const pagehide = () => { void send(true); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("blur", blur); window.addEventListener("focus", focus);
  document.addEventListener("fullscreenchange", fullscreen);
  root.addEventListener("paste", paste); root.addEventListener("copy", copy); root.addEventListener("contextmenu", context);
  window.addEventListener("pagehide", pagehide);
  const timer = window.setInterval(() => void send(), 5000);
  return () => {
    stopped = true; window.clearInterval(timer);
    document.removeEventListener("visibilitychange", visibility); window.removeEventListener("blur", blur); window.removeEventListener("focus", focus);
    document.removeEventListener("fullscreenchange", fullscreen); root.removeEventListener("paste", paste); root.removeEventListener("copy", copy);
    root.removeEventListener("contextmenu", context); window.removeEventListener("pagehide", pagehide); void send(true);
  };
}

export function useTypingTelemetry() {
  const current = useRef<Telemetry>({ keystrokes: 0, pastes: 0, pastedChars: 0, activeMs: 0 });
  const activeAt = useRef<number | null>(null);
  const onKeyDown = (event: { key: string; repeat?: boolean }) => {
    if (event.key.length === 1 && !event.repeat) { current.current.keystrokes++; if (activeAt.current === null) activeAt.current = Date.now(); }
  };
  const onPaste = (event: { clipboardData?: { getData(type: string): string } | null }) => {
    const chars = event.clipboardData?.getData("text").length ?? 0;
    current.current.pastes++; current.current.pastedChars += chars;
  };
  const snapshot = (): Telemetry => {
    if (activeAt.current !== null) { current.current.activeMs += Math.max(0, Date.now() - activeAt.current); activeAt.current = null; }
    const out = { ...current.current }; current.current = { keystrokes: 0, pastes: 0, pastedChars: 0, activeMs: 0 }; return out;
  };
  return { onKeyDown, onPaste, snapshot };
}

export async function requestExamFullscreen(el: HTMLElement): Promise<boolean> {
  if (!el.requestFullscreen) return false;
  try { await el.requestFullscreen(); return document.fullscreenElement === el; } catch { return false; }
}
