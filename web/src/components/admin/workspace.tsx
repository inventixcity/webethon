"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ErrorPage } from "@/components/errors/error-page";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { hasArt } from "@/components/ui/art";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { actionToast, namedFieldError } from "@/features/admin/errors";
import { adminApi, adminList, isStepUpRequired, queryString, type Row } from "@/features/admin/client";
import { describeError } from "@/lib/errors";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

const input = "min-h-10 border border-ink bg-paper px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion";
// Actions that remove access, content or a record are danger buttons. "Unsuspend" and "Unhide" are not.
export const isDestructive = (title: string) => /^(delete|suspend|revoke|reset|hide|cancel)/i.test(title);
const STEP_UP_FIELDS = ["password", "code"] as const;
const text = (v: unknown): string => v == null ? "?" : typeof v === "object" ? "See details" : String(v);
const label = (key: string) => key === "aiUsage" || key === "ai_usage" ? "AI usage" : key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
export function PageHeading({ title, description }: { title: string; description: string }) { const page = title.toLowerCase(); const key = page === "users" ? "users" : page === "audit" ? "audit" : page === "system" ? "system" : "admin"; const requested = `bg-${key}` as "bg-admin" | "bg-users" | "bg-audit" | "bg-system"; const banner = hasArt(requested) ? requested : "bg-admin"; const caption = page === "overview" ? "FIG. 01 / OVERVIEW" : page === "users" ? "FIG. 01 / USERS" : page === "audit" ? "FIG. 01 / AUDIT" : page === "system" ? "FIG. 01 / SYSTEM" : undefined; return <PageHeader eyebrow="Administration" title={title} description={description} banner={banner} bannerCaption={caption} className="mb-8" />; }
export function Status({ loading, error, empty, onRetry }: { loading?: boolean; error?: unknown; empty?: boolean; onRetry?: () => void }) { if (loading) return <div className="py-8"><BrailleSpinner label="Loading results" className="text-ink" /></div>; if (error) return <LoadError error={error} onRetry={onRetry}/>; if (empty) return <EmptyState art="empty-results" eyebrow="No results / 00" title="No results found." description="Try changing the filters." />; return null; }
/** A load failure replaces its section with the error page for its code, inside the admin layout. */
function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) { const view = describeError(error, { context: "page" }); return <ErrorPage code={view.page} requestId={view.requestId} retryAfterSeconds={view.retryAfterSeconds} onRetry={onRetry} as="div"/>; }
export function DataTable({ rows, onSelect }: { rows: Row[]; onSelect?: (row: Row) => void }) { const keys = Array.from(new Set(rows.flatMap(row => Object.keys(row)))).filter(k => !["data", "before", "after"].includes(k)).slice(0, 7); return <div className="overflow-x-auto border border-rule"><table className="w-full min-w-[600px] text-left text-sm"><thead className="bg-paper-sunk"><tr>{keys.map(k => <th scope="col" key={k} className="px-4 py-3 font-semibold">{label(k)}</th>)}{onSelect && <th scope="col" className="px-4 py-3">Details</th>}</tr></thead><tbody>{rows.map((row, i) => <tr key={String(row.id ?? i)} className="border-t border-rule">{keys.map(k => <td key={k} className="max-w-64 break-words px-4 py-3 align-top">{text(row[k])}</td>)}{onSelect && <td className="px-4 py-3"><Button variant="link" onClick={() => onSelect(row)}>View<span className="sr-only"> {text(row.displayName ?? row.email ?? row.id)}</span></Button></td>}</tr>)}</tbody></table></div>; }
export function Pagination({ previous, next, onPrevious, onNext }: { previous: boolean; next: boolean; onPrevious: () => void; onNext: () => void }) { return <div className="mt-4 flex gap-2"><Button variant="secondary" size="sm" disabled={!previous} onClick={onPrevious}>Previous</Button><Button variant="secondary" size="sm" disabled={!next} onClick={onNext}>Next</Button></div>; }
function useDialogFocus() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    if (!node) return;
    const focusable = () => Array.from(node.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    (node.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0] ?? node).focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== node) return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); node.focus(); return; }
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && i <= 0) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && (i === -1 || i === items.length - 1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
  }, []);
  return ref;
}
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { const dialogRef = useDialogFocus(); useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape" && Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) === dialogRef.current) onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]); return <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="h-full w-full max-w-2xl overflow-y-auto bg-paper p-6"><div className="mb-6 flex items-start justify-between gap-4 border-b border-ink pb-4"><h2 className="text-2xl font-semibold">{title}</h2><Button variant="secondary" size="sm" autoFocus onClick={onClose}>Close</Button></div>{children}</section></div>; }
export type Action = { title: string; target: string; path: `/${string}`; body?: unknown };
export function ConfirmDialog({ action, onCancel, onConfirm, busy }: { action: Action; onCancel: () => void; onConfirm: () => void; busy: boolean }) { const dialogRef = useDialogFocus(); useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onCancel, busy]); return <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"><section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="w-full max-w-md border border-ink bg-paper p-6"><h2 id="confirm-title" className="text-xl font-semibold">{action.title}</h2><p className="my-5">Confirm {action.title.toLowerCase()} for <strong>{action.target}</strong>.</p><div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" autoFocus onClick={onCancel} disabled={busy}>Cancel</Button><Button variant={isDestructive(action.title) ? "danger" : "primary"} size="sm" loading={busy} onClick={onConfirm} disabled={busy}>{busy ? "Working…" : action.title}</Button></div></section></div>; }
export function StepUpModal({ onCancel, onSuccess }: { onCancel: () => void; onSuccess: (expiresAt: string) => void }) { const dialogRef = useDialogFocus(); const [password,setPassword]=useState(""); const [code,setCode]=useState(""); const [errors,setErrors]=useState<Record<string,string>>({}); const toast=useToast(); const [busy,setBusy]=useState(false); useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onCancel, busy]); async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); setErrors({}); try { const result = await adminApi<{expiresAt:string}>("/admin/step-up", { body: { password, ...(code ? {code} : {}) } }); setPassword(""); setCode(""); onSuccess(result.expiresAt); } catch (err) { const named = namedFieldError(err, STEP_UP_FIELDS); if (named) setErrors({ [named.field]: named.message }); else toast.error(actionToast(err)); } finally { setPassword(""); setCode(""); setBusy(false); } } return <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4"><form ref={dialogRef as React.RefObject<HTMLFormElement>} tabIndex={-1} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="step-title" className="grid w-full max-w-md gap-4 border border-ink bg-paper p-6"><h2 id="step-title" className="text-xl font-semibold">Verify your identity</h2><p className="text-sm text-ink-soft">Enter your password and, if enabled, your authenticator code. You will confirm the action again afterwards.</p><label className="grid gap-1 text-sm">Password<input autoFocus required type="password" autoComplete="current-password" aria-invalid={errors.password ? true : undefined} aria-describedby={errors.password ? "step-password-error" : undefined} className={input} value={password} onChange={e => setPassword(e.target.value)} /></label><FieldError id="step-password-error" message={errors.password}/><label className="grid gap-1 text-sm">Authenticator code (if enabled)<input inputMode="numeric" autoComplete="one-time-code" aria-invalid={errors.code ? true : undefined} aria-describedby={errors.code ? "step-code-error" : undefined} className={input} value={code} onChange={e => setCode(e.target.value)} /></label><FieldError id="step-code-error" message={errors.code}/><div className="flex gap-2"><Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button><Button type="submit" size="sm" loading={busy} disabled={busy}>Verify</Button></div></form></div>; }
export function SummaryPage({ title, path, description }: { title: string; path: `/${string}`; description: string }) { const [data,setData]=useState<unknown>(); const [error,setError]=useState<unknown>(); const [loading,setLoading]=useState(true); const [version,setVersion]=useState(0); useEffect(() => { let live=true; setLoading(true); setError(undefined); adminApi(path).then(v => { if(live) setData(v); }).catch(e => { if(live) setError(e); }).finally(() => { if(live) setLoading(false); }); return () => { live=false; }; }, [path, version]); return <><PageHeading title={title} description={description}/><Status loading={loading} error={error} onRetry={() => setVersion(v => v+1)}/>{!loading && !error && <Details value={data}/>}</>; }
export function Details({ value }: { value: unknown }) {
  if (Array.isArray(value)) return value.length ? <div className="space-y-4">{value.map((item, index) => <div key={index} className="border-l-2 border-rule pl-4"><Details value={item}/></div>)}</div> : <span>None</span>;
  if (!value || typeof value !== "object") return <span>{text(value)}</span>;
  return <dl className="divide-y divide-rule border-y border-rule">{Object.entries(value).map(([key,val]) => <div key={key} className="grid gap-1 py-4 sm:grid-cols-[minmax(9rem,1fr)_2fr] sm:gap-6"><dt className="text-sm font-semibold">{label(key)}</dt><dd className="min-w-0 break-words text-sm text-ink-soft">{typeof val === "string" && /^(url|previewUrl)$/i.test(key) && /^(https?:\/\/|\/(?!\/))/.test(val) ? <a className="underline underline-offset-4" href={val} target="_blank" rel="noopener noreferrer">Open file</a> : typeof val === "object" && val !== null ? <Details value={val}/> : text(val)}</dd></div>)}</dl>;
}

