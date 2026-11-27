"use client";

import { OTPInputContext, REGEXP_ONLY_DIGITS } from "input-otp";
import { type ReactNode, useContext, useEffect, useRef } from "react";
import { InputOTP, InputOTPGroup } from "@/components/ui/input-otp";
import { cn } from "@/lib/utils";
import { PasswordLock, type PasswordLockState } from "./password-lock";

export type CodeLockFieldProps = {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  /** Characters in the code: 12 for a certificate, 6 for an email code. */
  length: number;
  /** Cells per group. A hairline separates the groups, so 12 characters read as XXXX-XXXX-XXXX. */
  groupSize: number;
  /** Digits only. Otherwise letters and digits, without the look-alike letters. */
  numeric?: boolean;
  /** Drives the padlock beside the cells: "pending" turns it, "ok" opens it. */
  state?: PasswordLockState;
  /** Bump to shake the whole row, once per wrong attempt. 0 never shakes. */
  shakeKey?: number;
  id?: string;
  /** Accessible name of the one input. */
  label: string;
  describedBy?: string;
  invalid?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
};

/** Keeps only the characters a certificate code can contain. */
export function normaliseCode(raw: string, numeric = false): string {
  const pattern = numeric ? /[^0-9]/g : /[^0-9A-HJKMNPQRSTVWXYZ]/gi;
  return raw.toUpperCase().replace(pattern, "");
}

function Cell({ index }: { index: number }) {
  const context = useContext(OTPInputContext);
  const slot = context?.slots[index];
  return (
    <div
      data-active={slot?.isActive || undefined}
      data-filled={slot?.char ? true : undefined}
      className="relative grid h-11 w-7 place-items-center border border-rule bg-paper-raised font-mono text-base font-medium uppercase sm:h-12 sm:text-lg data-[active=true]:z-10 data-[active=true]:border-cobalt data-[active=true]:outline-2 data-[active=true]:-outline-offset-2 data-[active=true]:outline-focus data-[filled=true]:border-ink"
    >
      {slot?.char}
      {slot?.hasFakeCaret ? (
        <span aria-hidden="true" className="absolute inset-x-2 bottom-2 h-0.5 animate-blink bg-cobalt" />
      ) : null}
    </div>
  );
}

/**
 * A combination-lock entry: a padlock that turns while the code is checked and opens on a valid one, beside a
 * segmented input of square cells. It is one labelled input under the cells, so keyboard, paste and screen readers
 * all use the same field. A wrong attempt shakes the row (transform only, and never under reduced motion).
 */
export function CodeLockField({
  value,
  onChange,
  onComplete,
  length,
  groupSize,
  numeric = false,
  state = "idle",
  shakeKey = 0,
  id,
  label,
  describedBy,
  invalid,
  autoFocus,
  disabled,
  className,
}: CodeLockFieldProps) {
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = row.current;
    if (!shakeKey || !element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = element.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-8px)" },
        { transform: "translateX(8px)" },
        { transform: "translateX(-5px)" },
        { transform: "translateX(5px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 380, easing: "ease-out" },
    );
    return () => animation.cancel();
  }, [shakeKey]);

  const groups: ReactNode[] = [];
  for (let start = 0; start < length; start += groupSize) {
    if (start > 0) {
      groups.push(<span key={`sep-${start}`} aria-hidden="true" className="mx-1 h-px w-2 bg-ink-muted" />);
    }
    groups.push(
      <InputOTPGroup key={start} aria-hidden="true" className="gap-0.5">
        {Array.from({ length: groupSize }, (_, offset) => (
          <Cell key={start + offset} index={start + offset} />
        ))}
      </InputOTPGroup>,
    );
  }

  return (
    <div ref={row} className={cn("flex items-center gap-4", className)}>
      <PasswordLock length={value.length} total={length} state={state} className="size-16 shrink-0 sm:size-20" />
      <InputOTP
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        maxLength={length}
        value={value}
        onChange={(next) => onChange(normaliseCode(next, numeric))}
        onComplete={onComplete}
        pattern={numeric ? REGEXP_ONLY_DIGITS : "[0-9A-Za-z]"}
        // Pasted text is cleaned first, so "ABCD-EFGH-JKMN" fills all twelve cells.
        pasteTransformer={(text) => normaliseCode(text, numeric)}
        inputMode={numeric ? "numeric" : "text"}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
      >
        {groups}
      </InputOTP>
    </div>
  );
}
