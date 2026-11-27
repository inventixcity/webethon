"use client";

import { useId, useState } from "react";
import { api } from "@/lib/api/client";
import type { Announcement } from "@/lib/exam/types";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { formatDateTime, messageOf } from "@/components/analytics/format";
import { describeError } from "@/lib/errors/describe";

export const ANNOUNCEMENT_MAX = 1000;

/** Announcements to every candidate in the exam. Bodies are plain text, never HTML. */
export function AnnouncementsPanel({
  examId,
  announcements,
  onPosted,
}: {
  examId: string;
  announcements: Announcement[];
  onPosted: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const fieldId = useId();
  const errorId = useId();
  const tooLong = body.length > ANNOUNCEMENT_MAX;
  const canPost = body.trim().length > 0 && !tooLong && !busy;

  async function post() {
    if (!canPost) return;
    setBusy(true);
    setError(null);
    try {
      await api<Announcement>(`/exams/${examId}/announcements`, { body: { body: body.trim() } });
      setBody("");
      toast.success("Announcement sent to candidates in this exam.");
      onPosted();
    } catch (cause) {
      setError(messageOf(cause));
      toast.error(describeError(cause, { context: "action" }));
    } finally {
      setBusy(false);
    }
  }

  const newestFirst = [...announcements].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <section aria-labelledby={`${fieldId}-heading`} className="grid content-start gap-5">
      <div>
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Announcements</p>
        <h2 id={`${fieldId}-heading`} className="mt-2 text-2xl font-semibold tracking-tight">
          Message candidates
        </h2>
        <p className="mt-2 text-sm text-ink-soft">Candidates see announcements in their workspace.</p>
      </div>

      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void post();
        }}
      >
        <label htmlFor={fieldId} className="font-mono text-[11px] tracking-[0.12em] uppercase">
          New announcement
        </label>
        <textarea
          id={fieldId}
          rows={3}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          aria-invalid={tooLong || undefined}
          aria-describedby={error || tooLong ? errorId : undefined}
          className="w-full resize-y border border-rule bg-paper-raised p-3 font-sans text-base text-ink placeholder:text-ink-muted"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-ink-muted" aria-live="off">
            {body.length} / {ANNOUNCEMENT_MAX}
          </p>
          <Button type="submit" size="sm" loading={busy} disabled={!canPost}>
            Send announcement
          </Button>
        </div>
        <FieldError id={errorId} message={tooLong ? `Keep announcements to ${ANNOUNCEMENT_MAX} characters.` : error} />
      </form>

      <div>
        <h3 className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Sent</h3>
        {newestFirst.length === 0 ? (
          <p className="mt-3 border border-rule p-4 text-sm text-ink-muted">No announcements yet.</p>
        ) : (
          <ol className="mt-3 divide-y divide-rule border-y border-rule">
            {newestFirst.map((item) => (
              <li key={item.id} className="grid gap-1 py-3">
                <time dateTime={item.createdAt} className="font-mono text-[11px] text-ink-muted">
                  {formatDateTime(item.createdAt)}
                </time>
                <p className="font-sans text-sm whitespace-pre-wrap break-words">{item.body}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
