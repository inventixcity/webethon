"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, Plus, X } from "lucide-react";
import { ApiError, api } from "@/lib/api/client";
import { describeError } from "@/lib/errors";
import type { Question, QuestionKind, MultiRule } from "@/lib/exam/types";
import { useToast } from "@/components/feedback/toaster";
import { FieldError } from "@/components/feedback/field-error";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { PageLoader } from "@/components/loaders/page-loader";
import {
  KIND_LABEL,
  KINDS,
  LIMITS,
  MAX_OPTIONS,
  MIN_OPTIONS,
  MULTI_RULES,
  draftFromQuestion,
  draftToInput,
  emptyDraft,
  fieldForServerPath,
  nextOptionId,
  validateDraft,
  type DraftOption,
  type DraftState,
  type FieldErrors,
} from "./model";
import { QuestionPreview } from "./question-preview";
import { MonoLabel, boxInputClass, selectClass, textareaClass } from "./parts";

type ServerDetail = { path: string; message: string };

/** Turns the server's `details` array into field messages. Anything unmatched goes to the banner. */
function readServerDetails(details: unknown): { fields: FieldErrors; banner: string[] } {
  const fields: FieldErrors = {};
  const banner: string[] = [];
  if (!Array.isArray(details)) return { fields, banner };
  for (const item of details as ServerDetail[]) {
    if (typeof item !== "object" || item === null || typeof item.message !== "string") continue;
    const field = typeof item.path === "string" ? fieldForServerPath(item.path) : null;
    if (field) fields[field] = item.message;
    else banner.push(item.message);
  }
  return { fields, banner };
}

