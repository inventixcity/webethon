"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Art, hasArt } from "@/components/ui/art";
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
      title={exam.title}
      breadcrumb={[{ label: "Exams", href: "/app/examiner/exams" }, { label: STATUS_LABEL[exam.status] }]}
      actions={
        <div className="grid justify-items-end gap-4">
          {hasArt("bg-examiner") ? (
            <Art
              name="bg-examiner"
              alt=""
              sizes="240px"
              className="hidden aspect-[4/3] w-60 border border-rule bg-paper-sunk [filter:brightness(0.82)_contrast(1.05)] sm:block"
            />
          ) : null}
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
      <ExamTabs examId={examId} />
    </PageHeader>
  );
}
