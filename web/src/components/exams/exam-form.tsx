"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api/client";
import { describeError } from "@/lib/errors/describe";
import type { Exam, ExamInput, ExamSettings } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SETTINGS,
  fieldErrorsFrom,
  isConflict,
  isoToLocalInput,
  localInputToIso,
  notifyExamChanged,
  parseMarks,
  parseWhole,
  windowMinutes,
} from "./format";

/** Form state. Dates are datetime-local strings in the examiner's local time. */
type Values = {
  title: string;
  instructions: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: string;
  totalMarks: string;
  passMarks: string;
  lateJoin: boolean;
  lateJoinMinutes: string;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  allowOfflineJournal: boolean;
  showBreakdown: boolean;
  watermark: boolean;
  canary: boolean;
  fullscreen: boolean;
};

type Field = keyof Values;
type Errors = Partial<Record<Field, string>>;

/** Which ExamInput key a form field belongs to. Settings toggles all belong to `settings`. */
const FIELD_KEY: Record<Field, keyof ExamInput> = {
  title: "title",
  instructions: "instructions",
  startsAt: "startsAt",
  endsAt: "endsAt",
  durationMinutes: "durationMinutes",
  totalMarks: "totalMarks",
  passMarks: "passMarks",
  lateJoin: "settings",
  lateJoinMinutes: "settings",
  shuffleQuestions: "settings",
  shuffleOptions: "settings",
  allowOfflineJournal: "settings",
  showBreakdown: "settings",
  watermark: "settings",
  canary: "settings",
  fullscreen: "settings",
};

/** The part of each input id after the form prefix. Must match the id given to FieldRow. */
const DOM_SUFFIX: Record<Field, string> = {
  title: "title",
  instructions: "instructions",
  startsAt: "starts",
  endsAt: "ends",
  durationMinutes: "duration",
  totalMarks: "total",
  passMarks: "pass",
  lateJoin: "late",
  lateJoinMinutes: "late-minutes",
  shuffleQuestions: "shuffle-q",
  shuffleOptions: "shuffle-o",
  allowOfflineJournal: "offline",
  showBreakdown: "breakdown",
  watermark: "watermark",
  canary: "canary",
  fullscreen: "fullscreen",
};

const ALL_KEYS = new Set<keyof ExamInput>([
  "title",
  "instructions",
  "startsAt",
  "endsAt",
  "durationMinutes",
  "totalMarks",
  "passMarks",
  "settings",
]);

const FIELD_NAMES: Record<keyof ExamInput, string> = {
  title: "title",
  instructions: "instructions",
  startsAt: "start time",
  endsAt: "end time",
  durationMinutes: "duration",
  totalMarks: "total marks",
  passMarks: "pass marks",
  settings: "candidate rules",
};

/**
 * What may change for a given exam state (C2 rules). A draft can change everything. A published exam keeps its
 * paper and rules frozen. Before the start, the title and end time can change (the end only extends). Once
 * the exam is running or later, only instructions and an end-time extension are allowed.
 */
export function editableKeys(exam: Exam | null): Set<keyof ExamInput> {
  if (!exam || exam.status === "draft") return ALL_KEYS;
  if (exam.phase === "scheduled") return new Set<keyof ExamInput>(["title", "instructions", "endsAt"]);
  return new Set<keyof ExamInput>(["instructions", "endsAt"]);
}

function valuesFromExam(exam: Exam): Values {
  const late = exam.settings.lateJoinMinutes;
  return {
    title: exam.title,
    instructions: exam.instructions,
    startsAt: isoToLocalInput(exam.startsAt),
    endsAt: isoToLocalInput(exam.endsAt),
    durationMinutes: String(exam.durationMinutes),
    totalMarks: String(exam.totalMarks),
    passMarks: String(exam.passMarks),
    lateJoin: late !== null,
    lateJoinMinutes: late === null ? "15" : String(late),
    shuffleQuestions: exam.settings.shuffleQuestions,
    shuffleOptions: exam.settings.shuffleOptions,
    allowOfflineJournal: exam.settings.allowOfflineJournal,
    showBreakdown: exam.settings.showBreakdown,
    watermark: exam.settings.integrity.watermark,
    canary: exam.settings.integrity.canary,
    fullscreen: exam.settings.integrity.fullscreen,
  };
}

