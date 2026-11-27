"use client";

import { useId, useState, type FormEvent } from "react";
import { api } from "@/lib/api/client";
import { describeError } from "@/lib/errors/describe";
import { namedFieldError } from "@/features/admin/errors";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { needsStepUp, ROLE_CHOICES, ROLE_LABEL, toApiRole, type UserRole } from "./roles";
import { StepUpDialog } from "./step-up-dialog";

const selectClass =
  "h-12 w-full border border-rule bg-paper-raised px-3 font-sans text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion";

const FIELDS = ["email", "displayName", "role"] as const;
type Field = (typeof FIELDS)[number];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CreateResult = { inviteUrl?: string; inviteLink?: string };

/**
 * Creates an account with no password. The admin gets a one-time invite link to pass on, and the
 * person sets their own password through it.
 */
export function CreateAccount({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("candidate");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const toast = useToast();
  const ids = useId();

  function validate(): Partial<Record<Field, string>> {
    const next: Partial<Record<Field, string>> = {};
    const address = email.trim();
    if (!EMAIL.test(address) || address.length > 254) next.email = "Enter a valid email address.";
    const name = displayName.trim();
    if (name.length < 1 || name.length > 100) next.displayName = "Enter a name of up to 100 characters.";
    return next;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const problems = validate();
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;

    setLink(null);
    await createAccount({ email: email.trim(), displayName: displayName.trim(), role });
  }

  async function createAccount(details: { email: string; displayName: string; role: UserRole }) {
    setBusy(true);
    try {
      const result = await api<CreateResult>("/admin/users", {
        body: { email: details.email, displayName: details.displayName, role: toApiRole(details.role) },
      });
      const url = result?.inviteUrl ?? result?.inviteLink ?? null;
      setLink(url);
      setEmail("");
      setDisplayName("");
      setErrors({});
      toast.success(`${ROLE_LABEL[details.role]} account created.`);
      onCreated();
    } catch (cause) {
      if (needsStepUp(cause)) {
        setStepUp(true);
      } else {
        const named = namedFieldError(cause, FIELDS);
        if (named) setErrors({ [named.field]: named.message });
        else toast.error(describeError(cause, { context: "action" }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby={`${ids}-heading`} className="grid gap-6 border border-rule p-5 md:p-6">
      <div>
        <h2 id={`${ids}-heading`} className="font-mono text-[11px] tracking-[0.14em] uppercase">
          Create account
        </h2>
        <p className="mt-2 max-w-prose text-sm text-ink-soft">
          The person sets their own password from the invite link. Share the link privately, and it is shown only once.
        </p>
      </div>

      <form onSubmit={submit} noValidate className="grid gap-5 md:grid-cols-[2fr_2fr_1fr_auto] md:items-start">
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-email`}>Email</Label>
          <Input
            id={`${ids}-email`}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? `${ids}-email-error` : undefined}
          />
          <FieldError id={`${ids}-email-error`} message={errors.email} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-name`}>Display name</Label>
          <Input
            id={`${ids}-name`}
            autoComplete="off"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={errors.displayName ? true : undefined}
            aria-describedby={errors.displayName ? `${ids}-name-error` : undefined}
          />
          <FieldError id={`${ids}-name-error`} message={errors.displayName} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-role`}>Role</Label>
          <select
            id={`${ids}-role`}
            className={selectClass}
            value={role}
            onChange={(event) => setRole(event.target.value as UserRole)}
            aria-invalid={errors.role ? true : undefined}
          >
            {ROLE_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {ROLE_LABEL[choice]}
              </option>
            ))}
          </select>
          <FieldError id={`${ids}-role-error`} message={errors.role} />
        </div>
        <Button type="submit" loading={busy} size="md" className="md:mt-7">
          Create account
        </Button>
      </form>

      {link && (
        <div role="status" className="grid gap-3 border border-ink p-4">
          <p className="font-mono text-[11px] tracking-[0.12em] uppercase">Invite link</p>
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <Input readOnly value={link} aria-label="Invite link" className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
            <Button variant="secondary" size="sm" onClick={() => void copyLink()} aria-label={copied ? "Invite link copied" : "Copy invite link"}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
          <p className="text-xs text-ink-muted">This link is shown once. Create a new account to get another.</p>
        </div>
      )}

      {stepUp && (
        <StepUpDialog
          onCancel={() => setStepUp(false)}
          onVerified={() => {
            setStepUp(false);
            void createAccount({ email: email.trim(), displayName: displayName.trim(), role });
          }}
        />
      )}
    </section>
  );
}
