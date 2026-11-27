"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api/client";
import { describeError } from "@/lib/errors";
import { getRecord } from "@/features/data/client";
import { BookmarkToggle, CommentThread, ReactionButtons } from "@/components/social";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import type { Entity, RecordItem } from "@/features/data/client";
import { useRecords } from "@/features/data/hooks";
import { getTeam } from "@/features/teams/client";
import type { TeamRole } from "@/features/teams/types";
import { humanize } from "./schema-form";
import { Button } from "@/components/ui/button";
import { ShareDialog } from "@/components/shares/share-dialog";
import { durationSeconds, easing, motionTransition, useReducedMotion } from "@/lib/motion";
type Records = ReturnType<typeof useRecords>;
// Motion wants a mutable tuple; the shared easing constant is readonly.
const enterEase: [number, number, number, number] = [...easing.enter];
const control =
  "block w-full min-w-0 border border-ink bg-paper-raised px-3 py-2 font-sans text-sm normal-case tracking-normal text-ink";
const label = "block space-y-2 font-mono text-xs uppercase tracking-widest";
export function RecordList({
  entity,
  state,
  teamRole,
  onEdit,
  onDelete,
  onVisibility,
}: {
  entity: Entity;
  state: Records;
  teamRole?: TeamRole;
  onEdit: (record: RecordItem) => void;
  onDelete: (record: RecordItem) => void;
  onVisibility: (record: RecordItem) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  // The record being shared. The dialog mounts only while a record is set, so each share starts fresh.
  const [sharing, setSharing] = useState<RecordItem | null>(null);
  const reduced = useReducedMotion();
  const [viewer, setViewer] = useState<{ id: string; role: string } | null>(null);
  useEffect(() => { let active = true; api<{ id: string; role: string }>("/me").then(v => { if (active) setViewer(v); }).catch(() => {}); return () => { active = false; }; }, []);
  const social = (entity as Entity & { social?: { comments?: boolean; reactions?: string[]; bookmarks?: boolean } }).social;
  const hasSocial = Boolean(social?.comments || social?.bookmarks || social?.reactions?.length);
  // Required fields first (usually the title), then the rest in schema order.
  const required = new Set(entity.schema.required ?? []);
  const properties = Object.entries(entity.schema.properties ?? {})
    .sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)))
    .slice(0, 3);
  return (
    <MotionConfig reducedMotion="user">
      <div className="space-y-8">
        <Suspense fallback={null}><FocusedRecord entity={entity} viewer={viewer} onEdit={onEdit} onDelete={onDelete} onVisibility={onVisibility} onShare={setSharing} /></Suspense>
        <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-ink-muted" role="status">
          <span aria-hidden="true" className={`h-2 w-2 ${state.liveStatus === "live" ? "bg-vermilion" : "bg-ink-muted"}`} />
          {state.liveStatus === "live" ? "Live" : state.liveStatus === "connecting" ? "Connecting" : "Offline"}
        </div>
        <div className="grid gap-4 border-y border-rule py-5 sm:grid-cols-2 lg:grid-cols-4">
          {entity.searchable.length > 0 && (
            <label className={label}>
              Search
              <input
                className={control}
                value={state.search}
                maxLength={100}
                onChange={(event) => state.setSearch(event.target.value)}
                placeholder="Search records"
              />
            </label>
          )}
          <label className={label}>
            Sort by
            <select className={control} value={state.sort} onChange={(event) => state.setSort(event.target.value)}>
              {["createdAt", "updatedAt", ...entity.sortable].map((field) => (
                <optgroup key={field} label={humanize(field)}>
                  <option value={field}>{humanize(field)} · ascending</option>
                  <option value={`-${field}`}>{humanize(field)} · descending</option>
                </optgroup>
              ))}
            </select>
          </label>
          {entity.filterable.map((name) => {
            const field = entity.schema.properties?.[name];
            const choices =
              field?.enum?.filter((value) => value !== null) ??
              (field?.type === "boolean" || (Array.isArray(field?.type) && field.type.includes("boolean"))
                ? [true, false]
                : null);
            return (
              <label key={name} className={label}>
                {field?.title ?? humanize(name)}
                {choices ? (
                  <select
                    className={control}
                    value={state.filters[name] ?? ""}
                    onChange={(event) => state.setFilters((old) => ({ ...old, [name]: event.target.value }))}
                  >
                    <option value="">All</option>
                    {choices.map((choice) => (
                      <option key={String(choice)} value={String(choice)}>
                        {String(choice)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={control}
                    value={state.filters[name] ?? ""}
                    onChange={(event) => state.setFilters((old) => ({ ...old, [name]: event.target.value }))}
                    placeholder="Any value"
                  />
                )}
              </label>
            );
          })}
          {!state.teamId && (entity.allowPublic || entity.read === "public") && (
            <label className={label}>
              Scope
              <select
                className={control}
                value={state.scope}
                onChange={(event) => state.setScope(event.target.value as "mine" | "public")}
              >
                <option value="mine">Mine</option>
                <option value="public">Public</option>
              </select>
            </label>
          )}
        </div>
        {!!state.error && (
          <div role="alert" className="text-sm text-vermilion-deep">
            Records didn&apos;t load.{" "}
            <Button variant="link" className="overflow-visible font-sans text-sm normal-case tracking-normal" onClick={() => void state.refresh()}>
              Try again
            </Button>
          </div>
        )}
        {state.loading ? (
          <div aria-label="Loading records" className="space-y-3">
            {[1, 2, 3].map((number) => (
              <div key={number} className="h-24 animate-pulse border border-rule bg-paper-raised motion-reduce:animate-none" />
            ))}
          </div>
        ) : state.records.length === 0 && !state.error ? (
          <div className="border border-rule bg-paper-raised p-8">
            <p className="font-mono text-xs uppercase tracking-widest text-ink-muted">Nothing here yet / 00</p>
            <p className="mt-3 text-2xl">No records found.</p>
            <p className="mt-2 text-ink-muted">Create one or adjust your search and filters.</p>
          </div>
        ) : (
          <div className="border-t border-rule">
            <AnimatePresence initial={false}>
              {state.records.map((record) => (
                <motion.article
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={motionTransition(reduced, { duration: durationSeconds.base, ease: enterEase })}
                  key={record.id}
                  className="grid min-w-0 gap-4 border-b border-rule py-5 md:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="grid min-w-0 gap-4 sm:grid-cols-3">
                    {properties.map(([name, field]) => (
                      <div key={name} className="min-w-0">
                        <p className="font-mono text-xs uppercase tracking-widest text-ink-muted">
                          {field.title ?? humanize(name)}
                        </p>
                        <p className="mt-2 break-words">
                          {record.data[name] == null
                            ? "—"
                            : Array.isArray(record.data[name])
                              ? (record.data[name] as unknown[]).join(", ")
                              : typeof record.data[name] === "object"
                                ? JSON.stringify(record.data[name])
                                : String(record.data[name])}
                        </p>
                      </div>
                    ))}
                  </div>
                  {canWrite(record, viewer, teamRole) && <div className="flex flex-wrap items-start gap-x-4 gap-y-2 font-mono text-xs uppercase tracking-wider">
                    <Button variant="link" className="overflow-visible" onClick={() => onEdit(record)}>
                      Edit
                    </Button>
                    <Button variant="link" className="overflow-visible" onClick={() => onDelete(record)}>
                      Delete
                    </Button>
                    {entity.allowPublic && !record.teamId && (
                      <Button variant="link" className="overflow-visible" onClick={() => onVisibility(record)}>
                        Make {record.visibility === "public" ? "private" : "public"}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setSharing(record)}>
                      Share
                    </Button>
                  </div>}
                  {hasSocial && !record.id.startsWith("pending-") && (
                    <div className="md:col-span-2">
                      <Button variant="link" className="overflow-visible font-sans text-sm normal-case tracking-normal" aria-expanded={selected === record.id} onClick={() => setSelected(selected === record.id ? null : record.id)}>
                        {selected === record.id ? "Close discussion" : "Open discussion"}
                      </Button>
                      {selected === record.id && <div className="mt-4 space-y-5 border-t border-rule pt-4">
                        <div className="flex flex-wrap items-start gap-4 text-sm">
                          {!!social?.reactions?.length && <ReactionButtons entity={entity.name} recordId={record.id} kinds={social.reactions} />}
                          {social?.bookmarks && <BookmarkToggle entity={entity.name} recordId={record.id} />}
                        </div>
                        {social?.comments && <CommentThread entity={entity.name} recordId={record.id} />}
                      </div>}
                    </div>
                  )}
                </motion.article>
              ))}
            </AnimatePresence>
          </div>
        )}
        {state.nextCursor && (
          <Button
            variant="secondary"
            loading={state.loadingMore}
            onClick={() => void state.loadMore()}
          >
            {state.loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
        {sharing && (
          <ShareDialog
            entity={entity.name}
            recordId={sharing.id}
            open
            onOpenChange={(open) => {
              if (!open) setSharing(null);
            }}
          />
        )}
      </div>
    </MotionConfig>
  );
}

function canWrite(record: RecordItem, viewer: { id: string; role: string } | null, role?: TeamRole) {
  if (!viewer) return false;
  if (record.teamId) return role === "owner" || role === "admin" || (role === "member" && viewer.id === record.ownerId);
  return viewer.id === record.ownerId || viewer.role === "admin";
}

function FocusedRecord({ entity, viewer, onEdit, onDelete, onVisibility, onShare }: { entity: Entity; viewer: { id: string; role: string } | null; onEdit: (record: RecordItem) => void; onDelete: (record: RecordItem) => void; onVisibility: (record: RecordItem) => void; onShare: (record: RecordItem) => void }) {
  const id = useSearchParams().get("record");
  const [result, setResult] = useState<{ key: string; record?: RecordItem; error?: unknown } | null>(null);
  const key = `${entity.name}:${id ?? ""}`;
  const [teamAccess, setTeamAccess] = useState<{ id: string; role: TeamRole } | null>(null);
  useEffect(() => { let active = true; setTeamAccess(null); const teamId = result?.record?.teamId; if (teamId) getTeam(teamId).then(team => { if (active) setTeamAccess({ id: teamId, role: team.role }); }).catch(() => {}); return () => { active = false; }; }, [result]);
  useEffect(() => {
    let active = true;
    setResult(null);
    if (id) getRecord(entity.name, id).then(record => { if (active) setResult({ key, record }); }).catch(error => { if (active) setResult({ key, error }); });
    return () => { active = false; };
  }, [entity.name, id, key]);
  if (!id) return null;
  if (!result || result.key !== key) return <p role="status">Loading record…</p>;
  if (result.error || !result.record) return <p role="alert" className="border border-rule p-5 text-vermilion-deep">{describeError(result.error, { context: "action" }).message}</p>;
  const record = result.record;
  const social = (entity as Entity & { social?: { comments?: boolean; reactions?: string[]; bookmarks?: boolean } }).social;
  const canEdit = canWrite(record, viewer, teamAccess?.id === record.teamId ? teamAccess.role : undefined);
  return <section className="space-y-5 border border-ink bg-paper-raised p-5" aria-label="Focused record">
    <h2 className="text-xl font-medium">Record details</h2>
    <dl className="grid gap-4 sm:grid-cols-2">{Object.entries(record.data).map(([name, value]) => <div key={name} className="min-w-0"><dt className="font-mono text-xs uppercase tracking-widest text-ink-muted">{entity.schema.properties?.[name]?.title ?? humanize(name)}</dt><dd className="mt-2 whitespace-pre-wrap break-words">{value == null ? "?" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}</dd></div>)}</dl>
    {canEdit && <div className="flex flex-wrap gap-4 text-sm"><Button variant="link" className="overflow-visible" onClick={() => onEdit(record)}>Edit</Button><Button variant="link" className="overflow-visible" onClick={() => onDelete(record)}>Delete</Button>{entity.allowPublic && !record.teamId && <Button variant="link" className="overflow-visible" onClick={() => onVisibility(record)}>Make {record.visibility === "public" ? "private" : "public"}</Button>}<Button variant="ghost" size="sm" onClick={() => onShare(record)}>Share</Button></div>}
    {(social?.reactions?.length || social?.bookmarks) ? <div className="flex flex-wrap gap-4">{!!social?.reactions?.length && <ReactionButtons key={`reactions:${key}`} entity={entity.name} recordId={id} kinds={social.reactions} />}{social?.bookmarks && <BookmarkToggle key={`bookmark:${key}`} entity={entity.name} recordId={id} />}</div> : null}
    {social?.comments && <CommentThread key={`comments:${key}`} entity={entity.name} recordId={id} />}
  </section>;
}
