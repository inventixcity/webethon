"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type SecretPanelProps = {
  /** What the secret is for, for example "Signing secret for https://example.com/hook". */
  title: string;
  secret: string;
  /** Clears the secret from the screen. The panel never keeps it anywhere else. */
  onDone: () => void;
};

/**
 * Shows a signing secret exactly once. It lives only in the parent's state, so it is gone on dismiss or
 * on navigation. Nothing here writes it to storage or logs it.
 */
export function SecretPanel({ title, secret, onDone }: SecretPanelProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopyFailed(false);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <section aria-label={title} className="grid gap-5 border border-vermilion-deep bg-paper p-5">
      <div className="grid gap-2">
        <p className="font-mono text-[11px] tracking-[0.12em] text-vermilion-deep uppercase">{title}</p>
        <p className="font-medium">Copy it now. It won&apos;t be shown again.</p>
        <p className="text-sm text-ink-soft">
          Store it where your server can read it. You need it to check the signature on every delivery. If you lose
          it, rotate the secret to get a new one.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
        <code className="min-w-0 border border-rule bg-paper-raised px-3 py-3 font-mono text-sm break-all text-ink select-all">
          {secret}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy secret"}
        </Button>
      </div>

      {copyFailed ? (
        <p role="status" className="font-mono text-[11px] tracking-wide">
          The browser blocked copying. Select the secret above and copy it by hand.
        </p>
      ) : (
        <span role="status" className="sr-only">
          {copied ? "Secret copied to the clipboard" : ""}
        </span>
      )}

      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          I&apos;ve saved it
        </Button>
      </div>
    </section>
  );
}
