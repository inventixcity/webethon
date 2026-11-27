import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { boxField } from "./field-styles";

type SelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  /** Classes for the wrapper, which sizes the control. `className` goes on the select itself. */
  wrapperClassName?: string;
  size?: "sm" | "md";
};

/**
 * A native select in the boxed field style, with a square chevron. Native on purpose: it is accessible on every
 * platform and uses the phone's own picker.
 */
function Select({ className, wrapperClassName, size = "md", children, ...props }: SelectProps) {
  return (
    <div data-slot="select" className={cn("relative w-full min-w-0", wrapperClassName)}>
      <select
        className={cn(boxField, "cursor-pointer appearance-none pr-10 pl-3", size === "sm" ? "h-10 text-sm" : "h-12", className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink-soft"
      />
    </div>
  );
}

export { Select };
