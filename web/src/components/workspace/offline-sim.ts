"use client";

import { useSyncExternalStore } from "react";
import * as network from "@/lib/exam/network";

/**
 * Sandbox demo aid for 5.3: "simulate going offline" without pulling a cable.
 *
 * Preferred path: the engine exports `setSimulatedOffline(on)` from `@/lib/exam/network` (requested from S2),
 * which makes the sync layer behave exactly as if `navigator.onLine` were false. It is read behind a feature
 * check, so this file compiles and works before and after that lands.
 *
 * Fallback path: a transport-level drop. While simulating, every request to this attempt's API
 * (`/api/v1/attempts/{id}/...`) fails the way a dead network does (fetch rejects), so the real engine takes its
 * real offline path: saves go to the on-device journal, heartbeats fail, quality drops to offline. Nothing else
 * on the page is touched. Turning it off fires the browser's `online` event, which is the engine's own
 * reconnect trigger. The server is never told anything special; time keeps running.
 */
type EngineSim = (on: boolean) => void;

function engineHook(): EngineSim | null {
  const key = "setSimulatedOffline";
  const candidate = (network as unknown as Record<string, unknown>)[key];
  return typeof candidate === "function" ? (candidate as EngineSim) : null;
}

let simulated = false;
let scopePrefix: string | null = null;
let nativeFetch: typeof fetch | null = null;
let shim: typeof fetch | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function install(attemptId: string) {
  scopePrefix = `/api/v1/attempts/${encodeURIComponent(attemptId)}`;
  if (shim !== null) return;
  const original = window.fetch.bind(window);
  nativeFetch = original;
  shim = (input, init) => {
    if (simulated && scopePrefix !== null) {
      const url = new URL(requestUrl(input), window.location.href);
      if (url.origin === window.location.origin && url.pathname.startsWith(scopePrefix)) {
        return Promise.reject(new TypeError("Failed to fetch (simulated offline)"));
      }
    }
    return original(input, init);
  };
  window.fetch = shim;
}

/** Restores the browser's fetch when the workspace unmounts. */
export function disposeOfflineSimulation() {
  if (simulated) setSimulatedOffline(false);
  if (shim !== null && window.fetch === shim && nativeFetch !== null) window.fetch = nativeFetch;
  shim = null;
  nativeFetch = null;
  scopePrefix = null;
}

export function setSimulatedOffline(on: boolean, attemptId?: string) {
  if (on === simulated) return;
  const engine = engineHook();
  if (engine) {
    engine(on);
  } else if (on && attemptId) {
    install(attemptId);
  }
  simulated = on;
  notify();
  // Reconnect through the engine's normal path: an immediate heartbeat, then journal sync.
  if (!on) window.dispatchEvent(new Event("online"));
}

export function isSimulatedOffline(): boolean {
  return simulated;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSimulatedOffline(): boolean {
  return useSyncExternalStore(subscribe, isSimulatedOffline, () => false);
}
