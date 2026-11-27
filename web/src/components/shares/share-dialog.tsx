"use client";

import { useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { ErrorPage } from "@/components/errors/error-page";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { createShare, type CreatedShare } from "@/features/shares/client";
import type { ErrorView } from "@/lib/errors";
import { useReportError } from "@/lib/errors/use-report-error";

export type ShareDialogProps = {
  entity: string;
  recordId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const EXPIRY_OPTIONS = [1, 7, 30, 90] as const;
const DEFAULT_EXPIRY = 30;

/**
 * Creates a public link to one record. The link carries a secret token: it is shown once, with a copy
 * button, and is never stored or logged.
 */
export function ShareDialog({ entity, recordId, open, onOpenChange }: ShareDialogProps) {
  // Resets on every open: the form and the link live in the dialog's content, which unmounts on close.
  const [expiresInDays, setExpiresInDays] = useState<number>(DEFAULT_EXPIRY);
  const [busy, setBusy] = useState(false);
  const [expiryError, setExpiryError] = useState<string | undefined>();
  const [share, setShare] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [fatal, setFatal] = useState<ErrorView | null>(null);
  const toast = useToast();
  const report = useReportError();

  function handleOpenChange(next: boolean) {
    // Closing during a request would drop the link the server just made, so the dialog stays open.
    if (!next && busy) return;
    if (!next) {
      setExpiresInDays(DEFAULT_EXPIRY);
      setExpiryError(undefined);
      setShare(null);
      setCopied(false);
      setFatal(null);
    }
    onOpenChange(next);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setExpiryError(undefined);
    setFatal(null);
    try {
      const created: CreatedShare = await createShare({ entity, recordId, expiresInDays });
      setShare({ url: absoluteUrl(created.url), expiresAt: created.expiresAt });
    } catch (error) {
      // A field error sits by the select. A transient one is a toast (report shows it). A fatal one replaces the dialog.
      const view = report(error, { context: "form", fields: ["expiresInDays"] });
      if (view.kind === "field") setExpiryError(view.message);
      if (view.kind === "page") setFatal(view);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
    } catch {
      toast.error("Could not copy. Select the link and copy it by hand.");
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-y-auto border-t border-ink bg-paper p-6 text-ink sm:inset-x-auto sm:top-1/2 sm:left-1/2 sm:bottom-auto sm:w-[min(32rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:border sm:p-8">
          {fatal ? (
            <>
              <Dialog.Title className="sr-only">Share this record</Dialog.Title>
              <ErrorPage
              as="div"
              code={fatal.page}
              requestId={fatal.requestId}
              retryAfterSeconds={fatal.retryAfterSeconds}
                onRetry={() => setFatal(null)}
              />
            </>
          ) : (
            <>
              <p className="font-mono text-xs uppercase tracking-widest text-ink-muted">Record / Share</p>
              <Dialog.Title className="mt-3 text-3xl font-medium tracking-[-0.02em]">Share this record</Dialog.Title>
              <Dialog.Description className="mt-3 text-ink-soft">
                Anyone with the link can read this record&apos;s fields until the link expires. They don&apos;t need an
                account.
              </Dialog.Description>

              {share === null ? (
                <form onSubmit={create} className="mt-8 grid gap-6">
                  <div className="grid gap-2">
                    <label htmlFor="share-expiry" className="font-mono text-xs uppercase tracking-widest">
                      Link expires after
                    </label>
                    <select
                      id="share-expiry"
                      value={expiresInDays}
                      disabled={busy}
                      aria-invalid={expiryError ? true : undefined}
                      aria-describedby={expiryError ? "share-expiry-error" : undefined}
                      onChange={(event) => setExpiresInDays(Number(event.target.value))}
                      className="block h-12 w-full border border-ink bg-paper-raised px-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
                    >
                      {EXPIRY_OPTIONS.map((days) => (
                        <option key={days} value={days}>
                          {days === 1 ? "1 day" : `${days} days`}
                        </option>
                      ))}
                    </select>
                    <FieldError id="share-expiry-error" message={expiryError} />
                  </div>
                  <div className="flex flex-wrap justify-end gap-3">
                    <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)} disabled={busy}>
                      Cancel
                    </Button>
                    <Button type="submit" loading={busy}>
                      Create link
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="mt-8 grid gap-6">
                  <div className="grid gap-2">
                    <label htmlFor="share-url" className="font-mono text-xs uppercase tracking-widest">
                      Public link
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="share-url"
                        readOnly
                        value={share.url}
                        onFocus={(event) => event.currentTarget.select()}
                        className="h-12 min-w-0 flex-1 border border-ink bg-paper-raised px-3 font-mono text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
                      />
                      <Button variant="secondary" onClick={() => void copy()}>
                        {copied ? "Copied" : "Copy link"}
                      </Button>
                    </div>
                    <p role="status" className="text-sm text-ink-muted">
                      Expires on {formatDate(share.expiresAt)}.
                    </p>
                  </div>
                  <p className="border border-ink p-4 text-sm">
                    <strong className="font-medium">Copy this link now.</strong> For security it won&apos;t be shown again.
                    If you lose it, create a new link.
                  </p>
                  <div className="flex justify-end">
                    <Button variant="secondary" onClick={() => handleOpenChange(false)}>
                      Done
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The server's URL, made absolute against this origin when it is a path. */
function absoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "the chosen date"
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
