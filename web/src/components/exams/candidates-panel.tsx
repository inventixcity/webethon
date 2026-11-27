"use client";

import { useId, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { TokenInput } from "@/components/effects/token-input";
import { useToast } from "@/components/feedback/toaster";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CsvParseError, parseCsv, rowsToObjects } from "@/components/import/csv";
import { AccessLinkReveal, resetAccessMessage, type IssuedAccessLink } from "@/components/auth/access-link";
import { api } from "@/lib/api/client";
import { describeError, messageFor } from "@/lib/errors/describe";
import type { CandidateImportRow, Enrollment, ImportResult, ImportRowError } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { SectionIntro } from "./section-intro";
import { notifyExamChanged } from "./format";
import { EmptyState, ErrorState, LoadingState } from "./states";
import { useResource } from "./use-resource";

const MAX_ROWS = 1000;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The enrolment call returns the import result plus one link per new invite (shown once). */
type EnrollResult = ImportResult & { inviteLinks?: Array<{ email: string; url: string }> };

type PendingRow = CandidateImportRow & { origin: "manual" | "csv" };

type Validation = { key: string; result: ImportResult };

/** The Candidates tab: who is enrolled, plus adding candidates by hand or from CSV. */
export function CandidatesPanel({ examId }: { examId: string }) {
  const base = `/exams/${encodeURIComponent(examId)}/enrollments` as const;
  const { data, error, loading, reload } = useResource<Enrollment[]>(base);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [inviteLinks, setInviteLinks] = useState<Array<{ email: string; url: string }> | null>(null);
  const [announce, setAnnounce] = useState("");
  const [accessLink, setAccessLink] = useState<{ email: string; link: IssuedAccessLink } | null>(null);

  function queue(rows: PendingRow[]) {
    setPending((current) => [...current, ...rows]);
    setAnnounce(`${rows.length} ${rows.length === 1 ? "candidate" : "candidates"} added to the list to enrol.`);
  }

  return (
    <div className="grid gap-16 py-10">
      <p role="status" className="sr-only">
        {announce}
      </p>
      <SectionIntro
        eyebrow="Candidates / 04"
        title="Candidates"
        summary="Who sits this exam. Add candidates by email, CSV or one at a time, then enrol them together."
      />

      <section aria-labelledby="enrolled-heading" className="grid gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-ink pb-4">
          <h2 id="enrolled-heading" className="font-mono text-[11px] tracking-[0.14em] uppercase">
            01 / Enrolled <span className="text-ink-muted">({data?.length ?? 0})</span>
          </h2>
        </div>
        {loading ? <LoadingState label="Loading candidates" rows={3} /> : null}
        {!loading && error ? <ErrorState error={error} onRetry={reload} /> : null}
        {!loading && !error && data ? (
          <EnrollmentTable
            examId={examId}
            rows={data}
            onChanged={() => {
              reload();
              notifyExamChanged(examId);
            }}
            onReenroll={(row) => {
              queue([{ email: row.email, displayName: row.displayName, extraMinutes: row.extraMinutes, origin: "manual" }]);
            }}
            onIssued={(email, link) => setAccessLink({ email, link })}
          />
        ) : null}
      </section>

      {accessLink ? (
        <AccessLinkReveal email={accessLink.email} link={accessLink.link} onDismiss={() => setAccessLink(null)} />
      ) : null}

      <section aria-labelledby="add-heading" className="grid gap-8">
        <h2 id="add-heading" className="border-b border-ink pb-4 font-mono text-[11px] tracking-[0.14em] uppercase">
          02 / Add candidates
        </h2>
        <div className="grid gap-6 lg:grid-cols-3">
          <QuickEmails enrolled={data ?? []} onAdd={queue} />
          <ManualForm enrolled={data ?? []} onAdd={queue} />
          <CsvForm onAdd={queue} queuedCount={pending.length} />
        </div>
        <Enroller
          examId={examId}
          pending={pending}
          setPending={setPending}
          onEnrolled={(links) => {
            setPending([]);
            setInviteLinks(links);
            reload();
            notifyExamChanged(examId);
          }}
        />
      </section>

      {inviteLinks && inviteLinks.length > 0 ? <InviteLinks links={inviteLinks} onDismiss={() => setInviteLinks(null)} /> : null}
    </div>
  );
}

