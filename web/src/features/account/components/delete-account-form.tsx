"use client";

import { useState, type FormEvent } from "react";
import { Field } from "@/components/auth/field";
import { SubmitButton } from "@/components/auth/submit-button";
import { useToast } from "@/components/feedback/toaster";
import { deleteAccount } from "../client";
import { toastFor } from "../errors";

type DeleteAccountFormProps = {
  /** The address the person must type exactly before the delete button works. */
  email: string;
};

export function DeleteAccountForm({ email }: DeleteAccountFormProps) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const confirmed = typed === email;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || pending) return;

    setPending(true);

    try {
      await deleteAccount();
    } catch (cause) {
      setPending(false);
      toast.error(toastFor(cause));
      return;
    }
    // The account is gone and every session with it, so the sign-in page is the only place to go.
    window.location.assign("/login");
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid max-w-xl gap-6">
      <p className="text-ink-soft">
        This deletes your profile and signs you out on every device. It can&apos;t be undone.
      </p>

      <Field
        label="Type your email to confirm"
        type="email"
        autoComplete="off"
        spellCheck={false}
        value={typed}
        disabled={pending}
        onChange={(event) => setTyped(event.target.value)}
        aria-describedby="delete-account-hint"
      />
      <p id="delete-account-hint" className="font-mono text-[11px] tracking-wide break-all text-ink-muted">
        Enter <span className="text-ink">{email}</span> exactly as shown.
      </p>

      <div>
        <SubmitButton
          variant="danger"
          pending={pending}
          pendingLabel="Deleting account"
          disabled={!confirmed || pending}
        >
          Delete account
        </SubmitButton>
      </div>
    </form>
  );
}
