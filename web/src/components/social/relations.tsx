"use client";
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { api, ApiError, actorName, errorMessage, recordPath, toastViewFor, type Comment } from "@/features/social/client";

const input = "w-full border border-ink bg-paper-raised p-3 text-ink";
/** A failed load. The widget stays in place with this line; actions report their failures as toasts. */
function ErrorText({ error }: { error: unknown }) { return error ? <p role="alert" className="text-sm text-vermilion-deep">{errorMessage(error)}</p> : null; }

export function CommentThread({ entity, recordId }: { entity: string; recordId: string }) {
  const toast = useToast();
  const path = `${recordPath(entity, recordId)}/comments` as const;
  const [viewerId, setViewerId] = useState<string | null>(null);
  useEffect(() => { let mounted = true; api<{ id: string }>("/me").then(user => { if (mounted) setViewerId(user.id); }).catch(() => {}); return () => { mounted = false; }; }, []);
  const [comments, setComments] = useState<Comment[]>([]); const [body, setBody] = useState("");
  const [reply, setReply] = useState<string | null>(null); const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(""); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState<unknown>();
  const load = useCallback(async () => { setLoading(true); try { setComments(await api<Comment[]>(path)); setError(undefined); } catch (e) { setComments([]); setError(e); } finally { setLoading(false); } }, [path]);
  useEffect(() => { void load(); }, [load]);
  async function submit(event: React.FormEvent) { event.preventDefault(); if (!body.trim() || busy) return; setBusy(true); try { await api(path, { method: "POST", body: { body: body.trim(), ...(reply ? { parentId: reply } : {}) } }); setBody(""); setReply(null); await load(); } catch (e) { toast.error(toastViewFor(e)); } finally { setBusy(false); } }
  async function change(id: string, method: "PATCH" | "DELETE") { setBusy(true); try { await api(`/comments/${encodeURIComponent(id)}`, { method, ...(method === "PATCH" ? { body: { body: draft.trim() } } : {}) }); setEditing(null); await load(); } catch (e) { if (e instanceof ApiError && e.status === 404) setComments([]); toast.error(toastViewFor(e)); } finally { setBusy(false); } }
  function item(comment: Comment, nested = false) { return <li key={comment.id} className={nested ? "ml-5 border-l border-rule pl-4" : "border-t border-rule pt-4"}>
    <p className="text-sm text-ink-muted">{comment.deletedAt ? "Deleted comment" : actorName(comment.actor ?? comment.author)}{comment.createdAt ? ` · ${new Date(comment.createdAt).toLocaleString()}` : ""}</p>
    {editing === comment.id ? <div className="mt-2 space-y-2"><label className="block">Edit comment<textarea className={input} value={draft} onChange={e => setDraft(e.target.value)} maxLength={2000} /><span className="block text-sm text-ink-muted">{draft.length} / 2000 characters</span></label><Button variant="link" loading={busy} disabled={busy || !draft.trim()} onClick={() => void change(comment.id, "PATCH")}>Save</Button>{" "}<Button variant="link" onClick={() => setEditing(null)}>Cancel</Button></div> : <p className="mt-2 whitespace-pre-wrap break-words">{comment.body ?? "This comment was deleted."}</p>}
    <div className="mt-2 flex gap-4 text-sm">{!nested && !comment.deletedAt && <Button variant="link" onClick={() => { setReply(comment.id); setEditing(null); }}>Reply</Button>}{(comment.canEdit || comment.mine || (!!viewerId && comment.authorId === viewerId && !comment.deletedAt)) && <Button variant="link" onClick={() => { setEditing(comment.id); setDraft(comment.body ?? ""); }}>Edit</Button>}{(comment.canDelete || comment.mine || (!!viewerId && comment.authorId === viewerId && !comment.deletedAt)) && <Button variant="link" loading={busy} disabled={busy} onClick={() => void change(comment.id, "DELETE")}>Delete</Button>}</div>
    {!nested && comments.some(c => c.parentId === comment.id) && <ul className="mt-4 space-y-4">{comments.filter(c => c.parentId === comment.id).map(c => item(c, true))}</ul>}
  </li>; }
  return <section className="space-y-4" aria-label="Comments"><h3 className="text-lg font-medium">Comments</h3><ErrorText error={error} />{loading ? <p>Loading comments…</p> : comments.length === 0 && !error ? <p className="text-ink-muted">No comments yet.</p> : <ul className="space-y-4">{comments.filter(c => !c.parentId).map(c => item(c))}</ul>}<form onSubmit={submit} className="space-y-2"><label className="block">{reply ? "Reply" : "Add a comment"}<textarea className={`${input} mt-2`} value={body} onChange={e => setBody(e.target.value)} maxLength={2000} /><span className="block text-sm text-ink-muted">{body.length} / 2000 characters</span></label><div className="flex gap-4"><Button type="submit" size="sm" loading={busy} disabled={busy || !body.trim()}>{busy ? "Posting…" : "Post comment"}</Button>{reply && <Button type="button" variant="link" onClick={() => setReply(null)}>Cancel reply</Button>}</div></form></section>;
}

