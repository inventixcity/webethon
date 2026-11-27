"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api/client";

export type ApiState<T> =
  | { status: "loading" }
  /** receivedAt is the device clock when the answer arrived. It anchors the server clock offset. */
  | { status: "ready"; data: T; receivedAt: number }
  | { status: "error"; error: unknown };

/** Loads one API resource on the client and can reload it. Every path is an API path under /api/v1. */
export function useApiData<T>(path: `/${string}`) {
  const [state, setState] = useState<ApiState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api<T>(path).then(
      (data) => {
        if (live) setState({ status: "ready", data, receivedAt: Date.now() });
      },
      (error: unknown) => {
        if (live) setState({ status: "error", error });
      },
    );
    return () => {
      live = false;
    };
  }, [path, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { state, reload };
}
