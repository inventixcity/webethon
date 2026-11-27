"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { describeError } from "@/lib/errors/describe";
import type { Blueprint, Exam } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { SectionIntro } from "./section-intro";
import {
  isNotFound,
  toDraft,
  toPayload,
  toleranceLabel,
  validateDraft,
  type DraftBlueprint,
} from "./blueprint-model";
import { BlueprintRows } from "./blueprint-rows";
import { BlueprintPreviewPanel } from "./blueprint-preview";
import { notifyExamChanged } from "./format";
import { useExam, useResource } from "./use-resource";
import { ErrorState, LoadingState } from "./states";

/**
 * The fair-papers section of the Questions tab. A draft exam edits its blueprint and saves it with
 * PUT /exams/{id}/blueprint. A published exam shows it read-only. A 404 means the feature is off here.
 */
export function BlueprintEditor({ examId }: { examId: string }) {
  const exam = useExam(examId);
  const blueprint = useResource<Blueprint>(`/exams/${encodeURIComponent(examId)}/blueprint`);
  const toast = useToast();
  const [savedSeq, setSavedSeq] = useState(0);

  const blueprintError = blueprint.error;
  const blueprintOff = isNotFound(blueprintError);
  const { reload: reloadBlueprint } = blueprint;

  useEffect(() => {
    if (blueprintError && !blueprintOff) {
      toast.error(describeError(blueprintError), { action: { label: "Try again", onClick: reloadBlueprint } });
    }
  }, [blueprintError, blueprintOff, reloadBlueprint, toast]);

  const intro = (
    <SectionIntro
      eyebrow="Questions / 03"
      title="Fair papers (optional)"
      summary="Each candidate gets a different paper drawn from the same blueprint. Every paper is set to the same difficulty, so no one is handed an easier set."
    />
  );

  if (blueprintOff) {
    return (
      <div className="grid gap-10 border-t border-rule px-4 py-10 md:px-8">
        {intro}
        <p className="max-w-prose border-l-2 border-rule py-1 pl-4 text-sm text-ink-soft">Fair papers are off for this exam.</p>
      </div>
    );
  }

  if (exam.loading && !exam.data) return <LoadingState label="Loading fair papers" rows={2} className="px-4 md:px-8" />;
  if (!exam.data) return <ErrorState error={exam.error} onRetry={exam.reload} />;
  if (!blueprint.data) {
    if (blueprint.loading) return <LoadingState label="Loading fair papers" rows={2} className="px-4 md:px-8" />;
    return (
      <div className="grid gap-10 border-t border-rule px-4 py-10 md:px-8">
        {intro}
        <div className="grid max-w-prose justify-items-start gap-4 border-l-2 border-vermilion-deep pl-5">
          <p className="text-sm text-ink-soft">The blueprint could not be loaded.</p>
          <Button variant="secondary" size="sm" onClick={blueprint.reload}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-10 border-t border-rule px-4 py-10 md:px-8">
      {intro}
      {exam.data.status === "draft" ? (
        <BlueprintForm
          key={JSON.stringify(blueprint.data)}
          exam={exam.data}
          server={blueprint.data}
          onSaved={() => {
            blueprint.reload();
            setSavedSeq((value) => value + 1);
            notifyExamChanged(examId);
          }}
          previewKey={savedSeq}
          examId={examId}
        />
      ) : (
        <BlueprintReadOnly blueprint={blueprint.data} />
      )}
    </div>
  );
}

/** The topics on the exam's paper, once each, in alphabetical order. These are the only topics a row may use. */
function paperTopics(exam: Exam): string[] {
  const topics = new Set<string>();
  for (const item of exam.questions) {
    if (item.questionId !== null) topics.add(item.question.topic);
  }
  return [...topics].sort((a, b) => a.localeCompare(b));
}

function signature(blueprint: Blueprint): string {
  return JSON.stringify(toPayload(toDraft(blueprint)));
}

function BlueprintForm({
  examId,
  exam,
  server,
  onSaved,
  previewKey,
}: {
  examId: string;
  exam: Exam;
  server: Blueprint;
  onSaved: () => void;
  previewKey: number;
}) {
  const toast = useToast();
  const baseId = useId();
  const toggleLabelId = `${baseId}-toggle`;
  const [draft, setDraft] = useState<DraftBlueprint>(() => toDraft(server));
  const [saving, setSaving] = useState(false);

  const topics = useMemo(() => paperTopics(exam), [exam]);
  const validation = useMemo(() => validateDraft(draft, topics, exam.totalMarks), [draft, topics, exam.totalMarks]);
  const dirty = JSON.stringify(toPayload(draft)) !== signature(server) || draft.enabled !== server.enabled;

  async function save() {
    if (!validation.canSave || !dirty || saving) return;
    setSaving(true);
    try {
      await api<Blueprint>(`/exams/${encodeURIComponent(examId)}/blueprint`, { method: "PUT", body: toPayload(draft) });
      toast.success("Fair papers saved");
      onSaved();
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="grid gap-10"
    >
      <div className="grid gap-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="grid max-w-prose gap-2">
            <p id={toggleLabelId} className="text-base font-medium">
              Draw a fair paper for each candidate
            </p>
            <p className="text-sm text-ink-soft">Each candidate gets different questions of equal difficulty.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={draft.enabled}
            aria-labelledby={toggleLabelId}
            onClick={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))}
            className={cn(
              "relative h-7 w-12 shrink-0 cursor-pointer border border-ink transition-colors duration-(--duration-base) ease-(--ease-enter) outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
              draft.enabled ? "bg-fill" : "bg-paper-raised",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-1 left-1 size-4 transition-transform duration-(--duration-base) ease-(--ease-enter) motion-reduce:transition-none",
                draft.enabled ? "translate-x-5 bg-on-fill" : "bg-ink",
              )}
            />
          </button>
        </div>

        {draft.enabled ? (
          <BlueprintRows
            rows={draft.rows}
            topics={topics}
            rowIssues={validation.rowIssues}
            tolerance={draft.tolerance}
            examTotal={exam.totalMarks}
            blueprintTotal={validation.blueprintTotal}
            totalDifference={validation.totalDifference}
            onRowsChange={(rows) => setDraft((current) => ({ ...current, rows }))}
            onToleranceChange={(tolerance) => setDraft((current) => ({ ...current, tolerance }))}
          />
        ) : (
          <p className="max-w-prose border-l-2 border-rule py-1 pl-4 text-sm text-ink-soft">
            Fair papers are off. Every candidate gets the same paper, as before. Turn this on to set rows and a tolerance of{" "}
            {toleranceLabel(draft.tolerance)}.
          </p>
        )}

        {validation.problems.length > 0 ? (
          <ul role="alert" className="grid gap-1 border-l-2 border-vermilion-deep pl-4 text-sm text-ink">
            {validation.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-ink pt-6">
        <Button type="submit" loading={saving} disabled={!dirty || !validation.canSave}>
          Save fair papers
        </Button>
        <p role="status" className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
          {dirty ? "Unsaved changes" : "Saved"}
        </p>
      </div>

      {draft.enabled && !dirty ? (
        <BlueprintPreviewPanel examId={examId} refreshKey={previewKey} tolerance={server.tolerance} />
      ) : null}
    </form>
  );
}

/** A published exam's blueprint. It is frozen with the paper, so this only shows what was drawn from. */
function BlueprintReadOnly({ blueprint }: { blueprint: Blueprint }) {
  return (
    <div className="grid gap-8">
      <div className="grid max-w-prose gap-2 border-l-2 border-ink pl-5">
        <p className="font-mono text-[11px] tracking-[0.14em] uppercase">Fair papers {blueprint.enabled ? "on" : "off"}</p>
        <p className="text-ink-soft">
          {blueprint.enabled
            ? `Each candidate's paper was drawn from this blueprint with a tolerance of ${toleranceLabel(blueprint.tolerance)}. It is locked now the exam is published.`
            : "Fair papers were off when this exam was published, so every candidate got the same paper."}
        </p>
      </div>

      {blueprint.enabled && blueprint.rows.length > 0 ? (
        <div className="overflow-x-auto border border-rule">
          <table className="w-full min-w-[480px] text-left text-sm">
            <caption className="sr-only">Blueprint rows, read only</caption>
            <thead className="bg-paper-sunk">
              <tr className="font-mono text-[11px] tracking-[0.12em] uppercase">
                <th scope="col" className="px-3 py-3 font-medium">Topic</th>
                <th scope="col" className="px-3 py-3 font-medium">Difficulty</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">Count</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">Marks each</th>
              </tr>
            </thead>
            <tbody>
              {blueprint.rows.map((row, index) => (
                <tr key={index} className="border-t border-rule">
                  <th scope="row" className="px-3 py-3 font-normal">{row.topic}</th>
                  <td className="px-3 py-3 font-mono tabular-nums">
                    {row.minDifficulty} to {row.maxDifficulty}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">{row.count}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">{row.marksEach}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