export function ReactionButtons({ entity, recordId, kinds }: { entity: string; recordId: string; kinds: string[] }) {
  const toast = useToast();
  const path = `${recordPath(entity, recordId)}/reactions` as const;
  const [data, setData] = useState<{ counts: Record<string, number>; mine: string[] } | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  useEffect(() => { let active = true; setData(null); api<{ counts: Record<string, number>; mine: string[] }>(path).then(v => { if (active) { setData(v); setError(undefined); } }).catch(e => { if (active) setError(e); }); return () => { active = false; }; }, [path]);
  async function toggle(kind: string) { if (!data || busy) return; const previous = data; const mine = data.mine.includes(kind); setData({ counts: { ...data.counts, [kind]: Math.max(0, (data.counts[kind] ?? 0) + (mine ? -1 : 1)) }, mine: mine ? data.mine.filter(x => x !== kind) : [...data.mine, kind] }); setBusy(true); try { await api(`${path}/${encodeURIComponent(kind)}`, { method: mine ? "DELETE" : "PUT" }); } catch (e) { setData(e instanceof ApiError && e.status === 404 ? null : previous); toast.error(toastViewFor(e)); } finally { setBusy(false); } }
  return <div className="space-y-2"><div className="flex flex-wrap gap-2" aria-label="Reactions">{kinds.map(kind => <Button key={kind} variant="ghost" size="sm" disabled={!data || busy} aria-pressed={data?.mine.includes(kind) ?? false} onClick={() => void toggle(kind)} className="h-8 border border-rule px-3 hover:no-underline aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-paper aria-pressed:hover:bg-ink">{kind}{data ? ` ${data.counts[kind] ?? 0}` : ""}</Button>)}</div><ErrorText error={error} /></div>;
}
function Toggle({ path, label, activeLabel }: { path: `/${string}`; label: string; activeLabel: string }) {
  const toast = useToast();
  const [active, setActive] = useState<boolean | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  useEffect(() => { let mounted = true; setActive(null); api<{ active: boolean }>(path).then(v => { if (mounted) { setActive(v.active); setError(undefined); } }).catch(e => { if (mounted) setError(e); }); return () => { mounted = false; }; }, [path]);
  async function toggle() { if (active === null || busy) return; const previous = active; setActive(!active); setBusy(true); try { await api(path, { method: previous ? "DELETE" : "PUT" }); } catch (e) { setActive(e instanceof ApiError && e.status === 404 ? null : previous); toast.error(toastViewFor(e)); } finally { setBusy(false); } }
  return <span className="inline-flex flex-col gap-1"><Button variant="link" loading={busy} aria-pressed={active ?? false} disabled={active === null || busy} onClick={() => void toggle()}>{active ? activeLabel : label}</Button><ErrorText error={error} /></span>;
}
export function BookmarkToggle({ entity, recordId }: { entity: string; recordId: string }) { return <Toggle path={`${recordPath(entity, recordId)}/bookmark`} label="Bookmark" activeLabel="Remove bookmark" />; }
export function FollowButton({ userId }: { userId: string }) { return <Toggle path={`/users/${encodeURIComponent(userId)}/follow`} label="Follow" activeLabel="Unfollow" />; }
