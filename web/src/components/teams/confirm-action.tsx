"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type ConfirmActionProps = {
  /** The button that asks for confirmation, for example "Remove". */
  label: string;
  /** The question shown beside the confirm button, which says what will happen. */
  question: string;
  /** The button that actually does it, for example "Remove member". */
  confirmLabel: string;
  /** Runs the action. It must handle its own errors, so this never rejects. */
  onConfirm: () => Promise<void>;
  pending?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger";
};

/**
 * A two-step button for anything that removes access. The first press only asks, so a stray click
 * can't remove someone. Keyboard and screen reader users get the question as a labelled group.
 */
export function ConfirmAction({
  label,
  question,
  confirmLabel,
  onConfirm,
  pending = false,
  disabled = false,
  tone = "default",
}: ConfirmActionProps) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <Button
        type="button"
        variant={tone === "danger" ? "danger" : "secondary"}
        size="sm"
        disabled={disabled || pending}
        onClick={() => setAsking(true)}
      >
        {label}
      </Button>
    );
  }

  return (
    <div role="group" aria-label={question} className="flex flex-wrap items-center gap-3">
      <span className="font-mono text-[11px] tracking-wide">{question}</span>
      <Button
        type="button"
        variant="danger"
        size="sm"
        loading={pending}
        disabled={pending}
        onClick={async () => {
          await onConfirm();
          setAsking(false);
        }}
      >
        {pending ? "Working" : confirmLabel}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </div>
  );
}
