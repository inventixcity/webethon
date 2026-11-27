"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { describeError, type ErrorView } from "@/lib/errors";
import { listPlaces, MAP_PAGE_SIZE, nearbyPlaces, type ListFilters } from "./client";
import { WORLD } from "./geo";
import type { Bbox, NearbyPlace, Place } from "./types";

export type LoadState = "idle" | "loading" | "ready" | "error";

/**
 * The places inside the map's view. Map moves are debounced, and a slow answer for an old view is
 * dropped. On an error the last good list stays on screen, so the page never goes blank.
 * A transient error is a toast. `loaded` is false until the first answer, so the screen can show
 * its error page for a fatal first load.
 */
export function usePlacesInView() {
  // Starts at the whole world, so the list has places even before the map reports its view.
  const [bbox, setBbox] = useState<Bbox | null>(WORLD);
  const [filters, setFilters] = useState<ListFilters>({});
  const [places, setPlaces] = useState<Place[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<ErrorView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);
  const latest = useRef(0);
  const toast = useToast();

  useEffect(() => {
    if (!bbox) return;
    const current = ++latest.current;
    const timer = setTimeout(async () => {
      setState("loading");
      setError(null);
      try {
        const next = await listPlaces(bbox, filters);
        if (current !== latest.current) return;
        setPlaces(next);
        setLoaded(true);
        setState("ready");
      } catch (caught) {
        if (current !== latest.current) return;
        const view = describeError(caught, { context: "page" });
        setError(view);
        setState("error");
        if (view.kind === "toast") toast.error(view);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [bbox, filters, version, toast]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);

  return {
    places,
    state,
    error,
    loaded,
    /** A full page means there may be more places in view than are shown. */
    truncated: places.length >= MAP_PAGE_SIZE,
    setBbox,
    filters,
    setFilters,
    reload,
  };
}

/** The result of a "near me" search. Runs only when `search` is called. Its failures are always toasts. */
export function useNearby() {
  const [places, setPlaces] = useState<NearbyPlace[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<ErrorView | null>(null);
  const latest = useRef(0);
  const toast = useToast();

  const search = useCallback(async (lat: number, lng: number, radiusKm: number) => {
    const current = ++latest.current;
    setState("loading");
    setError(null);
    try {
      const next = await nearbyPlaces(lat, lng, radiusKm);
      if (current !== latest.current) return;
      setPlaces(next);
      setState("ready");
    } catch (caught) {
      if (current !== latest.current) return;
      const view = describeError(caught, { context: "action" });
      setError(view);
      setState("error");
      toast.error(view);
    }
  }, [toast]);

  const clear = useCallback(() => {
    latest.current++;
    setPlaces([]);
    setState("idle");
    setError(null);
  }, []);

  return { places, state, error, search, clear };
}
