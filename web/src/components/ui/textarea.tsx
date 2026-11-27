import type * as React from "react";
import { cn } from "@/lib/utils";
import { boxField } from "./field-styles";

/** A multi-line field in the boxed style. Grows by dragging; never by itself, so layouts do not jump. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(boxField, "min-h-28 resize-y p-3 leading-relaxed caret-vermilion", className)}
      {...props}
    />
  );
}

export { Textarea };
