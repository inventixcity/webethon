import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-12 w-full min-w-0 border-0 border-b border-current/30 bg-transparent text-base text-current caret-vermilion outline-none transition-colors duration-300 placeholder:font-sans placeholder:tracking-normal placeholder:text-current/35 hover:border-current/60 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-vermilion [&[type=password]]:font-mono [&[type=password]]:tracking-[0.18em]",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
