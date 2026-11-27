"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, Check, RotateCcw, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api/client";
import { describeError } from "@/lib/errors/describe";
import type { Exam, Page, Question, QuestionKind } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { SectionIntro } from "./section-intro";
import { DifficultySquares, KindChip } from "@/components/questions/parts";
import { Meter } from "@/components/ui/meter";
import { notifyExamChanged, parseMarks } from "./format";
import { useExam, useResource } from "./use-resource";
import { EmptyState, ErrorState, LoadingState } from "./states";

const MAX_ITEMS = 200;
const MAX_MARKS = 100000;
const BANK_PAGE = 25;

const KIND_LABEL: Record<QuestionKind, string> = { single: "Single choice", multi: "Multiple choice", written: "Written" };

/** One paper position. `marksText` is what the examiner typed, so partial input such as "2." is kept. */
type PaperRow = {
  question: Question;
  marksText: string;
  /** True when the marks differ from the bank value. Only overrides are sent to the server. */
  overridden: boolean;
};

function rowsFromExam(exam: Exam): PaperRow[] {
  return exam.questions.flatMap((item) => {
    if (item.questionId === null) return [];
    return [
      {
        question: item.question,
        marksText: String(item.marks),
        overridden: item.marks !== item.question.marks,
      },
    ];
  });
}

/** Sums to two decimals using whole hundredths, so float noise never shows up as a mismatch. */
function sumMarks(values: number[]): number {
  return values.reduce((total, value) => total + Math.round(value * 100), 0) / 100;
}