/** Starts tomorrow at 10:00 local time, two hours long. Called on the client only. */
function defaultValues(now: Date): Values {
  const start = new Date(now);
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  return {
    title: "",
    instructions: "",
    startsAt: isoToLocalInput(start.toISOString()),
    endsAt: isoToLocalInput(end.toISOString()),
    durationMinutes: "60",
    totalMarks: "100",
    passMarks: "40",
    lateJoin: false,
    lateJoinMinutes: "15",
    shuffleQuestions: DEFAULT_SETTINGS.shuffleQuestions,
    shuffleOptions: DEFAULT_SETTINGS.shuffleOptions,
    allowOfflineJournal: DEFAULT_SETTINGS.allowOfflineJournal,
    showBreakdown: DEFAULT_SETTINGS.showBreakdown,
    watermark: DEFAULT_SETTINGS.integrity.watermark,
    canary: DEFAULT_SETTINGS.integrity.canary,
    fullscreen: DEFAULT_SETTINGS.integrity.fullscreen,
  };
}

function settingsFrom(values: Values): ExamSettings {
  return {
    shuffleQuestions: values.shuffleQuestions,
    shuffleOptions: values.shuffleOptions,
    allowOfflineJournal: values.allowOfflineJournal,
    lateJoinMinutes: values.lateJoin ? parseWhole(values.lateJoinMinutes) : null,
    showBreakdown: values.showBreakdown,
    integrity: { watermark: values.watermark, canary: values.canary, fullscreen: values.fullscreen },
  };
}

/** Checks the form the way C2 does, so most mistakes are caught before the request. */
function validate(values: Values): { input: ExamInput | null; errors: Errors } {
  const errors: Errors = {};
  const title = values.title.trim();
  if (title.length < 1 || title.length > 160) errors.title = "Enter a title of 1 to 160 characters.";
  if (values.instructions.length > 8000) {
    errors.instructions = `Instructions can be at most 8000 characters. This has ${values.instructions.length}.`;
  }

  const startsAt = localInputToIso(values.startsAt);
  const endsAt = localInputToIso(values.endsAt);
  if (!startsAt) errors.startsAt = "Choose a start date and time.";
  if (!endsAt) errors.endsAt = "Choose an end date and time.";

  let windowLength = 0;
  if (startsAt && endsAt) {
    if (Date.parse(endsAt) <= Date.parse(startsAt)) errors.endsAt = "The end must be after the start.";
    else windowLength = windowMinutes(startsAt, endsAt);
  }

  const duration = parseWhole(values.durationMinutes);
  if (duration === null || duration < 1 || duration > 1440) {
    errors.durationMinutes = "Enter a whole number of minutes from 1 to 1440.";
  } else if (windowLength > 0 && duration > windowLength) {
    errors.durationMinutes = `The duration (${duration} min) is longer than the window (${windowLength} min).`;
  }

  const total = parseMarks(values.totalMarks);
  if (total === null || total <= 0 || total > 100000) {
    errors.totalMarks = "Enter total marks above 0 and up to 100000, with at most two decimals.";
  }

  const pass = parseMarks(values.passMarks);
  if (pass === null || (total !== null && pass > total)) {
    errors.passMarks = "Pass marks must be between 0 and the total marks.";
  }

  if (values.lateJoin) {
    const late = parseWhole(values.lateJoinMinutes);
    if (late === null || late > 1440) errors.lateJoinMinutes = "Enter whole minutes from 0 to 1440.";
  }

  if (Object.keys(errors).length > 0 || !startsAt || !endsAt || duration === null || total === null || pass === null) {
    return { input: null, errors };
  }

  return {
    input: {
      title,
      instructions: values.instructions,
      startsAt,
      endsAt,
      durationMinutes: duration,
      totalMarks: total,
      passMarks: pass,
      settings: settingsFrom(values),
    },
    errors,
  };
}

/** The PATCH body holds only the keys this exam state allows the examiner to change. */
function patchBody(input: ExamInput, editable: Set<keyof ExamInput>): Partial<ExamInput> {
  const body: Partial<ExamInput> = {};
  for (const key of editable) {
    // Each key is assigned from the same key, so the value type matches.
    Object.assign(body, { [key]: input[key] });
  }
  return body;
}

function describedBy(...parts: Array<string | false | undefined>): string | undefined {
  const value = parts.filter(Boolean).join(" ");
  return value || undefined;
}

