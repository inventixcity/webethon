"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveRecords, type LiveChange } from "./use-live";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listEntities,
  listRecords,
  updateRecord,
  type Entity,
  type RecordItem,
} from "./client";
export function useEntities() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setEntities(await listEntities());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { entities, loading, error, reload };
}
export function useRecords(entity: string, teamId: string | null = null) {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("-createdAt");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<"mine" | "public" | "all">("mine");
  const generation = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const liveRequests = useRef(new Map<string, number>());
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim().slice(0, 100)), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const load = useCallback(
    async (cursor?: string) => {
      const current = cursor ? generation.current : ++generation.current;
      if (cursor) setLoadingMore(true);
      else {
        requestController.current?.abort();
        requestController.current = new AbortController();
        setLoading(true);
        setRecords([]);
        setNextCursor(null);
      }
      setError(undefined);
      try {
        const result = await listRecords(entity, { cursor, sort, filters, q: query || undefined, scope: teamId ? "team" : scope, teamId: teamId ?? undefined, signal: requestController.current?.signal });
        if (generation.current !== current) return;
        setRecords((previous) => (cursor ? [...previous, ...result.data] : result.data));
        setNextCursor(result.meta.nextCursor);
      } catch (err) {
        if (generation.current === current) setError(err);
      } finally {
        if (generation.current === current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [entity, sort, filters, query, scope, teamId],
  );
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      requestController.current?.abort();
    };
  }, [load]);
  const refresh = useCallback(() => load(), [load]);
  const handleLive = useCallback((changes: LiveChange[] | null) => {
    if (!changes || loading || query || Object.values(filters).some(Boolean) || sort !== "-createdAt") {
      void refresh();
      return;
    }
    const current = generation.current;
    for (const change of changes) {
      const request = (liveRequests.current.get(change.id) ?? 0) + 1;
      liveRequests.current.set(change.id, request);
      if (change.op === "delete") {
        setRecords((old) => old.filter((item) => item.id !== change.id));
        continue;
      }
      void getRecord(entity, change.id).then((record) => {
        if (generation.current !== current || liveRequests.current.get(change.id) !== request) return;
        setRecords((old) => {
          const existing = old.find((item) => item.id === record.id);
          if (existing && existing.version > record.version) return old;
          if ((teamId ? record.teamId !== teamId : record.teamId != null)) return old.filter((item) => item.id !== record.id);
          if (!teamId && scope === "public" && record.visibility !== "public") return old.filter((item) => item.id !== record.id);
          if (existing) return old.map((item) => item.id === record.id ? record : item);
          return change.op === "insert" ? [record, ...old] : old;
        });
      }).catch(() => {
        if (generation.current === current) void refresh();
      });
    }
  }, [entity, filters, loading, query, refresh, scope, sort, teamId]);
  const liveStatus = useLiveRecords(entity, teamId ? "team" : scope, teamId, handleLive);
  const change = async (
    record: RecordItem,
    patch: { data?: Record<string, unknown>; visibility?: "public" | "private" },
  ) => {
    setRecords((old) =>
      old.map((item) =>
        item.id === record.id
          ? { ...item, ...patch, data: patch.data ? { ...item.data, ...patch.data } : item.data }
          : item,
      ),
    );
    try {
      const updated = await updateRecord(entity, record, patch);
      setRecords((old) => old.map((item) => (item.id === record.id ? updated : item)));
      void refresh();
      return updated;
    } catch (err) {
      setRecords((old) => old.map((item) => (item.id === record.id ? record : item)));
      throw err;
    }
  };
  const remove = async (record: RecordItem) => {
    setRecords((old) => old.filter((item) => item.id !== record.id));
    try {
      await deleteRecord(entity, record);
      void refresh();
    } catch (err) {
      setRecords((old) => [...old, record]);
      void refresh();
      throw err;
    }
  };
  const create = async (data: Record<string, unknown>, key: string) => {
    const now = new Date().toISOString();
    const temporary: RecordItem = {
      id: `pending-${key}`,
      entity,
      data,
      visibility: "private",
      version: 0,
      ownerId: "",
      teamId,
      createdAt: now,
      updatedAt: now,
    };
    setRecords((old) => [temporary, ...old]);
    try {
      const result = await createRecord(entity, data, key, teamId);
      setRecords((old) => old.map((item) => (item.id === temporary.id ? result : item)));
      void refresh();
      return result;
    } catch (err) {
      setRecords((old) => old.filter((item) => item.id !== temporary.id));
      throw err;
    }
  };
  const reloadRecord = async (id: string) => {
    const latest = await getRecord(entity, id);
    setRecords((old) => old.map((item) => (item.id === id ? latest : item)));
    return latest;
  };
  return {
    records,
    teamId,
    liveStatus,
    loading,
    loadingMore,
    error,
    nextCursor,
    search,
    setSearch,
    sort,
    setSort,
    filters,
    setFilters,
    scope,
    setScope,
    refresh,
    loadMore: () => nextCursor && load(nextCursor),
    change,
    remove,
    create,
    reloadRecord,
  };
}
