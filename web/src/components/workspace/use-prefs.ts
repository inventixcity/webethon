"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api/client";
import type { WorkspacePrefs } from "@/lib/exam/types";

/**
 * Workspace preferences (4.7). The server copy (GET/PUT /me/prefs) is the source of truth. localStorage keeps
 * a cached copy so the page applies the last choice before the request returns. A local change is not
 * overwritten by a slow GET that started earlier.
 */
export const PREFS_STORAGE_KEY = "invigil.prefs";
const SAVE_DEBOUNCE_MS = 600;

export const DEFAULT_PREFS: WorkspacePrefs = {
  fontScale: 1,
  layout: "single",
  paletteSide: "left",
  contrast: "normal",
  theme: "system",
  timerStyle: "countdown",
  lineSpacing: "normal",
};

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** Accepts only known values. Anything else falls back to the default, so a bad cache cannot break the page. */
export function sanitizePrefs(value: unknown): WorkspacePrefs {
  const source: Record<string, unknown> = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    fontScale: pick(source.fontScale, [0.9, 1, 1.15, 1.3] as const, DEFAULT_PREFS.fontScale),
    layout: pick(source.layout, ["single", "scroll"] as const, DEFAULT_PREFS.layout),
    paletteSide: pick(source.paletteSide, ["left", "right"] as const, DEFAULT_PREFS.paletteSide),
    contrast: pick(source.contrast, ["normal", "high"] as const, DEFAULT_PREFS.contrast),
    theme: pick(source.theme, ["system", "light", "dark"] as const, DEFAULT_PREFS.theme),
    timerStyle: pick(source.timerStyle, ["countdown", "hidden_until_5min"] as const, DEFAULT_PREFS.timerStyle),
    lineSpacing: pick(source.lineSpacing, ["normal", "relaxed"] as const, DEFAULT_PREFS.lineSpacing),
  };
}

function readCache(): WorkspacePrefs | null {
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    return raw ? sanitizePrefs(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeCache(prefs: WorkspacePrefs) {
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be blocked. The server copy still applies.
  }
}

export function usePrefs(onSaveError: () => void): {
  prefs: WorkspacePrefs;
  update: (patch: Partial<WorkspacePrefs>) => void;
} {
  const [prefs, setPrefs] = useState<WorkspacePrefs>(DEFAULT_PREFS);
  const latest = useRef<WorkspacePrefs>(DEFAULT_PREFS);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const onError = useRef(onSaveError);
  onError.current = onSaveError;

  const send = useCallback((next: WorkspacePrefs) => {
    api<WorkspacePrefs>("/me/prefs", { method: "PUT", body: next }).catch(() => onError.current());
  }, []);

  // Apply the cached choice first, then the server copy unless the visitor has changed something meanwhile.
  useEffect(() => {
    const cached = readCache();
    if (cached) {
      latest.current = cached;
      setPrefs(cached);
    }
    let alive = true;
    api<WorkspacePrefs>("/me/prefs")
      .then((server) => {
        if (!alive || dirty.current) return;
        const next = sanitizePrefs(server);
        latest.current = next;
        setPrefs(next);
        writeCache(next);
      })
      .catch(() => {
        // Keep the cached copy. The page works without the server copy.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Flush a pending save when the workspace closes, so the last change is not lost.
  useEffect(() => {
    return () => {
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current);
        send(latest.current);
      }
    };
  }, [send]);

  const update = useCallback(
    (patch: Partial<WorkspacePrefs>) => {
      const next = sanitizePrefs({ ...latest.current, ...patch });
      latest.current = next;
      dirty.current = true;
      setPrefs(next);
      writeCache(next);
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        send(latest.current);
      }, SAVE_DEBOUNCE_MS);
    },
    [send],
  );

  return { prefs, update };
}
