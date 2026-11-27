"use client";

import { Check, Flag, Eraser } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTypingTelemetry } from "@/lib/exam/integrity";
import type { AnswerResponse, AttemptItem, WorkspacePrefs } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import {
  formatMarks,
  isAnswered,
  isSelectedResponse,
  kindHint,
  MULTI_RULE_LABEL,
  pad2,
  wordCount,
  type AnswerEntry,
  type Typing,
} from "./model";

type QuestionProps = {
  item: AttemptItem;
  index: number;
  total: number;
  entry: AnswerEntry | undefined;
  /** Hidden AI canary (5.1). Rendered visually hidden inside the stem, so copy and paste carry it. */
  canary: string | null;
  spacing: WorkspacePrefs["lineSpacing"];
  onAnswer: (response: AnswerResponse, typing?: Typing) => void;
  onToggleFlag: () => void;
  onClear: () => void;
};

export function questionDomId(index: number): string {
  return `ws-q-${index}`;
}

/** One question. Stems are plain text; newlines are kept, and nothing is parsed as HTML. */
export function Question({
  item,
  index,
  total,
  entry,
  canary,
  spacing,
  onAnswer,
  onToggleFlag,
  onClear,
}: QuestionProps) {
  // Bumped on clear, so a written answer's textarea remounts empty.
  const [resets, setResets] = useState(0);
  const response = entry?.response;
  const answered = isAnswered(response);
  const flagged = entry?.flagged ?? false;
  const headingId = `${questionDomId(index)}-heading`;
  const hint = kindHint(item.kind, item.maxWords);
  const relaxed = spacing === "relaxed";

  return (
    <article
      id={questionDomId(index)}
      tabIndex={-1}
      data-question-index={index}
      data-answered={answered ? "true" : "false"}
      aria-labelledby={headingId}
      className="scroll-mt-4 pb-10 outline-none"
    >
      <header className="flex flex-wrap items-baseline gap-x-5 gap-y-2 border-b border-(--ws-line) pb-3">
        <h2 id={headingId} className="font-mono text-[11px] tracking-[0.14em] uppercase">
          Question {pad2(index + 1)} <span className="text-ink-muted">/ {pad2(total)}</span>
        </h2>
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-soft uppercase">
          {formatMarks(item.marks)} {item.marks === 1 ? "mark" : "marks"}
        </p>
        {item.negativeMarks > 0 && (
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-soft uppercase">
            Wrong answer: minus {formatMarks(item.negativeMarks)}
          </p>
        )}
        {item.kind === "multi" && (
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-soft uppercase">
            {MULTI_RULE_LABEL[item.multiRule]}
          </p>
        )}
        {flagged && (
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink uppercase sm:ml-auto">
            <span className="inline-block size-2 bg-vermilion align-middle" aria-hidden /> Flagged for review
          </p>
        )}
      </header>

      <p className="mt-4 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{hint}</p>

      <div
        className={cn(
          "mt-3 font-sans text-lg whitespace-pre-wrap sm:text-xl",
          relaxed ? "leading-loose" : "leading-relaxed",
        )}
      >
        {item.stem}
        {canary !== null && (
          <span aria-hidden="true" className="sr-only">
            {canary}
          </span>
        )}
      </div>

      <div className="mt-6">
        {item.kind === "written" ? (
          <WrittenAnswer
            key={`${item.id}-${resets}`}
            item={item}
            index={index}
            response={response}
            spacing={spacing}
            onAnswer={onAnswer}
          />
        ) : (
          <ChoiceAnswer item={item} index={index} response={response} spacing={spacing} onAnswer={onAnswer} />
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-pressed={flagged}
          onClick={onToggleFlag}
          aria-label={flagged ? `Remove flag from question ${index + 1}` : `Flag question ${index + 1} for review`}
        >
          <Flag className="size-4" aria-hidden />
          {flagged ? "Unflag" : "Flag for review"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!answered}
          onClick={() => {
            setResets((count) => count + 1);
            onClear();
          }}
          aria-label={`Clear answer to question ${index + 1}`}
        >
          <Eraser className="size-4" aria-hidden />
          Clear answer
        </Button>
      </div>
    </article>
  );
}

function ChoiceAnswer({
  item,
  index,
  response,
  spacing,
  onAnswer,
}: {
  item: AttemptItem;
  index: number;
  response: AnswerResponse | undefined;
  spacing: WorkspacePrefs["lineSpacing"];
  onAnswer: (response: AnswerResponse) => void;
}) {
  const selected = response && isSelectedResponse(response) ? response.selected : [];
  const single = item.kind === "single";
  const name = `ws-q-${item.id}`;

  function choose(optionId: string, checked: boolean) {
    if (single) {
      onAnswer({ selected: [optionId] });
      return;
    }
    const next = checked ? [...selected, optionId] : selected.filter((id) => id !== optionId);
    onAnswer({ selected: item.options.filter((option) => next.includes(option.id)).map((option) => option.id) });
  }

  return (
    <fieldset>
      <legend className="sr-only">
        Question {index + 1}: {single ? "choose one option" : "choose all options that apply"}
      </legend>
      <ul className="grid gap-3">
        {item.options.map((option, optionIndex) => {
          const checked = selected.includes(option.id);
          const label = String.fromCharCode(65 + optionIndex);
          return (
            <li key={option.id}>
              <label
                className={cn(
                  "ws-option flex cursor-pointer items-start gap-4 border border-(--ws-line) bg-paper-raised p-4 transition-colors duration-(--duration-fast) hover:border-ink",
                  checked && "border-ink",
                )}
              >
                <input
                  type={single ? "radio" : "checkbox"}
                  name={name}
                  value={option.id}
                  checked={checked}
                  onChange={(event) => choose(option.id, event.target.checked)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 grid size-6 shrink-0 place-items-center border border-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus",
                    checked && "bg-ink text-paper",
                  )}
                >
                  {checked &&
                    (single ? <span className="size-2.5 bg-current" /> : <Check className="size-4" strokeWidth={3} />)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="mr-3 font-mono text-[11px] tracking-[0.12em] text-ink-muted" aria-hidden="true">
                    {label}
                  </span>
                  <span className={cn("font-sans text-base whitespace-pre-wrap", spacing === "relaxed" && "leading-loose")}>
                    {option.text}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

function WrittenAnswer({
  item,
  index,
  response,
  spacing,
  onAnswer,
}: {
  item: AttemptItem;
  index: number;
  response: AnswerResponse | undefined;
  spacing: WorkspacePrefs["lineSpacing"];
  onAnswer: (response: AnswerResponse, typing?: Typing) => void;
}) {
  const text = response && !isSelectedResponse(response) ? response.text : "";
  const words = wordCount(text);
  const max = item.maxWords;
  const over = max !== null && words > max;
  const counterId = `ws-q-${item.id}-count`;

  // Typing telemetry (5.1) counts only, never content. The hook is not a React hook and keeps its own state,
  // so it lives in a ref for this question. Counts are accumulated here: every save carries the running total.
  const telemetry = useRef(useTypingTelemetry()).current;
  const totals = useRef<Typing>({ keystrokes: 0, pastes: 0, pastedChars: 0, activeMs: 0 });
  const [draft, setDraft] = useState(text);

  function accumulate(): Typing {
    const delta = telemetry.snapshot();
    totals.current = {
      keystrokes: totals.current.keystrokes + delta.keystrokes,
      pastes: totals.current.pastes + delta.pastes,
      pastedChars: totals.current.pastedChars + delta.pastedChars,
      activeMs: totals.current.activeMs + delta.activeMs,
    };
    return { ...totals.current };
  }

  return (
    <div>
      <label htmlFor={`ws-q-${item.id}-text`} className="block font-mono text-[11px] tracking-[0.12em] uppercase">
        Your answer <span className="sr-only">to question {index + 1}</span>
      </label>
      <textarea
        id={`ws-q-${item.id}-text`}
        value={draft}
        rows={10}
        aria-describedby={counterId}
        onKeyDown={(event) => telemetry.onKeyDown(event)}
        onPaste={(event) => telemetry.onPaste(event)}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          onAnswer({ text: value }, accumulate());
        }}
        className={cn(
          "mt-2 block min-h-56 w-full resize-y border border-(--ws-line) bg-paper-raised p-4 font-sans text-base text-ink caret-vermilion outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          spacing === "relaxed" ? "leading-loose" : "leading-relaxed",
        )}
      />
      <p id={counterId} className={cn("mt-2 font-mono text-[11px] tracking-[0.12em] uppercase", over ? "text-vermilion-deep" : "text-ink-muted")}>
        {words} {words === 1 ? "word" : "words"}
        {max !== null && ` of ${max}`}
        {over && ` - over the limit by ${words - (max ?? 0)}`}
      </p>
    </div>
  );
}
