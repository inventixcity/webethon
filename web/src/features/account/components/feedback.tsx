import type { Ref } from "react";
import { cn } from "@/lib/utils";

type FeedbackProps = {
  message?: string;
  tone?: "info" | "error";
  ref?: Ref<HTMLDivElement>;
};

/**
 * The outcome of an action. The region is always in the DOM so screen readers announce changes, and it
 * can take focus, so the person lands on the result after pressing a button.
 */
export function Feedback({ message, tone = "info", ref }: FeedbackProps) {
  return (
    <div ref={ref} tabIndex={-1} aria-live="polite" className="min-h-5 font-mono text-[11px] tracking-wide">
      {message && (
        <p className="flex items-center gap-2">
          <span aria-hidden="true" className={cn("size-1.5 shrink-0", tone === "error" ? "bg-vermilion" : "bg-ink")} />
          {message}
        </p>
      )}
    </div>
  );
}
