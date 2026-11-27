import type * as React from "react";
import { cn } from "@/lib/utils";
import { boxField } from "./field-styles";

const underline =
  "h-12 w-full min-w-0 border-0 border-b border-current/70 bg-transparent text-base text-current caret-vermilion outline-none transition-colors duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus placeholder:font-sans placeholder:tracking-normal placeholder:text-current/60 hover:border-current/60 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-vermilion [&[type=password]]:font-mono [&[type=password]]:tracking-[0.18em]";

type InputProps = React.ComponentProps<"input"> & {
  /** "line" is the underlined sign-in look. "box" is the square field used across the app. */
  variant?: "line" | "box";
  /** Box variant only. */
  inputSize?: "sm" | "md";
};

function Input({ className, type, variant = "line", inputSize = "md", ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        variant === "box" ? cn(boxField, "px-3 caret-vermilion", inputSize === "sm" ? "h-10 text-sm" : "h-12") : underline,
        className,
      )}
      {...props}
    />
  );
}

export { Input };
