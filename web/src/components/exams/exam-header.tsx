"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { hasArt } from "@/components/ui/art";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
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
          <div className="pb-6">
            <BrailleSpinner label="Loading exam" className="text-ink" />
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
    <PageHeader
      index="03"
      eyebrow="Exam"
      title={<span title={exam.title} className="line-clamp-3 min-w-0 [overflow-wrap:anywhere]">{exam.title}</span>}
      breadcrumb={[{ label: "Exams", href: "/app/examiner/exams" }, { label: STATUS_LABEL[exam.status] }]}
      banner={hasArt("bg-examiner") ? "bg-examiner" : undefined}
      bannerCaption="FIG. 03 / EXAM"
      actions={
        <div className="grid min-w-0 gap-4">
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" size="sm" loading={busy === "preview"} disabled={busy !== null && busy !== "preview"} onClick={preview}>
              Preview as candidate
            </Button>
            <Button variant="secondary" size="sm" loading={busy === "duplicate"} disabled={busy !== null && busy !== "duplicate"} onClick={duplicate}>
              Duplicate
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid min-w-0 gap-5">
        <dl className="grid min-w-0 gap-px border border-ink bg-rule p-px sm:grid-cols-3">
          <div className="grid min-w-0 content-start gap-2 bg-paper-raised p-3 sm:p-4">
            <dt className="font-mono text-[11px] font-bold tracking-[0.12em] text-ink uppercase">Status</dt>
            <dd><PhaseChip phase={exam.phase} /></dd>
          </div>
          <div className="grid min-w-0 content-start gap-2 bg-paper-raised p-3 sm:p-4">
            <dt className="font-mono text-[11px] font-bold tracking-[0.12em] text-ink uppercase">Window</dt>
            <dd className="break-words text-sm font-medium text-ink">{formatWindow(exam.startsAt, exam.endsAt)}</dd>
          </div>
          <div className="grid min-w-0 content-start gap-2 bg-paper-raised p-3 sm:p-4">
            <dt className="font-mono text-[11px] font-bold tracking-[0.12em] text-ink uppercase">Duration</dt>
            <dd className="text-sm font-medium text-ink">{exam.durationMinutes} min</dd>
          </div>
        </dl>
        <div className="min-w-0 border-b border-ink pb-5">
          <ExamTabs examId={examId} />
        </div>
      </div>
    </PageHeader>
  );
}
