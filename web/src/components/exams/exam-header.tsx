"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/feedback/toaster";
import { messageFor } from "@/lib/errors/describe";
import { STATUS_LABEL, formatWindow, notifyExamChanged } from "./format";
import { createSandboxAttempt, duplicateExam } from "./actions";
import { PhaseChip } from "./phase-chip";
import { ExamTabs } from "./exam-tabs";
import { useExam } from "./use-resource";
import { ErrorState } from "./states";

/** Title, phase, window, the two exam-wide actions, and the tab bar. Shared by every exam page. */
export function ExamHeader({ examId }: { examId: string }) {
  const { data: exam, loading, error, reload } = useExam(examId);
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<"preview" | "duplicate" | null>(null);

  async function preview() {
    setBusy("preview");
    try {
      const attemptId = await createSandboxAttempt(examId);
      router.push(`/exam/${attemptId}`);
    } catch (cause) {
      toast.error(messageFor(cause));
      setBusy(null);
    }
  }

  async function duplicate() {
    setBusy("duplicate");
    try {
      const copy = await duplicateExam(examId);
      toast.success("Copied as a new draft. Its window starts tomorrow.");
      notifyExamChanged(examId);
      router.push(`/app/examiner/exams/${encodeURIComponent(copy.id)}`);
    } catch (cause) {
      toast.error(messageFor(cause));
      setBusy(null);
    }
  }

  if (!exam) {
    return (
      <header className="grid gap-6 border-b border-ink pb-0">
        {loading ? (
          <div role="status" className="grid gap-3 pb-6">
            <span className="sr-only">Loading exam</span>
            <div className="h-10 w-2/3 animate-pulse bg-paper-sunk motion-reduce:animate-none" aria-hidden="true" />
            <div className="h-5 w-1/3 animate-pulse bg-paper-sunk motion-reduce:animate-none" aria-hidden="true" />
          </div>
        ) : (
          <div className="pb-6">
            <ErrorState error={error} onRetry={reload} />
          </div>
        )}
      </header>
    );
  }

  return (
    <header className="grid gap-6 border-b border-ink">
      <nav aria-label="Breadcrumb" className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
        <Link href="/app/examiner/exams" className="underline-offset-4 hover:text-ink hover:underline">
          Exams
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-ink-soft">{STATUS_LABEL[exam.status]}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="grid min-w-0 flex-1 gap-4">
          <h1 className="text-[clamp(2rem,5vw,3.5rem)] leading-[0.95] font-medium tracking-[-0.03em] break-words">
            {exam.title}
          </h1>
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-3 font-mono text-[11px] tracking-[0.12em] uppercase">
            <div className="flex items-center gap-2">
              <dt className="sr-only">Phase</dt>
              <dd>
                <PhaseChip phase={exam.phase} />
              </dd>
            </div>
            <div className="grid gap-1 normal-case tracking-normal">
              <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Window</dt>
              <dd className="font-sans text-sm text-ink-soft">{formatWindow(exam.startsAt, exam.endsAt)}</dd>
            </div>
            <div className="grid gap-1 normal-case tracking-normal">
              <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Duration</dt>
              <dd className="font-sans text-sm text-ink-soft">{exam.durationMinutes} min</dd>
            </div>
          </dl>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" size="sm" loading={busy === "preview"} disabled={busy !== null && busy !== "preview"} onClick={preview}>
            Preview as candidate
          </Button>
          <Button variant="secondary" size="sm" loading={busy === "duplicate"} disabled={busy !== null && busy !== "duplicate"} onClick={duplicate}>
            Duplicate
          </Button>
        </div>
      </div>

      <ExamTabs examId={examId} />
    </header>
  );
}
