"use client";

import { useId } from "react";
import { FieldError } from "@/components/auth/field";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type SelectFieldProps = React.ComponentProps<"select"> & {
  label: string;
  error?: string;
  /** Keeps the label for screen readers only, for compact rows. */
  hideLabel?: boolean;
};

/** A native select drawn like the text fields, so forms look the same. */
export function SelectField({ label, error, hideLabel = false, className, id, children, ...props }: SelectFieldProps) {
  const fallbackId = useId();
  const fieldId = id ?? fallbackId;
  const errorId = `${fieldId}-error`;

  return (
    <div className={cn("group/field min-w-0", className)}>
      <Label htmlFor={fieldId} className={cn(hideLabel && "sr-only")}>
        {label}
      </Label>
      <div className="relative">
        <select
          id={fieldId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="h-12 w-full min-w-0 cursor-pointer border-0 border-b border-current/30 bg-paper-raised font-mono text-sm tracking-[0.06em] text-current uppercase outline-none transition-colors duration-(--duration-base) hover:border-current/60 focus-visible:border-ink disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-vermilion"
          {...props}
        >
          {children}
        </select>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-vermilion transition-transform duration-(--duration-slow) ease-(--ease-enter) group-focus-within/field:scale-x-100"
        />
      </div>
      <FieldError id={errorId} message={error} />
    </div>
  );
}
