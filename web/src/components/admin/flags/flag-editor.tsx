"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { ConfirmDialog, Drawer, StepUpModal } from "@/components/admin/workspace";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { isStepUpRequired } from "@/features/admin/client";
import { actionToast, namedFieldError } from "@/features/admin/errors";
import { deleteFlag, putFlag, type AdminFlag, type FlagInput } from "@/features/flags/client";
import {
  FLAG_KEY_MESSAGE,
  isValidEmail,
  isValidFlagKey,
  parseEmails,
  parseList,
  parseRollout,
  parseValue,
  VALUE_MAX_BYTES,
} from "@/features/flags/rules";

const FIELDS = ["key", "description", "enabled", "rollout", "allowEmails", "allowTeams", "value"] as const;
type Field = (typeof FIELDS)[number];
type Errors = Partial<Record<Field, string>>;

/** Form state. Lists and the value are text until they are parsed on save. */
type Draft = {
  key: string;
  description: string;
  enabled: boolean;
  rollout: string;
  allowEmails: string;
  allowTeams: string;
  value: string;
};

/** Hints under each field. Each one is also linked to its control through aria-describedby. */
const HINT = {
  key: "Lowercase letters, digits, dots and dashes.",
  keyLocked: "A key can't be changed. Create a new flag for another key.",
  rollout: "Share of viewers who get the flag when it's enabled. Stable per person.",
  emails: "Separate addresses with commas or new lines. These accounts always get the flag.",
  teams: "Team IDs, separated by commas or new lines.",
  value: `Optional. Up to ${VALUE_MAX_BYTES / 1024} KB. Leave blank for no value.`,
} as const;

const fieldClass =
  "w-full min-h-10 border border-ink bg-paper px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion aria-invalid:border-vermilion-deep disabled:opacity-60";

function draftFrom(flag: AdminFlag | null): Draft {
  if (flag === null) {
    return { key: "", description: "", enabled: false, rollout: "100", allowEmails: "", allowTeams: "", value: "" };
  }
  return {
    key: flag.key,
    description: flag.description,
    enabled: flag.enabled,
    rollout: String(flag.rollout),
    allowEmails: flag.allowEmails.join("\n"),
    allowTeams: flag.allowTeams.join("\n"),
    value: flag.value === undefined ? "" : JSON.stringify(flag.value, null, 2),
  };
}

/** Checks every field. Returns the request body only when all of them pass. */
function check(draft: Draft, isNew: boolean, takenKeys: readonly string[]): { errors: Errors; payload: FlagInput | null } {
  const errors: Errors = {};
  const key = draft.key.trim();

  if (isNew) {
    if (key === "") errors.key = "Enter a key for the flag.";
    else if (!isValidFlagKey(key)) errors.key = FLAG_KEY_MESSAGE;
    else if (takenKeys.includes(key)) errors.key = "A flag with this key already exists. Edit it from the list instead.";
  }

  const rollout = parseRollout(draft.rollout);
  if (rollout === null) errors.rollout = "Rollout must be a whole number from 0 to 100.";

  const emails = parseEmails(draft.allowEmails);
  const badEmail = emails.find((email) => !isValidEmail(email));
  if (badEmail !== undefined) errors.allowEmails = `"${badEmail}" isn't a valid email address.`;

  const teams = parseList(draft.allowTeams);

  const value = parseValue(draft.value);
  if (!value.ok) errors.value = value.message;

  if (Object.keys(errors).length > 0 || rollout === null || !value.ok) return { errors, payload: null };

  return {
    errors,
    payload: {
      description: draft.description.trim(),
      enabled: draft.enabled,
      rollout,
      allowEmails: emails,
      allowTeams: teams,
      ...(value.present ? { value: value.value } : {}),
    },
  };
}

/**
 * The editor for one flag, or a new one (flag = null). Save is PUT /admin/flags/:key, and delete is
 * DELETE. Both need step-up: the form stays open, so the same action can be repeated after verifying.
 */
