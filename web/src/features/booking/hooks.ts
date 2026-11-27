"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAvailability,
  getResource,
  getSlots,
  listMyBookings,
  listResourceBookings,
  listResources,
  type Availability,
  type Booking,
  type Page,
  type Resource,
  type SlotsResponse,
} from "./client";

/** Loads once per change of `deps`, and can reload on demand. Late answers for old inputs are ignored. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data: T | undefined; loading: boolean; error: unknown }>({
    data: undefined,
    loading: true,
    error: undefined,
  });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setState((previous) => ({ data: previous.data, loading: true, error: undefined }));
    load().then(
      (data) => {
        if (active) setState({ data, loading: false, error: undefined });
      },
      (error: unknown) => {
        if (active) setState({ data: undefined, loading: false, error });
      },
    );
    return () => {
      active = false;
    };
    // The caller decides what should trigger a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  /** Replaces the loaded value, for when a save returns the new state. */
  const setData = useCallback((data: T) => setState({ data, loading: false, error: undefined }), []);
  return { ...state, reload, setData };
}

/** A cursor-paged list that can grow with "load more". */
export function usePaged<T>(fetchPage: (cursor?: string) => Promise<Page<T>>, deps: readonly unknown[]) {
  const [state, setState] = useState<{
    items: T[];
    nextCursor: string | null;
    loading: boolean;
    loadingMore: boolean;
    error: unknown;
  }>({ items: [], nextCursor: null, loading: true, loadingMore: false, error: undefined });
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const cursor = pending;
    setState((previous) =>
      cursor
        ? { ...previous, loadingMore: true, error: undefined }
        : { items: [], nextCursor: null, loading: true, loadingMore: false, error: undefined },
    );
    fetchPage(cursor).then(
      (page) => {
        if (!active) return;
        setState((previous) => ({
          items: cursor ? [...previous.items, ...page.data] : page.data,
          nextCursor: page.nextCursor,
          loading: false,
          loadingMore: false,
          error: undefined,
        }));
      },
      (error: unknown) => {
        if (active) setState((previous) => ({ ...previous, loading: false, loadingMore: false, error }));
      },
    );
    return () => {
      active = false;
    };
    // The caller decides what should restart the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, generation, pending]);

  const reload = useCallback(() => {
    setPending(undefined);
    setGeneration((value) => value + 1);
  }, []);

  const nextCursor = state.nextCursor;
  const loadMore = useCallback(() => {
    if (nextCursor) setPending(nextCursor);
  }, [nextCursor]);

  return { ...state, reload, loadMore };
}

export function useResources() {
  return usePaged<Resource>((cursor) => listResources(cursor), []);
}

export function useMyBookings(when: "upcoming" | "past") {
  return usePaged<Booking>((cursor) => listMyBookings(when, cursor), [when]);
}

export function useResourceBookings(id: string, when: "upcoming" | "past") {
  return usePaged<Booking>((cursor) => listResourceBookings(id, when, cursor), [id, when]);
}

export function useResource(id: string) {
  return useLoad<Resource>(() => getResource(id), [id]);
}

export function useAvailability(id: string) {
  return useLoad<Availability>(() => getAvailability(id), [id]);
}

/** Slots for a range of resource-zone dates. Resolves to null until both an id and a range exist. */
export function useSlots(id: string | null, range: { from: string; to: string } | null) {
  const from = range?.from;
  const to = range?.to;
  return useLoad<SlotsResponse | null>(
    () => (id && from && to ? getSlots(id, from, to) : Promise.resolve(null)),
    [id, from, to],
  );
}