const userFilters: [string,string,string[]?][] = [["q","Search"],["role","Role",["user","admin"]],["status","Status",["active","suspended","deleted"]],["verified","Verified",["true","false"]],["mfa","MFA",["true","false"]],["sort","Sort",["newest","oldest"]]];
const auditFilters: [string,string,string[]?][] = [["actor","Actor"],["action","Action"],["target","Target"],["from","From"],["to","To"]];
/**
 * One filter control. The label is linked to the control by id, not by wrapping it, so the control's accessible
 * name is the field name alone (a wrapping label would also pick up the selected option's text).
 */
function FilterControl({ field, value, onChange }: { field: [string,string,string[]?]; value: string; onChange: (value: string) => void }) {
  const id = useId();
  const [key, name, options] = field;
  return (
    <div className="grid min-w-0 gap-2 text-sm">
      <Label htmlFor={id}>{name}</Label>
      {options ? (
        <select id={id} className={input} value={value} onChange={e => onChange(e.target.value)}>
          <option value="">Any</option>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <Input id={id} variant="box" inputSize="sm" type={key === "from" || key === "to" ? "datetime-local" : "text"} value={value} onChange={e => onChange(e.target.value)}/>
      )}
    </div>
  );
}

export function Filters({ fields, onApply }: { fields: [string,string,string[]?][]; onApply: (filters: Record<string,string>) => void }) {
  const [values,setValues]=useState<Record<string,string>>({});
  return (
    <form className="mb-6 flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); onApply(values); }}>
      <div className="flex flex-wrap gap-3">
        {fields.map(field => (
          <FilterControl key={field[0]} field={field} value={values[field[0]] ?? ""} onChange={value => setValues({...values,[field[0]]:value})}/>
        ))}
      </div>
      <Button type="submit" size="sm">Apply filters</Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => { setValues({}); onApply({}); }}>Clear</Button>
    </form>
  );
}
function ListPage({ kind }: { kind: "users" | "audit" }) { const [filters,setFilters]=useState<Record<string,string>>({}); const [cursors,setCursors]=useState<string[]>([""]); const [index,setIndex]=useState(0); const [rows,setRows]=useState<Row[]>([]); const [next,setNext]=useState<string|null>(null); const [loading,setLoading]=useState(true); const [error,setError]=useState<unknown>(); const [selected,setSelected]=useState<Row|null>(null); const [version,setVersion]=useState(0); const path = `/admin/${kind}`; useEffect(() => { let live=true; setLoading(true); setError(undefined); adminList(path,{...filters,limit:"25",cursor:cursors[index]}).then(v => { if(live) {setRows(v.data); setNext(v.meta.nextCursor);} }).catch(e => {if(live) setError(e);}).finally(() => {if(live) setLoading(false);}); return () => {live=false;}; },[path,filters,cursors,index,version]); const apply = (f: Record<string,string>) => {setFilters(f);setCursors([""]);setIndex(0);}; return <><PageHeading title={kind === "users" ? "Users" : "Audit"} description={kind === "users" ? "Find accounts and manage access." : "Review recorded administrative activity."}/><Filters fields={kind === "users" ? userFilters : auditFilters} onApply={apply}/>{kind === "audit" && <Button asChild variant="secondary" size="sm" className="mb-5"><a href={`/api/v1/admin/audit/export${queryString(filters)}`} download>Download CSV</a></Button>}<Status loading={loading} error={error} empty={!loading && !error && rows.length === 0} onRetry={() => setVersion(v => v+1)}/>{!loading && !error && rows.length > 0 && <><DataTable rows={rows} onSelect={kind === "users" ? setSelected : undefined}/><Pagination previous={index>0} next={!!next} onPrevious={() => setIndex(index-1)} onNext={() => {if(next) {setCursors([...cursors.slice(0,index+1),next]);setIndex(index+1);}}}/></>}{selected && <UserDrawer row={selected} onClose={() => setSelected(null)} onChanged={() => setVersion(v => v+1)}/>}</>; }
export function UsersPage() { return <ListPage kind="users"/>; }
export function AuditPage() { return <ListPage kind="audit"/>; }