export function ExamForm({
  mode,
  exam,
  onSaved,
  className,
}: {
  mode: "create" | "edit";
  exam?: Exam;
  onSaved?: (exam: Exam) => void;
  className?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const idPrefix = useId();
  const zoneLabel = useTimeZone();

  const [baseline, setBaseline] = useState<Values | null>(exam ? valuesFromExam(exam) : null);
  const [values, setValues] = useState<Values | null>(exam ? valuesFromExam(exam) : null);
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);

  // The create form sets its defaults after mount, so the server and the first client render match.
  useEffect(() => {
    if (mode !== "create" || values !== null) return;
    const initial = defaultValues(new Date());
    setBaseline(initial);
    setValues(initial);
  }, [mode, values]);

  const editable = mode === "edit" ? editableKeys(exam ?? null) : ALL_KEYS;
  const locked = mode === "edit" && editable.size < ALL_KEYS.size;
  const canEdit = (field: Field) => editable.has(FIELD_KEY[field]);

  if (values === null || baseline === null) {
    return <p role="status" className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Preparing form</p>;
  }

  const dirty = JSON.stringify(values) !== JSON.stringify(baseline);
  const lateEnabled = values.lateJoin;

  function set<K extends Field>(field: K, value: Values[K]) {
    setValues((current) => (current ? { ...current, [field]: value } : current));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function errorId(field: Field) {
    return `${idPrefix}-${field}-error`;
  }
  /** The id FieldRow gives its hint. The input id is built from DOM_SUFFIX, so both must agree. */
  function hintId(field: Field) {
    return `${idPrefix}-${DOM_SUFFIX[field]}-hint`;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !values) return;

    const result = validate(values);
    setErrors(result.errors);
    if (!result.input) return;
    setPending(true);

    try {
      if (mode === "create") {
        const created = await api<Exam>("/exams", { body: result.input });
        toast.success("Exam created as a draft.");
        router.replace(`/app/examiner/exams/${encodeURIComponent(created.id)}`);
        return;
      }
      if (!exam) return;
      const saved = await api<Exam>(`/exams/${encodeURIComponent(exam.id)}`, {
        method: "PATCH",
        body: patchBody(result.input, editable),
        headers: { "If-Match": String(exam.version) },
      });
      toast.success("Changes saved.");
      notifyExamChanged(exam.id);
      onSaved?.(saved);
    } catch (cause) {
      const serverErrors = fieldErrorsFrom(cause);
      const mapped: Errors = {};
      for (const field of Object.keys(FIELD_KEY) as Field[]) {
        if (serverErrors[field]) mapped[field] = serverErrors[field];
      }
      setErrors((current) => ({ ...current, ...mapped }));
      // A save that failed on the server is a toast. Field messages stay beside their fields.
      toast.error(
        isConflict(cause)
          ? "This exam was changed somewhere else. Reload the page to see the latest version, then try again."
          : describeError(cause, { context: "action" }),
      );
    } finally {
      setPending(false);
    }
  }

  function discard() {
    setValues(baseline);
    setErrors({});
  }

  const endsHint =
    mode === "edit" && canEdit("endsAt") && exam?.status !== "draft" ? "You can only move the end later." : undefined;

  const lockedHint = locked
    ? `Published exams freeze their paper and rules. You can still change: ${Array.from(editable, (key) => FIELD_NAMES[key]).join(", ")}. The end time can only be extended.`
    : null;

  return (
    <form onSubmit={onSubmit} noValidate className={cn("grid gap-14", className)} aria-labelledby={`${idPrefix}-form`}>
      <h2 id={`${idPrefix}-form`} className="sr-only">
        {mode === "create" ? "New exam" : "Exam details"}
      </h2>

      {lockedHint ? (
        <div className="grid max-w-prose gap-2 border-l-2 border-ink pl-5">
          <p className="font-mono text-[11px] tracking-[0.14em] uppercase">Published: some fields are locked</p>
          <p className="text-ink-soft">{lockedHint}</p>
        </div>
      ) : null}

      <Section index="01" title="Basics">
        <FieldRow id={`${idPrefix}-title`} label="Title" error={errors.title} errorId={errorId("title")} hint="Shown to candidates in the lobby and on their results.">
          <Input
            id={`${idPrefix}-title`}
            value={values.title}
            maxLength={200}
            disabled={!canEdit("title")}
            onChange={(event) => set("title", event.target.value)}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy(hintId("title"), errors.title && errorId("title"))}
            aria-required="true"
            autoComplete="off"
          />
        </FieldRow>

        <FieldRow id={`${idPrefix}-instructions`} label="Instructions" error={errors.instructions} errorId={errorId("instructions")} hint={`Shown before the exam starts. ${values.instructions.length} of 8000 characters.`}>
          <textarea
            id={`${idPrefix}-instructions`}
            value={values.instructions}
            rows={6}
            disabled={!canEdit("instructions")}
            onChange={(event) => set("instructions", event.target.value)}
            aria-invalid={errors.instructions ? true : undefined}
            aria-describedby={describedBy(hintId("instructions"), errors.instructions && errorId("instructions"))}
            className={textareaClass}
          />
        </FieldRow>
      </Section>

      <Section index="02" title="Schedule" note={`Times are in your local time zone (${zoneLabel}). The server stores them as UTC.`}>
        <div className="grid gap-8 md:grid-cols-2">
          <FieldRow id={`${idPrefix}-starts`} label="Starts" error={errors.startsAt} errorId={errorId("startsAt")}>
            <Input
              id={`${idPrefix}-starts`}
              type="datetime-local"
              value={values.startsAt}
              disabled={!canEdit("startsAt")}
              onChange={(event) => set("startsAt", event.target.value)}
              aria-invalid={errors.startsAt ? true : undefined}
              aria-describedby={describedBy(errors.startsAt && errorId("startsAt"))}
            />
          </FieldRow>
          <FieldRow id={`${idPrefix}-ends`} label="Ends" error={errors.endsAt} errorId={errorId("endsAt")} hint={endsHint}>
            <Input
              id={`${idPrefix}-ends`}
              type="datetime-local"
              value={values.endsAt}
              disabled={!canEdit("endsAt")}
              onChange={(event) => set("endsAt", event.target.value)}
              aria-invalid={errors.endsAt ? true : undefined}
              aria-describedby={describedBy(endsHint && hintId("endsAt"), errors.endsAt && errorId("endsAt"))}
            />
          </FieldRow>
        </div>
        <FieldRow id={`${idPrefix}-duration`} label="Duration (minutes)" error={errors.durationMinutes} errorId={errorId("durationMinutes")} hint="How long one candidate has once they start. Must fit inside the window.">
          <Input
            id={`${idPrefix}-duration`}
            inputMode="numeric"
            value={values.durationMinutes}
            disabled={!canEdit("durationMinutes")}
            onChange={(event) => set("durationMinutes", event.target.value)}
            aria-invalid={errors.durationMinutes ? true : undefined}
            aria-describedby={describedBy(hintId("durationMinutes"), errors.durationMinutes && errorId("durationMinutes"))}
            className="max-w-xs"
          />
        </FieldRow>
      </Section>

      <Section index="03" title="Marks">
        <div className="grid gap-8 md:grid-cols-2">
          <FieldRow id={`${idPrefix}-total`} label="Total marks" error={errors.totalMarks} errorId={errorId("totalMarks")} hint="The assigned questions must add up to exactly this.">
            <Input
              id={`${idPrefix}-total`}
              inputMode="decimal"
              value={values.totalMarks}
              disabled={!canEdit("totalMarks")}
              onChange={(event) => set("totalMarks", event.target.value)}
              aria-invalid={errors.totalMarks ? true : undefined}
              aria-describedby={describedBy(hintId("totalMarks"), errors.totalMarks && errorId("totalMarks"))}
            />
          </FieldRow>
          <FieldRow id={`${idPrefix}-pass`} label="Pass marks" error={errors.passMarks} errorId={errorId("passMarks")}>
            <Input
              id={`${idPrefix}-pass`}
              inputMode="decimal"
              value={values.passMarks}
              disabled={!canEdit("passMarks")}
              onChange={(event) => set("passMarks", event.target.value)}
              aria-invalid={errors.passMarks ? true : undefined}
              aria-describedby={describedBy(errors.passMarks && errorId("passMarks"))}
            />
          </FieldRow>
        </div>
      </Section>

      <Section index="04" title="Candidate rules">
        <Toggle id={`${idPrefix}-shuffle-q`} label="Shuffle questions" description="Each candidate sees the questions in a different order. Helps reduce copying from neighbours." checked={values.shuffleQuestions} disabled={!canEdit("shuffleQuestions")} onChange={(v) => set("shuffleQuestions", v)} />
        <Toggle id={`${idPrefix}-shuffle-o`} label="Shuffle answer options" description="Multiple-choice options are shown in a random order per candidate. The answer key still scores correctly." checked={values.shuffleOptions} disabled={!canEdit("shuffleOptions")} onChange={(v) => set("shuffleOptions", v)} />
        <Toggle id={`${idPrefix}-offline`} label="Allow answering offline" description="If the connection drops, answers are kept on the device in a tamper-evident journal and sent when it returns. The server rejects anything written after the deadline." checked={values.allowOfflineJournal} disabled={!canEdit("allowOfflineJournal")} onChange={(v) => set("allowOfflineJournal", v)} />
        <Toggle id={`${idPrefix}-late`} label="Limit late joining" description="When on, candidates can start only for a set number of minutes after the start time. When off, they can start any time in the window." checked={values.lateJoin} disabled={!canEdit("lateJoin")} onChange={(v) => set("lateJoin", v)}>
          {lateEnabled ? (
            <FieldRow id={`${idPrefix}-late-minutes`} label="Minutes after start" error={errors.lateJoinMinutes} errorId={errorId("lateJoinMinutes")}>
              <Input id={`${idPrefix}-late-minutes`} inputMode="numeric" value={values.lateJoinMinutes} disabled={!canEdit("lateJoinMinutes")} onChange={(event) => set("lateJoinMinutes", event.target.value)} aria-invalid={errors.lateJoinMinutes ? true : undefined} aria-describedby={describedBy(errors.lateJoinMinutes && errorId("lateJoinMinutes"))} className="max-w-xs" />
            </FieldRow>
          ) : null}
        </Toggle>
        <Toggle id={`${idPrefix}-breakdown`} label="Show question breakdown with results" description="After results are published, candidates see each question with their marks. Answer keys are shown only when this is on." checked={values.showBreakdown} disabled={!canEdit("showBreakdown")} onChange={(v) => set("showBreakdown", v)} />
      </Section>

      <Section index="05" title="Integrity" note="These are signals for review. They are never verdicts on their own.">
        <Toggle id={`${idPrefix}-watermark`} label="Invisible watermark" description="Each candidate's copy of the questions carries invisible marks. If the paper leaks, the Monitor tab can trace the copy back to a candidate." checked={values.watermark} disabled={!canEdit("watermark")} onChange={(v) => set("watermark", v)} />
        <Toggle id={`${idPrefix}-canary`} label="AI canary" description="A hidden instruction is placed in the question text. If a candidate pastes the question into an AI tool, the answer may echo it, which is flagged for review." checked={values.canary} disabled={!canEdit("canary")} onChange={(v) => set("canary", v)} />
        <Toggle id={`${idPrefix}-fullscreen`} label="Ask for fullscreen and record exits" description="The workspace asks candidates to go fullscreen and records when they leave it." checked={values.fullscreen} disabled={!canEdit("fullscreen")} onChange={(v) => set("fullscreen", v)} />
      </Section>

      <div className="mobile-safe-action sticky bottom-0 z-10 -mx-5 grid gap-4 border-t border-ink bg-paper px-5 py-5 md:-mx-8 md:px-8">
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" loading={pending} disabled={!dirty && mode === "edit"}>
            {mode === "create" ? "Create draft" : "Save changes"}
          </Button>
          {mode === "edit" ? (
            <Button type="button" variant="ghost" disabled={!dirty || pending} onClick={discard}>
              Discard changes
            </Button>
          ) : null}
          <p role="status" className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            {dirty ? "Unsaved changes" : mode === "edit" ? "All changes saved" : ""}
          </p>
        </div>
      </div>
    </form>
  );
}

