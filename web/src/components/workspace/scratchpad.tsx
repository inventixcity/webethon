"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import { api } from "@/lib/api/client";
import type { Scratch } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { Drawer } from "./drawer";
import { SketchCanvas } from "./sketch-canvas";

const AUTOSAVE_MS = 5000;
const DEFAULT_WIDTH = 460;

type Status = "idle" | "loading" | "saving" | "saved" | "error";

/**
 * Scratchpad (4.8): a text pad and a sketch pad, kept on the server, never graded. Mounted for the whole
 * workspace session, so the drawer can close without losing what was typed. Changes autosave every five
 * seconds. A failed save is retried on the next tick.
 */
export function Scratchpad({
  attemptId,
  deviceId,
  open,
  onOpenChange,
}: {
  attemptId: string;
  deviceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [sketch, setSketch] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [tab, setTab] = useState("text");

  const latest = useRef<{ text: string; sketch: string | null }>({ text: "", sketch: null });
  const version = useRef(0);
  const savedVersion = useRef(0);
  const loadedRef = useRef(false);
  const inFlight = useRef(false);

  // Load on open. A load never overwrites edits made before it returned.
  useEffect(() => {
    if (!open || loaded || !deviceId) return;
    let alive = true;
    setStatus("loading");
    api<Scratch>(`/attempts/${encodeURIComponent(attemptId)}/scratch`, {
      headers: { "X-Attempt-Device": deviceId },
    })
      .then((stored) => {
        if (!alive) return;
        if (version.current === 0) {
          latest.current = { text: stored.text, sketch: stored.sketch };
          setText(stored.text);
          setSketch(stored.sketch);
        }
        loadedRef.current = true;
        setLoaded(true);
        setStatus("idle");
      })
      .catch(() => {
        if (alive) setStatus("error");
      });
    return () => {
      alive = false;
    };
  }, [open, loaded, deviceId, attemptId]);

  const flush = useCallback(async () => {
    if (!deviceId || !loadedRef.current || inFlight.current) return;
    if (version.current === savedVersion.current) return;
    inFlight.current = true;
    const snapshot = version.current;
    setStatus("saving");
    try {
      await api<Scratch>(`/attempts/${encodeURIComponent(attemptId)}/scratch`, {
        method: "PUT",
        body: { text: latest.current.text, sketch: latest.current.sketch },
        headers: { "X-Attempt-Device": deviceId },
      });
      savedVersion.current = snapshot;
      setStatus(version.current === snapshot ? "saved" : "saving");
    } catch {
      setStatus("error");
    } finally {
      inFlight.current = false;
    }
  }, [attemptId, deviceId]);

  useEffect(() => {
    const timer = window.setInterval(() => void flush(), AUTOSAVE_MS);
    return () => window.clearInterval(timer);
  }, [flush]);

  function changeText(value: string) {
    latest.current = { ...latest.current, text: value };
    version.current += 1;
    setText(value);
  }

  function changeSketch(dataUrl: string | null) {
    latest.current = { ...latest.current, sketch: dataUrl };
    version.current += 1;
    setSketch(dataUrl);
  }

  function close(next: boolean) {
    if (!next) void flush();
    onOpenChange(next);
  }

  const dirty = version.current !== savedVersion.current;
  const statusLabel =
    status === "loading"
      ? "Loading your scratchpad…"
      : status === "saving"
        ? "Saving…"
        : status === "error"
          ? "Not saved yet. Retrying every 5 seconds."
          : dirty
            ? "Unsaved changes. Saves every 5 seconds."
            : "Saved";

  return (
    <Drawer
      open={open}
      onOpenChange={close}
      title="Scratchpad"
      description="Scratchpad is not graded."
      width={width}
      onWidthChange={setWidth}
      minWidth={320}
      maxWidth={900}
    >
      <Tabs.Root value={tab} onValueChange={setTab} className="flex min-h-full flex-col p-5">
        <Tabs.List aria-label="Scratchpad type" className="grid grid-cols-2 border border-ink">
          <Tabs.Trigger value="text" className={tabClass(tab === "text")}>
            Text
          </Tabs.Trigger>
          <Tabs.Trigger value="sketch" className={tabClass(tab === "sketch")}>
            Sketch
          </Tabs.Trigger>
        </Tabs.List>

        <p role="status" aria-live="polite" className="mt-3 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
          {statusLabel}
        </p>

        <Tabs.Content value="text" className="mt-4 flex flex-1 flex-col">
          <label htmlFor="ws-scratch-text" className="font-mono text-[11px] tracking-[0.12em] uppercase">
            Scratch notes
          </label>
          <textarea
            id="ws-scratch-text"
            value={text}
            disabled={!loaded}
            onChange={(event) => changeText(event.target.value)}
            rows={18}
            className="mt-2 block min-h-72 w-full flex-1 resize-y border border-(--ws-line) bg-paper-raised p-4 font-sans text-base leading-relaxed text-ink caret-vermilion outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
          />
        </Tabs.Content>

        <Tabs.Content value="sketch" className={cn("mt-4 flex flex-1 flex-col")}>
          {loaded ? (
            <SketchCanvas initial={sketch} onChange={changeSketch} />
          ) : (
            <p className="font-sans text-sm text-ink-soft">Loading your sketch…</p>
          )}
        </Tabs.Content>
      </Tabs.Root>
    </Drawer>
  );
}

function tabClass(active: boolean): string {
  return cn(
    "cursor-pointer px-4 py-3 font-mono text-xs tracking-[0.12em] uppercase transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
    active ? "bg-ink text-paper" : "text-ink hover:bg-paper-sunk",
  );
}