function UserDetails({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const pick = (item: unknown, keys: string[]) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return {};
    const row = item as Row;
    return Object.fromEntries(keys.filter(key => key in row).map(key => [key, row[key]]));
  };
  const sections: [string, string, string[]][] = [
    ["Sessions", "sessions", ["id", "createdAt", "lastSeenAt", "expiresAt", "revokedAt"]],
    ["Audit activity", "audit", ["id", "at", "action", "targetType", "targetId"]],
    ["Teams", "teams", ["id", "name", "slug", "role"]],
    ["Files", "files", ["id", "originalName", "contentType", "sizeBytes", "createdAt", "deletedAt"]],
    ["Entitlements", "entitlements", ["productId", "status", "currentPeriodEnd"]],
  ];
  return <><h3 className="mb-3 font-semibold">Account</h3><Details value={pick(source.user, ["id", "email", "displayName", "role", "status", "emailVerifiedAt", "createdAt", "updatedAt", "deletedAt", "mfa"])}/>{sections.map(([title,key,keys]) => <section key={key} className="mt-6"><h3 className="mb-3 font-semibold">{title}</h3><Details value={Array.isArray(source[key]) ? (source[key] as unknown[]).map(item => pick(item, keys)) : []}/></section>)}</>;
}

function UserDrawer({ row, onClose, onChanged }: { row: Row; onClose: () => void; onChanged: () => void }) { const id=String(row.id ?? ""); const target=String(row.displayName ?? row.email ?? id); const [detail,setDetail]=useState<unknown>(); const [error,setError]=useState<unknown>(); const [loading,setLoading]=useState(true); const [action,setAction]=useState<Action|null>(null); const [step,setStep]=useState(false); const [busy,setBusy]=useState(false); const [notice,setNotice]=useState(""); const [role,setRole]=useState("user"); const toast=useToast(); const load=useCallback(() => {setLoading(true); setError(undefined); adminApi(`/admin/users/${encodeURIComponent(id)}`).then(setDetail).catch(setError).finally(() => setLoading(false));},[id]); useEffect(() => {load();},[load]); async function run() { if(!action) return; setBusy(true); try { await adminApi(action.path,{method:"POST",body:action.body}); setNotice(`${action.title} completed for ${target}.`);setAction(null);onChanged();load(); } catch(e) { if(isStepUpRequired(e)) setStep(true); else toast.error(actionToast(e)); } finally {setBusy(false);} } const actions: [string,string,unknown?][] = [["Suspend","suspend"],["Unsuspend","unsuspend"],["Change role","role",{role}],["Revoke sessions","sessions/revoke"],["Reset MFA","mfa/reset"],["Resend verification","verification/resend"],["Delete","delete"],["Restore","restore"]]; return <Drawer title={target} onClose={onClose}><p role="status" className="mb-3 text-sm">{notice}</p><Status loading={loading} error={error} onRetry={load}/>{detail != null && <UserDetails value={detail}/>}<h3 className="mb-3 mt-8 font-semibold">Account actions</h3><label className="mb-3 grid max-w-48 gap-1 text-sm">Role<select className={input} value={role} onChange={e => setRole(e.target.value)}><option value="user">User</option><option value="admin">Admin</option></select></label><div className="flex flex-wrap gap-2">{actions.map(([title,suffix,body]) => <Button key={suffix} variant={isDestructive(title) ? "danger" : "secondary"} size="sm" onClick={() => setAction({title,target,path:`/admin/users/${encodeURIComponent(id)}/${suffix}`,body})}>{title}</Button>)}</div>{action && !step && <ConfirmDialog action={action} onCancel={() => setAction(null)} onConfirm={run} busy={busy}/>} {step && <StepUpModal onCancel={() => {setStep(false);setAction(null);}} onSuccess={expiresAt => {setStep(false);setNotice(`Identity verified until ${new Date(expiresAt).toLocaleString()}. Confirm the action to continue.`);}}/>}</Drawer>; }