function EnrollmentTable({
  examId,
  rows,
  onChanged,
  onReenroll,
  onIssued,
}: {
  examId: string;
  rows: Enrollment[];
  onChanged: () => void;
  onReenroll: (row: Enrollment) => void;
  onIssued: (email: string, link: IssuedAccessLink) => void;
}) {
  const [revoking, setRevoking] = useState<Enrollment | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [resetting, setResetting] = useState<Enrollment | null>(null);
  const [resetPending, setResetPending] = useState(false);
  const toast = useToast();

  async function revoke() {
    if (!revoking) return;
    setRevokePending(true);
    try {
      await api<void>(`/exams/${encodeURIComponent(examId)}/enrollments/${encodeURIComponent(revoking.candidateId)}`, { method: "DELETE" });
      toast.success(`Access revoked for ${revoking.email}.`);
      setRevoking(null);
      onChanged();
    } catch (cause) {
      toast.error(messageFor(cause));
    } finally {
      setRevokePending(false);
    }
  }

  async function resetAccess() {
    if (!resetting) return;
    setResetPending(true);
    try {
      const link = await api<IssuedAccessLink>(`/exams/${encodeURIComponent(examId)}/enrollments/${encodeURIComponent(resetting.candidateId)}/reset-access`, { method: "POST" });
      onIssued(resetting.email, link);
      setResetting(null);
      onChanged();
    } catch (cause) {
      setResetting(null);
      toast.error(resetAccessMessage(cause, "candidate"));
    } finally {
      setResetPending(false);
    }
  }

  if (rows.length === 0) {
    return <EmptyState title="No candidates yet.">Add candidates below. Each one gets a personal account and an invite.</EmptyState>;
  }

  return (
    <>
      <div className="min-w-0">
        <table className="w-full border-collapse text-left text-sm md:min-w-[760px]">
          <caption className="sr-only">Enrolled candidates for this exam</caption>
          <thead className="max-md:sr-only">
            <tr className="border-b border-ink font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
              <th scope="col" className="py-3 pr-4 font-medium">Candidate</th>
              <th scope="col" className="py-3 pr-4 font-medium">Status</th>
              <th scope="col" className="py-3 pr-4 font-medium">Account</th>
              <th scope="col" className="py-3 pr-4 font-medium">Extra minutes</th>
              <th scope="col" className="py-3 pr-4 font-medium">Attempt</th>
              <th scope="col" className="py-3 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="max-md:block">
            {rows.map((row) => (
              <EnrollmentRow
                key={row.candidateId}
                examId={examId}
                row={row}
                onChanged={onChanged}
                onRevoke={() => setRevoking(row)}
                onReset={() => setResetting(row)}
                onReenroll={() => onReenroll(row)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke access?"
        confirmLabel="Revoke access"
        destructive
        pending={revokePending}
        onCancel={() => setRevoking(null)}
        onConfirm={revoke}
      >
        <p>{revoking ? `${revoking.displayName} (${revoking.email}) can no longer start or continue this exam.` : ""}</p>
        <p>This applies even mid-exam. You can enrol them again later.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={resetting !== null}
        title="Reset access?"
        confirmLabel="Reset access"
        destructive
        pending={resetPending}
        onCancel={() => setResetting(null)}
        onConfirm={resetAccess}
      >
        <p>{resetting ? `${resetting.displayName} (${resetting.email}) will be signed out everywhere and their current password stops working.` : ""}</p>
        <p>You get a new access link to hand over. No email is sent, and the link is shown once.</p>
      </ConfirmDialog>
    </>
  );
}

function EnrollmentRow({
  examId,
  row,
  onChanged,
  onRevoke,
  onReset,
  onReenroll,
}: {
  examId: string;
  row: Enrollment;
  onChanged: () => void;
  onRevoke: () => void;
  onReset: () => void;
  onReenroll: () => void;
}) {
  const toast = useToast();
  const idPrefix = useId();
  const [minutes, setMinutes] = useState(String(row.extraMinutes));
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [minutesError, setMinutesError] = useState<string | null>(null);
  const revoked = row.status === "revoked";
  const changed = minutes.trim() !== String(row.extraMinutes);

  async function saveMinutes() {
    const value = /^\d+$/.test(minutes.trim()) ? Number(minutes.trim()) : NaN;
    if (!Number.isInteger(value) || value < 0 || value > 600) {
      setMinutesError("Use a whole number from 0 to 600.");
      return;
    }
    setSaving(true);
    setMinutesError(null);
    try {
      await api<Enrollment>(`/exams/${encodeURIComponent(examId)}/enrollments/${encodeURIComponent(row.candidateId)}`, {
        method: "PATCH",
        body: { extraMinutes: value },
      });
      toast.success(`Extra time saved for ${row.displayName}.`);
      onChanged();
    } catch (cause) {
      setMinutesError(messageFor(cause));
    } finally {
      setSaving(false);
    }
  }

  async function resend() {
    setSending(true);
    try {
      await api<{ sent: boolean }>(`/exams/${encodeURIComponent(examId)}/enrollments/${encodeURIComponent(row.candidateId)}/invite`, { method: "POST" });
      toast.success(`Invite sent to ${row.email}.`);
    } catch (cause) {
      toast.error(messageFor(cause));
    } finally {
      setSending(false);
    }
  }

  const accountLabel = row.activated ? "Account active" : row.invited ? "Invite sent" : "Not invited";
  const attemptLabel = row.attempt
    ? `${row.attempt.status.replace("_", " ")}${row.attempt.totalScore !== null ? ` / ${row.attempt.totalScore}` : ""}`
    : "No attempt";

  return (
    <tr className="border-b border-rule align-top max-md:my-3 max-md:grid max-md:grid-cols-2 max-md:gap-x-4 max-md:gap-y-4 max-md:border max-md:bg-paper-raised max-md:p-4">
      <th scope="row" className="py-4 pr-4 font-normal max-md:col-span-2 max-md:p-0">
        <span className="block font-medium">{row.displayName}</span>
        <span className="block text-ink-muted break-all">{row.email}</span>
      </th>
      <td data-label="Status" className="py-4 pr-4 max-md:grid max-md:gap-1 max-md:p-0 max-md:before:font-mono max-md:before:text-[11px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)]">
        {revoked ? (
          <Badge tone="muted">Revoked</Badge>
        ) : (
          <Badge tone="outline" dot>
            Enrolled
          </Badge>
        )}
      </td>
      <td data-label="Account" className="py-4 pr-4 max-md:grid max-md:gap-1 max-md:p-0 max-md:before:font-mono max-md:before:text-[11px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)]">
        <Badge tone={row.activated ? "info" : row.invited ? "dashed" : "muted"} dot={row.activated ? "live" : undefined}>
          {accountLabel}
        </Badge>
      </td>
      <td data-label="Extra minutes" className="py-4 pr-4 max-md:grid max-md:gap-1 max-md:p-0 max-md:before:font-mono max-md:before:text-[11px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)]">
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={`${idPrefix}-minutes`} className="sr-only">
              Extra minutes for {row.displayName}
            </Label>
            <Input
              id={`${idPrefix}-minutes`}
              inputMode="numeric"
              value={minutes}
              disabled={revoked || saving}
              onChange={(event) => setMinutes(event.target.value)}
              aria-invalid={minutesError ? true : undefined}
              aria-describedby={minutesError ? `${idPrefix}-minutes-error` : undefined}
              className="h-10 w-20"
            />
            <Button variant="secondary" size="sm" disabled={!changed || revoked} loading={saving} onClick={saveMinutes}>
              Save
            </Button>
          </div>
          {minutesError ? (
            <p id={`${idPrefix}-minutes-error`} role="alert" className="text-xs text-vermilion-deep">
              {minutesError}
            </p>
          ) : null}
        </div>
      </td>
      <td data-label="Attempt" className="py-4 pr-4 text-ink-soft max-md:grid max-md:gap-1 max-md:p-0 max-md:before:font-mono max-md:before:text-[11px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)]">{attemptLabel}</td>
      <td data-label="Actions" className="py-4 max-md:col-span-2 max-md:border-t max-md:border-rule max-md:pt-3">
        <div className="flex flex-wrap justify-end gap-2 max-md:justify-start">
          {revoked ? (
            <Button variant="secondary" size="sm" onClick={onReenroll}>
              Enrol again
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" loading={sending} onClick={resend}>
                Resend invite
              </Button>
              <Button variant="ghost" size="sm" onClick={onReset}>
                Reset access
              </Button>
              <Button variant="ghost" size="sm" onClick={onRevoke}>
                Revoke
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/** A display name from an address: "maya.lin@school.example" reads as "Maya Lin". The examiner can edit it afterwards. */
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const words = local
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return (words || email).slice(0, 120);
}

/**
 * Quick add by email. Type an address and press Enter or comma to make a token, then add them all to the list.
 * Addresses already enrolled are skipped, and duplicates collapse into one row.
 */
function QuickEmails({ enrolled, onAdd }: { enrolled: Enrollment[]; onAdd: (rows: PendingRow[]) => void }) {
  const idPrefix = useId();
  const [tokens, setTokens] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const known = new Set(enrolled.filter((row) => row.status === "enrolled").map((row) => row.email.toLowerCase()));

  function addAll() {
    setError(null);
    setNote(null);
    const cleaned = tokens.map((token) => token.trim().toLowerCase());
    const bad = cleaned.filter((email) => email.length > 254 || !EMAIL_SHAPE.test(email));
    if (bad.length > 0) {
      setError(`Not an email address: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? " and more" : ""}.`);
      return;
    }
    const unique = [...new Set(cleaned)];
    const fresh = unique.filter((email) => !known.has(email));
    if (fresh.length === 0) {
      setError("Nothing new to add. Those candidates are already enrolled or the list is empty.");
      return;
    }
    onAdd(fresh.map((email) => ({ email, displayName: nameFromEmail(email), origin: "manual" as const })));
    const skipped = unique.length - fresh.length;
    setNote(skipped > 0 ? `${skipped} already enrolled, skipped.` : null);
    setTokens([]);
  }

  return (
    <section className="grid content-start gap-5 border border-rule bg-paper-raised p-5 lg:min-h-[30rem]">
      <div id={`${idPrefix}-hint`} className="grid gap-1">
        <h3 className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">01 / Quick add by email</h3>
        <p className="text-sm text-ink-soft">Type or paste an address, then press Enter or comma. Names are filled in from the address.</p>
      </div>
      <TokenInput
        label="Candidate emails"
        value={tokens}
        onChange={setTokens}
        placeholder="maya.lin@example.com, then Enter"
      />
      <div className="mt-auto grid gap-3">
        <Button disabled={tokens.length === 0} onClick={addAll}>
          Add {tokens.length > 0 ? tokens.length : ""} to list
        </Button>
        {note ? <p role="status" className="text-sm text-ink-soft">{note}</p> : null}
      </div>
      {error ? <p role="alert" className="text-sm text-vermilion-deep">{error}</p> : null}
    </section>
  );
}

/** Manual entry of one candidate. Rows queue up and are checked and enrolled together. */
function ManualForm({ enrolled, onAdd }: { enrolled: Enrollment[]; onAdd: (rows: PendingRow[]) => void }) {
  const idPrefix = useId();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<{ email?: string; name?: string }>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();
    const next: { email?: string; name?: string } = {};
    if (cleanEmail.length === 0 || cleanEmail.length > 254 || !EMAIL_SHAPE.test(cleanEmail)) next.email = "Enter a valid email address.";
    else if (enrolled.some((row) => row.status === "enrolled" && row.email.toLowerCase() === cleanEmail)) next.email = "This candidate is already enrolled.";
    if (cleanName.length < 1 || cleanName.length > 120) next.name = "Enter a name of 1 to 120 characters.";
    setErrors(next);
    if (next.email || next.name) return;
    onAdd([{ email: cleanEmail, displayName: cleanName, origin: "manual" }]);
    setEmail("");
    setName("");
  }

  return (
    <form onSubmit={submit} noValidate className="grid content-start gap-5 border border-rule bg-paper-raised p-5 lg:min-h-[30rem]" aria-labelledby={`${idPrefix}-title`}>
      <div className="grid gap-1"><h3 id={`${idPrefix}-title`} className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">02 / Add one candidate</h3><p className="text-sm text-ink-soft">Enter a name and email to add one person to the enrolment list.</p></div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input id={`${idPrefix}-name`} value={name} maxLength={160} onChange={(event) => setName(event.target.value)} autoComplete="off" aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? `${idPrefix}-name-error` : undefined} />
        {errors.name ? <p id={`${idPrefix}-name-error`} role="alert" className="text-sm text-vermilion-deep">{errors.name}</p> : null}
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-email`}>Email</Label>
        <Input id={`${idPrefix}-email`} type="email" value={email} maxLength={254} onChange={(event) => setEmail(event.target.value)} autoComplete="off" aria-invalid={errors.email ? true : undefined} aria-describedby={errors.email ? `${idPrefix}-email-error` : undefined} />
        {errors.email ? <p id={`${idPrefix}-email-error`} role="alert" className="text-sm text-vermilion-deep">{errors.email}</p> : null}
      </div>
      <div>
        <Button type="submit" className="w-full">
          Add to list
        </Button>
      </div>
    </form>
  );
}

/** Reads a CSV with the columns email, displayName and extraMinutes (the last is optional). */
function CsvForm({ onAdd, queuedCount }: { onAdd: (rows: PendingRow[]) => void; queuedCount: number }) {
  const idPrefix = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setText(await file.text());
    setError(null);
    setCount(null);
  }

  function parse() {
    setError(null);
    setCount(null);
    if (text.trim() === "") {
      setError("Paste CSV text or choose a file first.");
      return;
    }
    try {
      const objects = rowsToObjects(parseCsv(text));
      const rows: PendingRow[] = objects.map(({ values }) => {
        const lower: Record<string, string> = {};
        for (const [key, value] of Object.entries(values)) lower[key.toLowerCase()] = value;
        const extra = (lower.extraminutes ?? "").trim();
        return {
          email: (lower.email ?? "").trim().toLowerCase(),
          displayName: (lower.displayname ?? lower.name ?? "").trim(),
          extraMinutes: extra === "" ? undefined : Number(extra),
          origin: "csv",
        };
      });
      if (rows.length === 0) {
        setError("No candidate rows found. The first line must be the header: email,displayName,extraMinutes.");
        return;
      }
      onAdd(rows);
      setCount(rows.length);
      setText("");
    } catch (cause) {
      setError(cause instanceof CsvParseError ? `${cause.message} (line ${cause.line})` : messageFor(cause));
    }
  }

  return (
    <div className="grid content-start gap-5 border border-rule bg-paper-raised p-5 lg:min-h-[30rem]">
      <div className="grid gap-1"><h3 className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">03 / Import CSV</h3><p className="text-sm text-ink-soft">Add a prepared list of candidates in one step.</p></div>
      <p className="text-sm text-ink-soft">
        Columns: <span className="font-mono">email, displayName, extraMinutes</span>. Extra minutes is optional. Up to {MAX_ROWS} rows.
      </p>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-file`}>CSV file</Label>
        <input
          id={`${idPrefix}-file`}
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => void onFile(event.target.files?.[0])}
          className="text-sm file:mr-4 file:border file:border-ink file:bg-transparent file:px-4 file:py-2 file:font-mono file:text-[11px] file:tracking-[0.12em] file:uppercase"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-text`}>Or paste CSV</Label>
        <textarea
          id={`${idPrefix}-text`}
          rows={6}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          className="w-full resize-y border border-rule bg-paper-raised p-3 font-mono text-sm text-current outline-none focus-visible:outline-2 focus-visible:outline-vermilion"
          aria-describedby={error ? `${idPrefix}-error` : undefined}
        />
      </div>
      {error ? <p id={`${idPrefix}-error`} role="alert" className="text-sm text-vermilion-deep">{error}</p> : null}
      {count !== null ? <p role="status" className="text-sm text-ink-soft">{count} rows added. {queuedCount} waiting to enrol.</p> : null}
      <div className="mt-auto">
        <Button className="w-full" onClick={parse}>
          Add rows from CSV
        </Button>
      </div>
    </div>
  );
}

/** The queued rows, the Validate step (a dry run), its errors, and the Enrol step. */
function Enroller({
  examId,
  pending,
  setPending,
  onEnrolled,
}: {
  examId: string;
  pending: PendingRow[];
  setPending: Dispatch<SetStateAction<PendingRow[]>>;
  onEnrolled: (links: Array<{ email: string; url: string }>) => void;
}) {
  const toast = useToast();
  const idPrefix = useId();
  const [invite, setInvite] = useState(true);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [checking, setChecking] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = pending.map(({ email, displayName, extraMinutes }) =>
    extraMinutes === undefined ? { email, displayName } : { email, displayName, extraMinutes },
  );
  const current = validation !== null && validation.key === JSON.stringify([candidates, invite]) ? validation.result : null;
  const stale = validation !== null && current === null;
  const valid = current !== null && current.errors.length === 0 && pending.length > 0;
  const base = `/exams/${encodeURIComponent(examId)}/enrollments` as const;

  function remove(index: number) {
    setPending((rows) => rows.filter((_, position) => position !== index));
    setValidation(null);
  }

  async function validate() {
    setError(null);
    if (pending.length > MAX_ROWS) {
      setError(`Enrol at most ${MAX_ROWS} candidates at once. Remove some rows first.`);
      return;
    }
    setChecking(true);
    try {
      const result = await api<ImportResult>(base, { method: "POST", body: { candidates, invite: false, dryRun: true } });
      setValidation({ key: JSON.stringify([candidates, invite]), result });
    } catch (cause) {
      toast.error(describeError(cause, { context: "action" }));
    } finally {
      setChecking(false);
    }
  }

  async function enrol() {
    if (!valid) return;
    setEnrolling(true);
    setError(null);
    try {
      const result = await api<EnrollResult>(base, { method: "POST", body: { candidates, invite, dryRun: false } });
      const created = result.created + result.updated;
      toast.success(`${created} ${created === 1 ? "candidate" : "candidates"} enrolled.`);
      setValidation(null);
      onEnrolled(result.inviteLinks ?? []);
    } catch (cause) {
      toast.error(describeError(cause, { context: "action" }));
    } finally {
      setEnrolling(false);
    }
  }

  return (
    <div className="grid gap-6">
      <h3 className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
        Ready to enrol <span className="text-ink">({pending.length})</span>
      </h3>

      {pending.length === 0 ? (
        <p className="border-t border-rule py-6 text-ink-muted">No rows yet. Add one above or import a CSV.</p>
      ) : (
        <ul aria-label="Rows to enrol" className="grid border-t border-rule">
          {pending.map((row, index) => (
            <li key={`${row.email}-${index}`} className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-3">
              <span className="min-w-0 text-sm break-all">
                <span className="font-medium">{row.displayName || "No name"}</span>{" "}
                <span className="text-ink-muted">{row.email || "no email"}</span>
                {row.extraMinutes !== undefined ? <span className="text-ink-muted"> / +{row.extraMinutes} min</span> : null}
              </span>
              <Button variant="ghost" size="sm" onClick={() => remove(index)} aria-label={`Remove ${row.email || `row ${index + 1}`} from the list`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {current && current.errors.length > 0 ? (
        <div role="alert" className="grid gap-3 border-l-2 border-vermilion pl-5">
          <p className="font-medium">
            {current.errors.length} {current.errors.length === 1 ? "row needs" : "rows need"} fixing. Nothing was enrolled.
          </p>
          <ul className="grid gap-1 text-sm text-ink-soft">
            {current.errors.map((item: ImportRowError, index) => (
              <li key={`${item.row}-${item.path}-${index}`}>
                Row {item.row}
                {item.path ? ` (${item.path})` : ""}: {item.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {valid ? <p role="status" className="text-sm text-ink-soft">All {pending.length} rows are valid. Enrol them to continue.</p> : null}
      {stale ? <p role="status" className="text-sm text-ink-soft">The list changed since it was checked. Check it again before enrolling.</p> : null}
      {error ? <p role="alert" className="text-sm text-vermilion-deep">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-3">
          <Checkbox id={`${idPrefix}-invite`} checked={invite} onCheckedChange={(value) => setInvite(value === true)} />
          <Label htmlFor={`${idPrefix}-invite`} className="font-sans text-sm normal-case tracking-normal">
            Send invite emails
          </Label>
        </div>
        <Button variant="secondary" disabled={pending.length === 0} loading={checking} onClick={validate}>
          Check rows
        </Button>
        <Button disabled={!valid} loading={enrolling} onClick={enrol}>
          Enrol {pending.length > 0 ? pending.length : ""} {pending.length === 1 ? "candidate" : "candidates"}
        </Button>
      </div>
      <p className="text-sm text-ink-muted">
        Candidates get a personal account. With invites on, each new candidate gets a link to set a password.
      </p>
    </div>
  );
}

/** Invite links, shown once. Each one has a copy button. */
function InviteLinks({ links, onDismiss }: { links: Array<{ email: string; url: string }>; onDismiss: () => void }) {
  const idPrefix = useId();
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(url: string, email: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(email);
      setTimeout(() => setCopied((value) => (value === email ? null : value)), 2000);
    } catch {
      setCopied(null);
    }
  }

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="grid gap-6 border-l-2 border-ink pl-6">
      <div className="grid gap-2">
        <h2 id={`${idPrefix}-heading`} className="font-mono text-[11px] tracking-[0.14em] uppercase">
          03 / Invite links
        </h2>
        <p className="text-ink-soft">
          Shown once. Links are also emailed when email is configured.
        </p>
      </div>
      <ul className="grid gap-4">
        {links.map((link) => (
          <li key={link.email} className="grid gap-2 border-t border-rule pt-4 md:grid-cols-[1fr_auto] md:items-end">
            <div className="grid min-w-0 gap-2">
              <span className="text-sm font-medium break-all">{link.email}</span>
              <input
                readOnly
                value={link.url}
                aria-label={`Invite link for ${link.email}`}
                onFocus={(event) => event.currentTarget.select()}
                className="h-10 w-full min-w-0 border border-rule bg-paper-raised px-3 font-mono text-xs text-current outline-none focus-visible:outline-2 focus-visible:outline-vermilion"
              />
            </div>
            <Button variant="secondary" size="sm" onClick={() => copy(link.url, link.email)} aria-label={`Copy invite link for ${link.email}`}>
              {copied === link.email ? "Copied" : "Copy link"}
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