const textareaClass =
  "min-h-32 w-full resize-y border-0 border-b border-current/30 bg-transparent py-3 font-sans text-base text-current caret-vermilion outline-none transition-colors duration-300 placeholder:text-current/35 hover:border-current/60 focus-visible:border-current disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-vermilion";

function useTimeZone(): string {
  const [zone, setZone] = useState("your local time");
  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "your local time");
  }, []);
  return zone;
}

function Section({ index, title, note, children }: { index: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-8 md:grid-cols-12">
      <header className="grid content-start gap-3 md:col-span-3">
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          {index} / {title}
        </p>
        {note ? <p className="text-sm text-ink-soft">{note}</p> : null}
      </header>
      <div className="grid gap-8 md:col-span-8 md:col-start-5">{children}</div>
    </section>
  );
}

function FieldRow({
  id,
  label,
  hint,
  error,
  errorId,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  errorId: string;
  children: ReactNode;
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p id={`${id}-hint`} className="text-sm text-ink-muted">{hint}</p> : null}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function Toggle({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
  children,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  children?: ReactNode;
}) {
  const descriptionId = `${id}-description`;
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-3 border-t border-rule pt-6">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        aria-describedby={descriptionId}
        className="mt-1"
      />
      <Label htmlFor={id} className="font-sans text-base font-medium tracking-normal normal-case">
        {label}
      </Label>
      <p id={descriptionId} className="col-start-2 text-sm text-ink-soft">
        {description}
      </p>
      {children ? <div className="col-start-2">{children}</div> : null}
    </div>
  );
}
