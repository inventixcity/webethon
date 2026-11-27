"use client";
import { useEffect, useRef, useState } from "react";

export type LiveChange = { id: string; entity: string; op: "insert" | "update" | "delete"; version: number };
export function useLiveRecords(entity: string, scope: "mine" | "public" | "all" | "team", teamId: string | null, onChange: (changes: LiveChange[] | null) => void) {
  const [status, setStatus] = useState<"live" | "connecting" | "offline">("connecting");
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let pending = new Map<string, LiveChange>();
    let resync = false;
    let opened = false;
    const schedule = (change?: LiveChange) => {
      if (change) pending.set(change.id, change);
      else resync = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        callback.current(resync ? null : Array.from(pending.values()));
        pending = new Map();
        resync = false;
      }, 250);
    };
    const open = () => {
      if (document.hidden) return;
      setStatus("connecting");
      const params = new URLSearchParams({ scope });
      if (scope === "team" && teamId) params.set("teamId", teamId);
      source = new EventSource(`/api/v1/entities/${encodeURIComponent(entity)}/events?${params}`);
      source.onopen = () => {
        setStatus("live");
        if (opened) schedule();
        opened = true;
      };
      source.onerror = () => setStatus("offline");
      source.addEventListener("resync", () => schedule());
      source.addEventListener("change", (event) => {
        try {
          const change = JSON.parse((event as MessageEvent).data) as LiveChange;
          if (change.entity !== entity || typeof change.id !== "string" || !["insert", "update", "delete"].includes(change.op)) schedule();
          else schedule(change);
        } catch {
          schedule();
        }
      });
    };
    const visibility = () => {
      if (document.hidden) {
        source?.close();
        clearTimeout(timer);
        pending.clear();
        resync = false;
        setStatus("offline");
      } else {
        open();
        schedule();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    if (document.hidden) setStatus("offline");
    else open();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      source?.close();
      clearTimeout(timer);
    };
  }, [entity, scope, teamId]);
  return status;
}
