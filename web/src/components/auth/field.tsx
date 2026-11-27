"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type FieldProps = React.ComponentProps<"input"> & {
  label: string;
  error?: string;
  /** Sits at the right of the label, for example a "Forgot it?" link. */
  action?: React.ReactNode;
  /** Sits inside the input at the right edge, for example a show password toggle. */
  trailing?: React.ReactNode;
  /** Classes for the input itself, for example to set oversized type. */
  inputClassName?: string;
};

export function Field({
  label,
  error,
  action,
  trailing,
  className,
  inputClassName,
  id,
  ...props
}: FieldProps) {
  const fallbackId = useId();
  const fieldId = id ?? fallbackId;
  const errorId = `${fieldId}-error`;

  return (
    <div className={cn("group/field", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <Label htmlFor={fieldId}>
          {label}
          {props.required ? <span aria-hidden="true" className="ml-1 text-vermilion-deep">*</span> : null}
        </Label>
        {action}
      </div>
      <div className="relative">
        <Input
          id={fieldId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={inputClassName}
          {...props}
        />
        {trailing && <div className="absolute inset-y-0 right-0 flex items-center">{trailing}</div>}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-vermilion transition-transform duration-(--duration-slow) ease-(--ease-enter) motion-reduce:transition-none group-focus-within/field:scale-x-100"
        />
      </div>
      <FieldError id={errorId} message={error} />
    </div>
  );
}

export function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;

  return (
    <p id={id} role="alert" className="mt-2 flex items-center gap-2 font-mono text-[11px] tracking-wide">
      <span aria-hidden="true" className="size-1.5 shrink-0 bg-vermilion" />
      {message}
    </p>
  );
}

type PasswordFieldProps = Omit<FieldProps, "type" | "trailing"> & {
  /** Called when the visitor shows or hides what they typed. */
  onVisibleChange?: (visible: boolean) => void;
};

export function PasswordField({ inputClassName, onVisibleChange, ...props }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <Field
      type={visible ? "text" : "password"}
      inputClassName={cn("pr-16", inputClassName)}
      trailing={
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            setVisible(!visible);
            onVisibleChange?.(!visible);
          }}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className="min-h-11 min-w-11 px-2 font-mono text-[11px] tracking-[0.12em] no-underline overflow-visible transition-colors duration-(--duration-fast) ease-(--ease-enter) motion-reduce:transition-none hover:text-current hover:no-underline"
        >
          {visible ? "Hide" : "Show"}
        </Button>
      }
      {...props}
    />
  );
}