function formatMarks(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

function rowMarks(row: PaperRow): number {
  const parsed = parseMarks(row.marksText);
  return parsed === null ? 0 : parsed;
}

function signature(rows: PaperRow[]): string {
  return JSON.stringify(rows.map((row) => [row.question.id, row.marksText]));
}

/** The Questions tab. Remounts with fresh data whenever the exam version changes. */
export function QuestionsEditor({ examId }: { examId: string }) {
  const { data: exam, loading, error, reload } = useExam(examId);
  if (loading && !exam) return (
    <div className="grid gap-8 py-10" aria-busy="true" aria-label="Loading question bank and paper">
      <SectionIntro eyebrow="Questions / 01" title="Paper" summary="Choose questions from the bank, put them in order and set the marks. The total must match the exam." />
      <div className="grid gap-10 lg:grid-cols-12">
        {["Question bank", "Paper"].map((title, index) => <section key={title} className={cn("grid content-start gap-5", index === 0 ? "lg:col-span-5" : "lg:col-span-7")}><div className="grid gap-2"><h2 className="font-mono text-[11px] tracking-[0.14em] uppercase">0{index + 1} / {title}</h2><div className="h-4 w-4/5 animate-pulse bg-paper-sunk motion-reduce:animate-none" /></div><div className="grid gap-3" aria-hidden="true">{[1, 2, 3].map((row) => <div key={row} className="h-24 animate-pulse border border-rule bg-paper-raised motion-reduce:animate-none" />)}</div></section>)}
      </div>
    </div>
  );
  if (!exam) return <ErrorState error={error} onRetry={reload} />;
  return <PaperEditor key={exam.version} exam={exam} />;
}

function PaperEditor({ exam }: { exam: Exam }) {
  const toast = useToast();
  const editable = exam.status === "draft";
  const [initial] = useState<PaperRow[]>(() => rowsFromExam(exam));
  const [rows, setRows] = useState<PaperRow[]>(initial);
  const [announce, setAnnounce] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [inPaper, setInPaper] = useState<Set<string>>(() => new Set(initial.map((row) => row.question.id)));

  const dirty = signature(rows) !== signature(initial);
  const total = sumMarks(rows.map(rowMarks));
  const difference = sumMarks([total, -exam.totalMarks]);
  const mismatch = difference !== 0;

  function addQuestion(question: Question) {
    if (inPaper.has(question.id) || rows.length >= MAX_ITEMS) return;
    setRows((current) => [...current, { question, marksText: String(question.marks), overridden: false }]);
    setInPaper((current) => new Set(current).add(question.id));
    setSaveError(null);
    setAnnounce(`Added to the paper at position ${rows.length + 1}.`);
  }

  function removeAt(index: number) {
    const removed = rows[index];
    setRows((current) => current.filter((_, position) => position !== index));
    setInPaper((current) => {
      const next = new Set(current);
      next.delete(removed.question.id);
      return next;
    });
    setSaveError(null);
    setAnnounce(`Removed. The paper now has ${rows.length - 1} questions.`);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    setRows((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setAnnounce(`Moved to position ${target + 1}.`);
  }

  function setMarks(index: number, text: string) {
    setRows((current) =>
      current.map((row, position) => {
        if (position !== index) return row;
        const parsed = parseMarks(text);
        return { ...row, marksText: text, overridden: parsed === null || parsed !== row.question.marks };
      }),
    );
    setSaveError(null);
  }

  function resetMarks(index: number) {
    setRows((current) =>
      current.map((row, position) =>
        position === index ? { ...row, marksText: String(row.question.marks), overridden: false } : row,
      ),
    );
  }

  async function save() {
    const badIndex = rows.findIndex((row) => {
      const parsed = parseMarks(row.marksText);
      return parsed === null || parsed > MAX_MARKS;
    });
    if (badIndex >= 0) {
      setSaveError(`Enter marks for question ${badIndex + 1} from 0 to ${MAX_MARKS}, with at most two decimals.`);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await api<Exam>(`/exams/${encodeURIComponent(exam.id)}/questions`, {
        method: "PUT",
        body: {
          items: rows.map((row) =>
            row.overridden ? { questionId: row.question.id, marks: parseMarks(row.marksText) ?? row.question.marks } : { questionId: row.question.id },
          ),
        },
      });
      toast.success("Paper saved.");
      notifyExamChanged(exam.id);
    } catch (cause) {
      // A failed save is a toast. Only the mark validation above stays inline.
      toast.error(
        cause instanceof ApiError && cause.status === 409
          ? "The paper changed while you were editing. Reload to see it."
          : describeError(cause, { context: "action" }),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-10 py-10">
      <p role="status" className="sr-only">
        {announce}
      </p>
      <SectionIntro
        eyebrow="Questions / 01"
        title="Paper"
        summary="Choose questions from the bank, put them in order and set the marks. The total must match the exam."
      />

      {!editable ? (
        <div className="grid max-w-prose gap-2 border-l-2 border-ink pl-5">
          <p className="font-mono text-[11px] tracking-[0.14em] uppercase">Frozen paper</p>
          <p className="text-ink-soft">
            The paper was locked when this exam was published, so questions and marks can no longer change. Duplicate the exam to build a new paper.
          </p>
        </div>
      ) : null}

      <div className="grid gap-10 lg:grid-cols-12">
        {editable ? (
          <section aria-labelledby="bank-heading" className="grid content-start gap-6 lg:col-span-5">
            <div className="grid gap-2 border-b border-ink pb-4"><h2 id="bank-heading" className="font-mono text-[11px] tracking-[0.14em] uppercase">01 / Question bank</h2><p className="text-sm text-ink-soft">Pick questions to add to this exam.</p></div>
            <Bank inPaper={inPaper} disabled={rows.length >= MAX_ITEMS} onAdd={addQuestion} />
          </section>
        ) : null}

        <section aria-labelledby="paper-heading" className={cn("grid content-start gap-6", editable ? "lg:col-span-7" : "lg:col-span-12")}>
          <div className="grid gap-3 border border-ink bg-paper-raised p-4 sm:flex sm:flex-wrap sm:items-end sm:justify-between">
            <div className="grid gap-2"><h2 id="paper-heading" className="font-mono text-[11px] tracking-[0.14em] uppercase">{editable ? "02 / Paper" : "Paper"} <span className="text-ink-muted">({rows.length} questions)</span></h2><p className="max-w-prose text-sm text-ink-soft">The questions candidates will get, in order, with marks.</p></div>
            <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Exam total {formatMarks(exam.totalMarks)} marks</p>
          </div>

          <Meter
            value={Math.min(total, exam.totalMarks)}
            max={Math.max(exam.totalMarks, 1)}
            tone={mismatch ? "caution" : "ink"}
            label="Marks on the paper against the exam total"
            valueText={`${formatMarks(total)} of ${formatMarks(exam.totalMarks)} marks`}
            size="md"
          />

          {mismatch ? (
            <p role="status" className="border-l-2 border-vermilion pl-4 text-sm text-ink">
              {difference > 0
                ? `The paper adds up to ${formatMarks(total)}, but the exam needs ${formatMarks(exam.totalMarks)}. Remove ${formatMarks(difference)} marks.`
                : `The paper adds up to ${formatMarks(total)}, but the exam needs ${formatMarks(exam.totalMarks)}. Add ${formatMarks(-difference)} marks.`}{" "}
              You can still save, but the exam can't be published until they match.
            </p>
          ) : rows.length > 0 ? (
            <p className="text-sm text-ink-soft">The marks match the exam total.</p>
          ) : null}

          {rows.length === 0 ? (
            <EmptyState art="empty-questions" title="No questions on the paper yet.">
              {editable ? "Choose questions from the bank. They are added in the order you pick them." : "This exam has no questions."}
            </EmptyState>
          ) : (
          <ol aria-label="Questions on the paper" className="grid gap-3 pb-32">
              {rows.map((row, index) => (
                <PaperItem
                  key={row.question.id}
                  row={row}
                  index={index}
                  count={rows.length}
                  editable={editable}
                  onMove={(direction) => move(index, direction)}
                  onRemove={() => removeAt(index)}
                  onMarks={(text) => setMarks(index, text)}
                  onReset={() => resetMarks(index)}
                />
              ))}
            </ol>
          )}

          {editable ? (
            <div className="mobile-safe-action sticky bottom-0 z-10 -mx-2 grid gap-4 border border-ink bg-paper-raised px-3 py-4 [padding-bottom:calc(1rem+env(safe-area-inset-bottom))] sm:mx-0 sm:flex sm:items-center sm:justify-between sm:px-4">
              <p className={cn("font-mono text-sm tracking-[0.08em] uppercase tabular-nums", mismatch ? "text-amber-deep" : "text-cobalt-deep")} aria-live="polite">Total {formatMarks(total)} of {formatMarks(exam.totalMarks)} marks</p>
              {saveError ? (
                <p role="alert" className="text-sm text-vermilion-deep">
                  {saveError}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-4">
                <Button loading={saving} disabled={!dirty} onClick={save}>
                  Save paper
                </Button>
                <p role="status" className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
                  {dirty ? "Unsaved changes" : "Saved"}
                </p>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function PaperItem({
  row,
  index,
  count,
  editable,
  onMove,
  onRemove,
  onMarks,
  onReset,
}: {
  row: PaperRow;
  index: number;
  count: number;
  editable: boolean;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onMarks: (text: string) => void;
  onReset: () => void;
}) {
  const position = index + 1;
  const id = useId();
  const parsed = parseMarks(row.marksText);
  const label = `${row.question.stem.slice(0, 60)}${row.question.stem.length > 60 ? "..." : ""}`;

  return (
    <li className="grid gap-4 border border-rule bg-paper-raised p-4 md:grid-cols-[3rem_1fr]">
      <span className="font-mono text-sm tracking-[0.08em] text-ink-muted tabular-nums">{String(position).padStart(2, "0")}</span>
      <div className="grid min-w-0 gap-3">
        <p className="text-base leading-relaxed break-words">{row.question.stem}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
          <span>{row.question.topic}</span>
          <DifficultySquares value={row.question.difficulty} />
          <KindChip kind={row.question.kind} />
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {editable ? (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-marks`}>Marks</Label>
              <div className="flex items-center gap-2">
                <Input variant="box"
                  id={`${id}-marks`}
                  inputMode="decimal"
                  value={row.marksText}
                  onChange={(event) => onMarks(event.target.value)}
                  aria-invalid={parsed === null ? true : undefined}
                  className="h-10 w-24"
                />
                {row.overridden ? (
                  <Button variant="ghost" size="sm" onClick={onReset} aria-label={`Reset marks for question ${position} to ${row.question.marks}`}>
                    <RotateCcw aria-hidden="true" />
                    Reset
                  </Button>
                ) : null}
              </div>
              {row.overridden ? <p className="text-xs text-ink-muted">Bank value {formatMarks(row.question.marks)}</p> : null}
            </div>
          ) : (
            <p className="font-mono text-[11px] tracking-[0.12em] uppercase">{formatMarks(rowMarks(row))} marks</p>
          )}

          {editable ? (
            <div className="ml-auto flex items-center gap-2">
              <Button variant="secondary" size="icon" className="size-10" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move question ${position} up`}>
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button variant="secondary" size="icon" className="size-10" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`Move question ${position} down`}>
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button variant="ghost" size="icon" className="size-10" onClick={onRemove} aria-label={`Remove question ${position}: ${label}`}>
                <X aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** The question bank, filtered. Questions already on the paper show as Added. */
function Bank({ inPaper, disabled, onAdd }: { inPaper: Set<string>; disabled: boolean; onAdd: (question: Question) => void }) {
  const idPrefix = useId();
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [kind, setKind] = useState("");
  const [items, setItems] = useState<Question[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const topics = useResource<Array<{ topic: string; count: number }>>("/questions/topics");

  useEffect(() => {
    const timer = setTimeout(() => setQ(searchText.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ limit: String(BANK_PAGE) });
    if (q) params.set("q", q);
    if (topic) params.set("topic", topic);
    if (difficulty) params.set("difficulty", difficulty);
    if (kind) params.set("kind", kind);
    setLoading(true);
    setError(null);
    api<Page<Question>>(`/questions?${params.toString()}`)
      .then((page) => {
        if (!live) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [q, topic, difficulty, kind, attempt]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: String(BANK_PAGE), cursor });
      if (q) params.set("q", q);
      if (topic) params.set("topic", topic);
      if (difficulty) params.set("difficulty", difficulty);
      if (kind) params.set("kind", kind);
      const page = await api<Page<Question>>(`/questions?${params.toString()}`);
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoadingMore(false);
    }
  }

  const filtersActive = Boolean(q || topic || difficulty || kind);

  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor={`${idPrefix}-q`}>Search</Label>
          <Input variant="box" id={`${idPrefix}-q`} type="search" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search stems" autoComplete="off" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-topic`}>Topic</Label>
          <select id={`${idPrefix}-topic`} value={topic} onChange={(event) => setTopic(event.target.value)} className={selectClass}>
            <option value="">All topics</option>
            {(topics.data ?? []).map((entry) => (
              <option key={entry.topic} value={entry.topic}>
                {entry.topic} ({entry.count})
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-difficulty`}>Difficulty</Label>
          <select id={`${idPrefix}-difficulty`} value={difficulty} onChange={(event) => setDifficulty(event.target.value)} className={selectClass}>
            <option value="">Any</option>
            {[1, 2, 3, 4, 5].map((level) => (
              <option key={level} value={level}>
                D{level}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor={`${idPrefix}-kind`}>Kind</Label>
          <select id={`${idPrefix}-kind`} value={kind} onChange={(event) => setKind(event.target.value)} className={selectClass}>
            <option value="">Any kind</option>
            {(Object.keys(KIND_LABEL) as QuestionKind[]).map((value) => (
              <option key={value} value={value}>
                {KIND_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div aria-live="polite" className="sr-only">
        {loading ? "Loading questions" : `${items.length} questions shown`}
      </div>

      {loading ? <LoadingState label="Loading questions" rows={3} /> : null}

      {!loading && error ? <ErrorState error={error} onRetry={() => setAttempt((value) => value + 1)} /> : null}

      {!loading && !error && items.length === 0 ? (
        <EmptyState art="empty-questions" title={filtersActive ? "No questions match these filters." : "The question bank is empty."}>
          {filtersActive ? "Clear a filter to see more." : "Create questions in the question bank first, then come back to build the paper."}
        </EmptyState>
      ) : null}

      {!loading && !error && items.length > 0 ? (
        <ul aria-label="Matching questions" className="grid">
          {items.map((question) => {
            const added = inPaper.has(question.id);
            return (
              <li key={question.id} className="grid gap-3 border border-rule bg-paper-raised p-4">
                <p className="text-sm leading-relaxed break-words">{question.stem}</p>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
                    <span>{question.topic}</span>
                    <DifficultySquares value={question.difficulty} />
                    <KindChip kind={question.kind} />
                    <FacilityMini value={question.observedFacility} />
                    <span className="tabular-nums">{formatMarks(question.marks)} marks</span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={added || disabled}
                    onClick={() => onAdd(question)}
                    aria-label={added ? `Already on the paper: ${question.stem.slice(0, 40)}` : `Add to paper: ${question.stem.slice(0, 40)}`}
                  >
                    {added ? <><Check aria-hidden="true" /> Added</> : "Add"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {!loading && !error && cursor ? (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" loading={loadingMore} onClick={loadMore}>
            Load more
          </Button>
        </div>
      ) : null}

      <p className="text-sm text-ink-muted">
        Need a new question?{" "}
        <Link href="/app/examiner/questions" className="underline underline-offset-4 hover:text-ink">
          Open the question bank
        </Link>
      </p>
    </div>
  );
}

/** Observed facility from real attempts, as a short square bar. Shows "no data" until there are enough attempts. */
function FacilityMini({ value }: { value: number | null }) {
  if (value === null) return <span className="normal-case tracking-normal text-ink-muted">No data yet</span>;
  const pct = Math.min(100, Math.max(0, value * 100));
  return (
    <span className="inline-flex items-center gap-2 tabular-nums" title="Observed facility from real attempts">
      <span aria-hidden="true" className="relative block h-1.5 w-12 bg-paper-sunk">
        <span className="absolute inset-0 origin-left bg-cobalt transition-transform duration-(--duration-slow) ease-(--ease-enter)" style={{ transform: `scaleX(${pct / 100})` }} />
      </span>
      <span>{Math.round(pct)}% facility</span>
    </span>
  );
}

const selectClass =
  "h-12 w-full border-0 border-b border-current/30 bg-paper-raised px-2 font-sans text-base text-current outline-none transition-colors duration-300 hover:border-current/60 focus-visible:border-current focus-visible:outline-2 focus-visible:outline-vermilion disabled:opacity-50";