export function FlagEditor({
  flag,
  takenKeys,
  onClose,
  onSaved,
}: {
  flag: AdminFlag | null;
  takenKeys: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isNew = flag === null;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(flag));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState("");

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  const rolloutNumber = parseRollout(draft.rollout);

  async function save(event: FormEvent) {
    event.preventDefault();
    const checked = check(draft, isNew, takenKeys);
    setErrors(checked.errors);
    if (checked.payload === null) return;
    const key = flag ? flag.key : draft.key.trim();

    setBusy(true);
    setNotice("");
    try {
      await putFlag(key, checked.payload);
      toast.success("Flag saved.");
      onSaved();
    } catch (cause) {
      if (isStepUpRequired(cause)) {
        setStepUp(true);
        return;
      }
      const named = namedFieldError(cause, FIELDS);
      if (named) {
        const next: Errors = {};
        next[named.field] = named.message;
        setErrors(next);
        return;
      }
      toast.error(actionToast(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!flag) return;
    setBusy(true);
    try {
      await deleteFlag(flag.key);
      toast.success("Flag deleted.");
      onSaved();
    } catch (cause) {
      if (isStepUpRequired(cause)) {
        setStepUp(true);
        return;
      }
      setConfirmDelete(false);
      toast.error(actionToast(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer title={flag ? flag.key : "New flag"} onClose={onClose}>
      <form onSubmit={save} noValidate className="grid max-w-xl gap-6">
        {notice && <p role="status" className="text-sm text-ink-soft">{notice}</p>}

        <FieldBlock id="flag-key" label="Key" hint={isNew ? HINT.key : HINT.keyLocked} error={errors.key}>
          <input
            id="flag-key"
            name="key"
            type="text"
            autoComplete="off"
            spellCheck={false}
            readOnly={!isNew}
            className={`${fieldClass} font-mono`}
            value={draft.key}
            onChange={(event) => update("key", event.target.value)}
            {...describedBy("flag-key", isNew ? HINT.key : HINT.keyLocked, errors.key)}
          />
        </FieldBlock>

        <FieldBlock id="flag-description" label="Description" error={errors.description}>
          <input
            id="flag-description"
            name="description"
            type="text"
            className={fieldClass}
            value={draft.description}
            onChange={(event) => update("description", event.target.value)}
            {...describedBy("flag-description", undefined, errors.description)}
          />
        </FieldBlock>

        <div className="flex items-center gap-3">
          <Checkbox id="flag-enabled" checked={draft.enabled} onCheckedChange={(checked) => update("enabled", checked === true)} />
          <Label htmlFor="flag-enabled">Enabled</Label>
        </div>

        <FieldBlock id="flag-rollout" label="Rollout (%)" hint={HINT.rollout} error={errors.rollout}>
          <div className="flex items-center gap-4">
            <input
              id="flag-rollout"
              name="rollout"
              type="number"
              min={0}
              max={100}
              step={1}
              inputMode="numeric"
              className={`${fieldClass} w-28 shrink-0`}
              value={draft.rollout}
              onChange={(event) => update("rollout", event.target.value)}
              {...describedBy("flag-rollout", HINT.rollout, errors.rollout)}
            />
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              aria-label="Rollout, drag to set"
              className="min-w-0 flex-1 accent-ink"
              value={rolloutNumber ?? 0}
              onChange={(event) => update("rollout", event.target.value)}
            />
          </div>
        </FieldBlock>

        <FieldBlock id="flag-allow-emails" label="Allowed emails" hint={HINT.emails} error={errors.allowEmails}>
          <textarea
            id="flag-allow-emails"
            name="allowEmails"
            rows={4}
            className={fieldClass}
            value={draft.allowEmails}
            onChange={(event) => update("allowEmails", event.target.value)}
            {...describedBy("flag-allow-emails", HINT.emails, errors.allowEmails)}
          />
        </FieldBlock>

        <FieldBlock id="flag-allow-teams" label="Allowed teams" hint={HINT.teams} error={errors.allowTeams}>
          <textarea
            id="flag-allow-teams"
            name="allowTeams"
            rows={3}
            className={`${fieldClass} font-mono`}
            value={draft.allowTeams}
            onChange={(event) => update("allowTeams", event.target.value)}
            {...describedBy("flag-allow-teams", HINT.teams, errors.allowTeams)}
          />
        </FieldBlock>

        <FieldBlock id="flag-value" label="Value (JSON)" hint={HINT.value} error={errors.value}>
          <textarea
            id="flag-value"
            name="value"
            rows={6}
            spellCheck={false}
            className={`${fieldClass} font-mono`}
            value={draft.value}
            onChange={(event) => update("value", event.target.value)}
            {...describedBy("flag-value", HINT.value, errors.value)}
          />
        </FieldBlock>

        <div className="flex flex-wrap gap-2 border-t border-rule pt-6">
          <Button type="submit" loading={busy} disabled={busy}>
            Save flag
          </Button>
          {!isNew && (
            <Button type="button" variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete flag
            </Button>
          )}
        </div>
      </form>

      {flag && confirmDelete && !stepUp && (
        <ConfirmDialog
          action={{ title: "Delete flag", target: flag.key, path: `/admin/flags/${encodeURIComponent(flag.key)}` }}
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={remove}
        />
      )}
      {stepUp && (
        <StepUpModal
          onCancel={() => {
            setStepUp(false);
            setConfirmDelete(false);
          }}
          onSuccess={() => {
            setStepUp(false);
            setNotice("Identity verified. Confirm or save again to apply the change.");
          }}
        />
      )}
    </Drawer>
  );
}

/** Links a control to its hint and its error, so screen readers announce both. */
function describedBy(id: string, hint: string | undefined, error: string | undefined) {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return {
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": ids || undefined,
  };
}

function FieldBlock({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-ink-muted">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}
