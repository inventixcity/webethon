"use client";

import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getFlags, type PublicFlags } from "@/features/flags/client";
import { describeError, type ErrorView } from "@/lib/errors";

export type FlagsState = {
  /** The evaluated flags for this viewer. Empty until the first read finishes. */
  flags: PublicFlags;
  loading: boolean;
  /** Set when the read failed. Flags then default to off. Not shown as a toast: it's a background read. */
  error: ErrorView | null;
  /** Reads the flags again, for example after an admin changes one in this tab. */
  refresh: () => void;
};

export const FlagsContext = createContext<FlagsState | null>(null);

/**
 * Reads GET /flags once when the app mounts, and again on refresh(). Mounted once in the root layout.
 * Navigation between pages keeps the same provider, so the read is not repeated per page.
 */
export function FlagsProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<PublicFlags>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorView | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getFlags()
      .then((result) => {
        if (!live) return;
        setFlags(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setFlags({});
        setError(describeError(cause, { context: "action" }));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  const value = useMemo<FlagsState>(() => ({ flags, loading, error, refresh }), [flags, loading, error, refresh]);

  return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>;
}
