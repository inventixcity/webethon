"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { ask, cancelAction, confirmAction, type PendingAction, type Source } from "@/features/assist/client";
import { aiErrorView } from "@/features/ai/errors";

/** Codes that mean the change was made against an older version, or is gone. Asking again is the way forward. */
const STALE_CODES: ReadonlySet<string> = new Set(["VERSION_CONFLICT", "CONFLICT", "NOT_FOUND"]);
const STALE_MESSAGE = "This change is out of date. Ask again.";

export function AskPanel({ entity, onConfirmed }: { entity?: string; onConfirmed?: () => void }) {
  const router = useRouter();
  const inputId = useId();
  const [question, setQuestion] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [actions, setActions] = useState<PendingAction[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  // Which proposed change is being confirmed or cancelled. Only its own button shows the spinner.
  const [busy, setBusy] = useState<{ id: string; confirm: boolean } | null>(null);
  const toast = useToast();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);

  async function run(text: string) {
    if (controller.current) return;
    const request = new AbortController(); controller.current = request;
    setStreaming(true); setError(""); setLastQuestion(text); setAnswer(""); setSources([]); setActions([]);
    try {
      for await (const event of ask(text, entity, request.signal)) {
        if (event.type === "delta") setAnswer((old) => old + event.text);
        if (event.type === "sources") setSources(event.sources);
        if (event.type === "pending") setActions(event.pendingActions);
      }
    } catch (reason) { if (!request.signal.aborted) setError(aiErrorView(reason).message); }
    finally { if (controller.current === request) controller.current = null; setStreaming(false); }
  }
  async function resolve(action: PendingAction, confirm: boolean) {
    if (busy) return;
    setBusy({ id: action.actionId, confirm });
    try {
      if (confirm) { await confirmAction(action.actionId); router.refresh(); onConfirmed?.(); }
      else await cancelAction(action.actionId);
      setActions((old) => old.filter((item) => item.actionId !== action.actionId));
    } catch (reason) {
      const view = aiErrorView(reason);
      // A stale change can't be confirmed any more. It leaves the list, so the person asks again.
      if (STALE_CODES.has(view.code)) {
        toast.error({ ...view, kind: "toast", title: "Out of date", message: STALE_MESSAGE });
        setActions((old) => old.filter((item) => item.actionId !== action.actionId));
      } else {
        toast.error({ ...view, kind: "toast" });
      }
    }
    finally { setBusy(null); }
  }
  return (
    <section aria-label="Ask assistant" className="mt-12 border-y border-rule py-6">
      <h2 className="text-2xl font-medium">Ask about your data</h2>
      <p className="mt-2 text-ink-muted">Ask a question or request a change. You review changes before they are applied.</p>
      <form className="mt-5" onSubmit={(event) => { event.preventDefault(); const text = question.trim(); if (text && !streaming && actions.length === 0) { setQuestion(""); void run(text); } }}>
        <label htmlFor={inputId} className="text-sm">Your question</label>
        <textarea id={inputId} value={question} maxLength={8000} onChange={(event) => setQuestion(event.target.value)} rows={3} className="mt-2 block w-full resize-y border border-rule bg-paper-raised p-4 text-ink" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-ink-muted">{question.length.toLocaleString()} / 8,000</span>{streaming ? <Button type="button" onClick={() => { controller.current?.abort(); setError("Response stopped. You can retry the question."); }}>Stop</Button> : <Button type="submit" disabled={!question.trim() || actions.length > 0}>Ask</Button>}</div>
      </form>
      {(answer || streaming) && <div className="mt-6 border-t border-rule pt-5"><h3 className="text-sm font-medium">Answer</h3><p className="mt-2 whitespace-pre-wrap break-words leading-relaxed" aria-live="polite">{answer || "Thinking…"}</p></div>}
      {sources.length > 0 && <div className="mt-5"><h3 className="text-sm font-medium">Sources</h3><ul className="mt-2 space-y-1">{sources.map((source) => <li key={`${source.entity}:${source.id}`}><Link className="break-words underline underline-offset-4" href={`/app/data/${encodeURIComponent(source.entity)}?record=${encodeURIComponent(source.id)}`}>{source.label}</Link></li>)}</ul></div>}
      {actions.length > 0 && <p className="mt-5 text-sm text-ink-muted">Confirm or cancel each proposed change before asking another question.</p>}
      {actions.map((action) => <article key={action.actionId} className="mt-5 border border-rule bg-paper-raised p-4"><h3 className="font-medium">Review {action.kind} in {action.entity}</h3>{action.recordId && <p className="mt-1 break-all text-sm text-ink-muted">Record: {action.recordId}</p>}<pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(action.data, null, 2)}</pre><p className="mt-3 text-sm text-ink-muted">Expires: {new Date(action.expiresAt).toLocaleString()}</p><div className="mt-4 flex gap-3"><Button type="button" size="sm" loading={busy?.id === action.actionId && busy.confirm} disabled={!!busy || streaming} onClick={() => void resolve(action, true)}>Confirm</Button><Button type="button" variant="secondary" size="sm" loading={busy?.id === action.actionId && !busy.confirm} disabled={!!busy || streaming} onClick={() => void resolve(action, false)}>Cancel</Button></div></article>)}
      {error && <div role="alert" className="mt-5 text-vermilion-deep"><p>{error}</p><Button type="button" variant="link" className="mt-2" disabled={streaming || actions.length > 0} onClick={() => void run(lastQuestion)}>Retry</Button></div>}
    </section>
  );
}