/** Create (no id) or edit (with id) a question. Live validation mirrors the server; the server stays the authority. */
export function QuestionEditor({ questionId }: { questionId?: string }) {
  const router = useRouter();
  const toast = useToast();
  const editing = questionId !== undefined;

  const [loading, setLoading] = useState(editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [version, setVersion] = useState<number | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [banner, setBanner] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [topics, setTopics] = useState<string[]>([]);

  // Load the existing question, and again after a conflict when the examiner asks to reload.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!editing) return;
    let active = true;
    setLoading(true);
    setLoadError(null);
    api<Question>(`/questions/${questionId}`)
      .then((question) => {
        if (!active) return;
        setDraft(draftFromQuestion(question));
        setVersion(question.version);
        setTouched({});
        setSubmitted(false);
        setServerErrors({});
        setBanner([]);
        setConflict(false);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(describeError(error, { context: "page" }).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [editing, questionId, reloadKey]);

  useEffect(() => {
    let active = true;
    api<Array<{ topic: string }>>("/questions/topics")
      .then((list) => {
        if (active) setTopics(list.map((item) => item.topic));
      })
      .catch(() => {
        if (active) setTopics([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const clientErrors = validateDraft(draft);
  const isWritten = draft.kind === "written";

  function patch(changes: Partial<DraftState>, touchedKeys: string[] = []) {
    setDraft((current) => ({ ...current, ...changes }));
    setServerErrors({});
    setBanner([]);
    if (touchedKeys.length > 0) {
      setTouched((current) => {
        const next = { ...current };
        for (const key of touchedKeys) next[key] = true;
        return next;
      });
    }
  }

  /** An error shows once its field has been touched, or after the first save attempt. */
  function errorFor(field: string): string | undefined {
    if (serverErrors[field]) return serverErrors[field];
    if (submitted || touched[field]) return clientErrors[field];
    return undefined;
  }

  function setKind(kind: QuestionKind) {
    const keepCorrect = kind === "single" ? draft.correct.slice(0, 1) : draft.correct;
    patch({ kind, correct: kind === "written" ? [] : keepCorrect }, ["kind", "correct"]);
  }

  function toggleCorrect(id: string, checked: boolean) {
    if (draft.kind === "single") {
      patch({ correct: [id] }, ["correct"]);
      return;
    }
    const next = checked ? [...draft.correct.filter((x) => x !== id), id] : draft.correct.filter((x) => x !== id);
    patch({ correct: next }, ["correct"]);
  }

  function addOption() {
    const id = nextOptionId(draft.options);
    if (!id || draft.options.length >= MAX_OPTIONS) return;
    patch({ options: [...draft.options, { id, text: "" }] });
  }

  function removeOption(id: string) {
    if (draft.options.length <= MIN_OPTIONS) return;
    patch({
      options: draft.options.filter((option) => option.id !== id),
      correct: draft.correct.filter((x) => x !== id),
    }, ["correct"]);
  }

  function updateOption(index: number, text: string) {
    const options: DraftOption[] = draft.options.map((option, i) => (i === index ? { ...option, text } : option));
    patch({ options }, [`options.${index}.text`]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setBanner([]);
    setConflict(false);

    const problems = validateDraft(draft);
    if (Object.keys(problems).length > 0) {
      setBanner(["Fix the highlighted fields before saving."]);
      const first = document.querySelector<HTMLElement>('[aria-invalid="true"]');
      first?.focus();
      return;
    }

    const input = draftToInput(draft);
    setSaving(true);
    try {
      if (editing && version !== null) {
        const saved = await api<Question>(`/questions/${questionId}`, {
          method: "PATCH",
          body: input,
          headers: { "If-Match": String(version) },
        });
        setVersion(saved.version);
        setDraft(draftFromQuestion(saved));
        setSubmitted(false);
        setTouched({});
        toast.success("Question saved.");
      } else {
        const created = await api<Question>("/questions", { method: "POST", body: input });
        toast.success("Question created.");
        router.replace(`/app/examiner/questions/${created.id}`);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        setBanner(["This question changed elsewhere. Reload it to see the latest version."]);
      } else if (error instanceof ApiError && error.code === "VALIDATION_FAILED") {
        const { fields, banner: rest } = readServerDetails(error.details);
        setServerErrors(fields);
        setBanner(rest.length > 0 ? rest : ["The server did not accept some values. Check the highlighted fields."]);
      } else {
        toast.error(describeError(error, { context: "action" }));
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <PageLoader label={editing ? "Loading question" : "Loading"} />;

  if (loadError) {
    return (
      <main className="mx-auto grid w-full max-w-3xl gap-6 px-5 py-16 md:px-8">
        <BackLink />
        <div role="alert" className="grid gap-4 border border-vermilion-deep p-6">
          <p className="text-2xl font-medium tracking-[-0.02em]">This question didn&apos;t load.</p>
          <p className="font-sans text-ink-soft">{loadError}</p>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setReloadKey((key) => key + 1)}>
              Try again
            </Button>
            <Button asChild variant="link">
              <Link href="/app/examiner/questions">Back to the bank</Link>
            </Button>
          </div>
        </div>
      </main>
    );
  }

  const hasObjectiveOptions = !isWritten;

  return (
    <main className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-10 md:px-8 md:py-16">
      <header className="grid gap-5">
        <BackLink />
        <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          <span aria-hidden className="size-1.5 bg-vermilion" />
          02 / {editing ? "Edit question" : "New question"}
        </p>
        <h1 className="text-[clamp(2.25rem,5vw,4rem)] leading-[1.02] font-medium tracking-[-0.035em]">
          {editing ? "Edit question." : "New question."}
        </h1>
      </header>

      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:gap-16">
        <form noValidate onSubmit={save} aria-labelledby="editor-heading" className="grid min-w-0 gap-10">
          <h2 id="editor-heading" className="sr-only">
            Question fields
          </h2>

          {banner.length > 0 && (
            <div role="alert" className="grid gap-3 border border-vermilion-deep bg-paper-raised p-4">
              {banner.map((message) => (
                <p key={message} className="font-sans text-sm text-ink">
                  {message}
                </p>
              ))}
              {conflict && (
                <div>
                  <Button variant="secondary" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
                    Reload question
                  </Button>
                  <p className="mt-2 font-sans text-sm text-ink-muted">Reloading discards your unsaved changes.</p>
                </div>
              )}
            </div>
          )}

          <Section index="01" title="Placement">
            <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]">
              <Field
                id="q-topic"
                label="Topic"
                error={errorFor("topic")}
                hint="Up to 80 characters. Used to group questions and balance exams."
              >
                <input
                  id="q-topic"
                  list="q-topic-suggestions"
                  className={boxInputClass}
                  value={draft.topic}
                  maxLength={LIMITS.topicMax + 20}
                  onChange={(event) => patch({ topic: event.target.value }, ["topic"])}
                  aria-invalid={Boolean(errorFor("topic")) || undefined}
                  aria-describedby={describedBy("q-topic", errorFor("topic"), true)}
                />
                <datalist id="q-topic-suggestions">
                  {topics.map((topic) => (
                    <option key={topic} value={topic} />
                  ))}
                </datalist>
              </Field>
              <Field id="q-difficulty" label="Difficulty" error={errorFor("difficulty")}>
                <select
                  id="q-difficulty"
                  className={selectClass}
                  value={draft.difficulty}
                  onChange={(event) => patch({ difficulty: event.target.value }, ["difficulty"])}
                  aria-invalid={Boolean(errorFor("difficulty")) || undefined}
                  aria-describedby={describedBy("q-difficulty", errorFor("difficulty"))}
                >
                  {[1, 2, 3, 4, 5].map((level) => (
                    <option key={level} value={String(level)}>
                      {level} of 5
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <fieldset className="grid gap-3">
              <legend className="mb-3 font-mono text-[11px] tracking-[0.14em] uppercase">Kind</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {KINDS.map((kind) => (
                  <label
                    key={kind}
                    className="flex h-12 cursor-pointer items-center justify-center gap-2 border border-ink bg-paper-raised font-mono text-[11px] tracking-[0.12em] uppercase transition-colors duration-(--duration-fast) has-checked:bg-ink has-checked:text-paper has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-vermilion"
                  >
                    <input
                      type="radio"
                      name="q-kind"
                      value={kind}
                      checked={draft.kind === kind}
                      onChange={() => setKind(kind)}
                      className="sr-only"
                    />
                    {KIND_LABEL[kind]}
                  </label>
                ))}
              </div>
              <p className="font-sans text-sm text-ink-muted">
                {draft.kind === "single" && "One correct option. The candidate chooses one answer."}
                {draft.kind === "multi" && "One or more correct options. The candidate may choose several."}
                {draft.kind === "written" && "The candidate writes a short answer. An examiner marks it against the rubric."}
              </p>
            </fieldset>
          </Section>

          <Section index="02" title="Question">
            <Field
              id="q-stem"
              label="Question text"
              error={errorFor("stem")}
              count={`${draft.stem.length} / ${LIMITS.stemMax}`}
            >
              <textarea
                id="q-stem"
                rows={5}
                className={textareaClass}
                value={draft.stem}
                onChange={(event) => patch({ stem: event.target.value }, ["stem"])}
                aria-invalid={Boolean(errorFor("stem")) || undefined}
                aria-describedby={describedBy("q-stem", errorFor("stem"))}
              />
            </Field>

            {hasObjectiveOptions && (
              <fieldset className="grid gap-4">
                <legend className="mb-3 font-mono text-[11px] tracking-[0.14em] uppercase">
                  Options and answer key
                </legend>
                <p className="font-sans text-sm text-ink-muted">
                  {draft.kind === "single"
                    ? "Select the one correct option."
                    : "Tick every correct option. Options are labelled A to J as they are added."}
                </p>
                {errorFor("options") && <FieldError id="q-options-error" message={errorFor("options")} />}
                {errorFor("correct") && <FieldError id="q-correct-error" message={errorFor("correct")} />}

                <ul className="grid gap-3">
                  {draft.options.map((option, index) => {
                    const textError = errorFor(`options.${index}.text`);
                    const checked = draft.correct.includes(option.id);
                    const letter = option.id.toUpperCase();
                    return (
                      <li key={option.id} className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-start gap-3">
                        <div className="flex h-12 items-center">
                          {draft.kind === "single" ? (
                            <input
                              type="radio"
                              name="q-correct"
                              aria-label={`Option ${letter} is correct`}
                              checked={checked}
                              onChange={() => toggleCorrect(option.id, true)}
                              className="size-5 cursor-pointer accent-vermilion-deep"
                            />
                          ) : (
                            <Checkbox
                              aria-label={`Option ${letter} is correct`}
                              checked={checked}
                              onCheckedChange={(value) => toggleCorrect(option.id, value === true)}
                            />
                          )}
                        </div>
                        <span className="flex h-12 w-8 items-center font-mono text-sm text-ink-muted" aria-hidden>
                          {letter}
                        </span>
                        <div className="min-w-0">
                          <label htmlFor={`q-option-${index}`} className="sr-only">
                            Option {letter} text
                          </label>
                          <input
                            id={`q-option-${index}`}
                            className={boxInputClass}
                            value={option.text}
                            maxLength={LIMITS.optionTextMax + 50}
                            placeholder={`Option ${letter}`}
                            onChange={(event) => updateOption(index, event.target.value)}
                            aria-invalid={Boolean(textError) || undefined}
                            aria-describedby={describedBy(`q-option-${index}`, textError)}
                          />
                          <FieldError id={`q-option-${index}-error`} message={textError} />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove option ${letter}`}
                          disabled={draft.options.length <= MIN_OPTIONS}
                          onClick={() => removeOption(option.id)}
                          className="h-12"
                        >
                          <X aria-hidden />
                          <span className="sr-only sm:not-sr-only">Remove</span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>

                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={draft.options.length >= MAX_OPTIONS}
                    onClick={addOption}
                  >
                    <Plus aria-hidden />
                    Add option
                  </Button>
                  <span className="ml-3 font-mono text-[11px] text-ink-muted uppercase">
                    {draft.options.length} of {MAX_OPTIONS}
                  </span>
                </div>
              </fieldset>
            )}

            {isWritten && (
              <div className="grid gap-6">
                <Field
                  id="q-rubric"
                  label="Marking rubric"
                  error={errorFor("rubric")}
                  hint="Guidance for the examiner who marks this answer. Candidates never see it."
                  count={`${draft.rubric.length} / ${LIMITS.rubricMax}`}
                >
                  <textarea
                    id="q-rubric"
                    rows={5}
                    className={textareaClass}
                    value={draft.rubric}
                    onChange={(event) => patch({ rubric: event.target.value }, ["rubric"])}
                    aria-invalid={Boolean(errorFor("rubric")) || undefined}
                    aria-describedby={describedBy("q-rubric", errorFor("rubric"), true)}
                  />
                </Field>
                <Field
                  id="q-maxwords"
                  label="Word limit"
                  error={errorFor("maxWords")}
                  hint="Optional. Leave empty for no limit."
                >
                  <input
                    id="q-maxwords"
                    type="text"
                    inputMode="numeric"
                    className={cn(boxInputClass, "sm:max-w-48")}
                    value={draft.maxWords}
                    onChange={(event) => patch({ maxWords: event.target.value }, ["maxWords"])}
                    aria-invalid={Boolean(errorFor("maxWords")) || undefined}
                    aria-describedby={describedBy("q-maxwords", errorFor("maxWords"), true)}
                  />
                </Field>
              </div>
            )}
          </Section>

          <Section index="03" title="Scoring">
            <div className="grid gap-6 sm:grid-cols-2">
              <Field id="q-marks" label="Marks" error={errorFor("marks")} hint="Steps of 0.25, up to 1000.">
                <input
                  id="q-marks"
                  type="number"
                  inputMode="decimal"
                  min={0.25}
                  max={LIMITS.marksMax}
                  step={0.25}
                  className={boxInputClass}
                  value={draft.marks}
                  onChange={(event) => patch({ marks: event.target.value }, ["marks", "negativeMarks"])}
                  aria-invalid={Boolean(errorFor("marks")) || undefined}
                  aria-describedby={describedBy("q-marks", errorFor("marks"), true)}
                />
              </Field>
              <Field
                id="q-negative"
                label="Negative marks"
                error={errorFor("negativeMarks")}
                hint="Taken off for a wrong answer. 0 means no penalty. Cannot exceed the marks."
              >
                <input
                  id="q-negative"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.25}
                  className={boxInputClass}
                  value={draft.negativeMarks}
                  onChange={(event) => patch({ negativeMarks: event.target.value }, ["negativeMarks"])}
                  aria-invalid={Boolean(errorFor("negativeMarks")) || undefined}
                  aria-describedby={describedBy("q-negative", errorFor("negativeMarks"), true)}
                />
              </Field>
            </div>

            {draft.kind === "multi" && (
              <fieldset className="grid gap-3">
                <legend className="mb-3 font-mono text-[11px] tracking-[0.14em] uppercase">How multiple answers score</legend>
                <div className="grid gap-2">
                  {MULTI_RULES.map((rule) => (
                    <label
                      key={rule.value}
                      className="grid cursor-pointer gap-1 border border-ink bg-paper-raised p-4 has-checked:bg-paper-sunk has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-vermilion"
                    >
                      <span className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="q-multirule"
                          value={rule.value}
                          checked={draft.multiRule === rule.value}
                          onChange={() => patch({ multiRule: rule.value as MultiRule }, ["multiRule"])}
                          className="size-4 accent-vermilion-deep"
                        />
                        <span className="font-sans font-medium">{rule.label}</span>
                      </span>
                      <span className="pl-7 font-sans text-sm text-ink-soft">{rule.explain}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </Section>

          <Section index="04" title="Explanation">
            <Field
              id="q-explanation"
              label="Explanation"
              error={errorFor("explanation")}
              hint="Shown to the candidate after results are published, when the exam allows it."
              count={`${draft.explanation.length} / ${LIMITS.explanationMax}`}
            >
              <textarea
                id="q-explanation"
                rows={4}
                className={textareaClass}
                value={draft.explanation}
                onChange={(event) => patch({ explanation: event.target.value }, ["explanation"])}
                aria-invalid={Boolean(errorFor("explanation")) || undefined}
                aria-describedby={describedBy("q-explanation", errorFor("explanation"), true)}
              />
            </Field>
          </Section>

          <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center gap-3 border-t border-ink bg-paper px-5 py-4 md:-mx-8 md:px-8">
            <Button type="submit" loading={saving}>
              {editing ? "Save changes" : "Create question"}
            </Button>
            <Button asChild variant="link">
              <Link href="/app/examiner/questions">Cancel</Link>
            </Button>
            {editing && version !== null && (
              <MonoLabel className="ml-auto">Version {version}</MonoLabel>
            )}
          </div>
        </form>

        <aside className="grid min-w-0 content-start gap-6 lg:sticky lg:top-8">
          <QuestionPreview draft={draft} />
        </aside>
      </div>
    </main>
  );
}

function BackLink() {
  return (
    <Link
      href="/app/examiner/questions"
      className="inline-flex w-fit items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase transition-colors duration-(--duration-fast) hover:text-vermilion-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
    >
      <ArrowLeft aria-hidden className="size-3.5" />
      Question bank
    </Link>
  );
}

function Section({ index, title, children }: { index: string; title: string; children: ReactNode }) {
  return (
    <section className="grid gap-6 border-t border-rule pt-8">
      <h2 className="flex items-baseline gap-4 font-sans text-xl font-medium tracking-[-0.02em]">
        <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted">{index}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  count,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  count?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 content-start gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-mono text-[11px] tracking-[0.14em] uppercase">
          {label}
        </label>
        {count && <span className="font-mono text-[11px] text-ink-muted">{count}</span>}
      </div>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="font-sans text-sm text-ink-muted">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/** Only ids that actually render get referenced, so screen readers never point at nothing. */
function describedBy(id: string, error: string | undefined, hasHint = false): string | undefined {
  const parts: string[] = [];
  if (hasHint && !error) parts.push(`${id}-hint`);
  if (error) parts.push(`${id}-error`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
