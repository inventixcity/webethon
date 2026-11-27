"use client";

import { useId, useState } from "react";
import { formatDateTime } from "@/components/analytics/format";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { messageFor } from "@/lib/errors/describe";

/** What the reset-access calls return. The link is shown once, and nothing is emailed. */
export type IssuedAccessLink = { inviteUrl: string; expiresAt: string };

/**
 * Plain messages for the reset-access calls. 403, 404, 422 and 429 each say what to do next; anything else uses the
 * shared error mapping.
 */
export function resetAccessMessage(cause: unknown, scope: "account" | "candidate"): string {
  if (cause instanceof ApiError) {
    if (cause.status === 403) return "You don't have permission to reset this person's access.";
    if (cause.status === 404) {
      return scope === "candidate"
        ? "This person isn't enrolled in this exam, so their access can't be reset here."
        : "This account can't be found. It may have been deleted.";
    }
    if (cause.status === 422) {
      return scope === "candidate"
        ? "Their access can't be reset right now. Check the enrolment and try again."
        : "You can't reset your own access, and the last other admin account has to stay. Choose a different account.";
    }
    if (cause.status === 429) {
      const minutes = cause.retryAfter ? Math.max(1, Math.ceil(cause.retryAfter / 60)) : null;
      return minutes
        ? `Too many access resets in the last hour. Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`
        : "Too many access resets in the last hour. Try again later.";
    }
  }
  return messageFor(cause);
}

/**
 * The new access link, shown once with a copy button and its expiry. The admin or examiner hands it over; no email
 * is sent.
 */
export function AccessLinkReveal({
  email,
  link,
  onDismiss,
}: {
  email: string;
  link: IssuedAccessLink;
  onDismiss: () => void;
}) {
  const idPrefix = useId();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="grid gap-5 border-l-2 border-ink pl-6">
      <div className="grid gap-2">
        <h2 id={`${idPrefix}-heading`} className="font-mono text-[11px] tracking-[0.14em] uppercase">
          New access link
        </h2>
        <p className="text-ink-soft">
          For <span className="font-medium break-all">{email}</span>. Shown once: copy it now and give it to them yourself.
          No email is sent. The link expires {formatDateTime(link.expiresAt)}.
        </p>
      </div>
      <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
        <input
          readOnly
          value={link.inviteUrl}
          aria-label={`New access link for ${email}`}
          onFocus={(event) => event.currentTarget.select()}
          className="h-10 w-full min-w-0 border border-rule bg-paper-raised px-3 font-mono text-xs text-current outline-none focus-visible:outline-2 focus-visible:outline-vermilion"
        />
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      <p role="status" className="sr-only">
        {copied ? "Access link copied." : ""}
      </p>
      <div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
