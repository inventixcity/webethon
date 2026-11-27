"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { InputOTP, InputOTPSlot } from "@/components/ui/input-otp";
import { cn } from "@/lib/utils";

export type CodeGridProps = {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  /** Characters in the code: 12 for a certificate, 6 for an email code. */
  length: number;
  /**
   * Cells per group. Groups sit side by side on laptops and stack as rows on phones, so 12 cells in groups of 4
   * read as XXXX-XXXX-XXXX. Leave it out for one group.
   */
  groupSize?: number;
  /** Digits only. Otherwise letters and digits, without the look-alike letters. */
  numeric?: boolean;
  /**
   * "display" fills the width with large characters (reset codes). "compact" fits a narrow column (certificate
   * codes), so the cells shrink while the grid keeps its shape.
   */
  size?: "display" | "compact";
  /** Pulses the grid while a check is running. */
  checking?: boolean;
  /** Fills the cells in the verified colour, with a cascade from left to right. */
  verified?: boolean;
  /** Change it once per wrong attempt and the row shakes. 0 never shakes. */
  shakeKey?: number;
  id?: string;
  /** Accessible name of the one input under the cells. */
  label: string;
  describedBy?: string;
  invalid?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
};

/** Keeps only the characters a code can contain. */
export function normaliseCode(raw: string, numeric = false): string {
  const pattern = numeric ? /[^0-9]/g : /[^0-9A-HJKMNPQRSTVWXYZ]/gi;
  return raw.toUpperCase().replace(pattern, "");
}

// The same cell as the reset-code design: a bordered row of cells, the active one paper-raised, a filled one inverted.
// In dark mode bg-ink resolves to the graphite fill (see globals.css), and the text is on-fill ivory.
const cellBase =
  "leading-none transition-colors duration-(--duration-slow) data-[active]:bg-paper-raised data-[filled]:bg-ink data-[filled]:text-on-fill";

const cellSize = {
  display: "aspect-square text-[clamp(2.25rem,9vw,8.5rem)] md:aspect-auto md:h-[clamp(5.5rem,24dvh,15rem)]",
  compact: "aspect-[4/5] text-[2.25rem] sm:text-[clamp(1.5rem,3.2vw,3rem)]",
} as const;

/**
 * A segmented code entry. The cells sit in a bordered row, with one input under them, so keyboard, paste and screen
 * readers all use the same field. A paste of the whole code (with or without dashes) fills every cell. A changed
 * shakeKey shakes the row (transform only, and never under reduced motion).
 */
export function CodeGrid({
  value,
  onChange,
  onComplete,
  length,
  groupSize,
  numeric = false,
  size = "display",
  checking = false,
  verified = false,
  shakeKey = 0,
  id,
  label,
  describedBy,
  invalid,
  autoFocus,
  disabled,
  className,
}: CodeGridProps) {
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

  const perGroup = groupSize ?? length;
  const groups: ReactNode[] = [];
  for (let start = 0; start < length; start += perGroup) {
    const count = Math.min(perGroup, length - start);
    groups.push(
      <div
        key={start}
        className="grid min-w-0 divide-x divide-ink border-y border-ink sm:flex-1"
        style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` } satisfies CSSProperties}
      >
        {Array.from({ length: count }, (_, offset) => {
          const index = start + offset;
          return (
            <InputOTPSlot
              key={index}
              index={index}
              style={{ transitionDelay: verified ? `${index * 60}ms` : undefined }}
              className={cn(
                cellBase,
                cellSize[size],
                verified && "bg-vermilion-deep! text-on-fill!",
              )}
            />
          );
        })}
      </div>,
    );
  }

  return (
    <InputOTP
      id={id}
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      autoFocus={autoFocus}
      disabled={disabled}
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
      containerClassName="block w-full has-disabled:opacity-100"
      className={className}
    >
      <div
        ref={row}
        className={cn(
          "flex w-full flex-col gap-2.5 sm:flex-row sm:gap-4",
          checking && "animate-pulse motion-reduce:animate-none",
        )}
      >
        {groups}
      </div>
    </InputOTP>
  );
}
