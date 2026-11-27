import type { ReactNode } from "react";
import { ScrambleLabel } from "@/components/loaders/text-loaders";
import { Skeleton } from "@/components/loaders/shape-loaders";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { messageFor } from "@/lib/errors/describe";
import { cn } from "@/lib/utils";

/** Placeholder rows in the shape of the content, so the page does not jump when the data lands. */
export function LoadingState({ label = "Loading", rows = 3, className }: { label?: string; rows?: number; className?: string }) {
  return (
    <div role="status" aria-label={label} className={cn("grid gap-3 py-6", className)}>
      <div className="flex items-center gap-3 pb-2 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
        <ScrambleLabel text={label} />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={cn("h-14 w-full", rows > 1 && index === rows - 1 && "w-3/4")} />
      ))}
    </div>
  );
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 404 || cause.code === "NOT_FOUND");
}

/**
 * A failure inside a page: what failed, in plain words, and a retry. A 404 reads as "not found or not yours",
 * the same answer the API gives, so the screen never reveals that something exists.
 */
export function ErrorState({
  error,
  onRetry,
  title,
  notFoundMessage = "It doesn't exist, or you don't have access to it.",
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  notFoundMessage?: string;
  className?: string;
}) {
  const notFound = isNotFound(error);
  return (
    <div
      role="alert"
      className={cn("grid max-w-[62ch] justify-items-start gap-4 border-l-2 border-vermilion-deep py-2 pl-5", className)}
    >
      <p className="font-mono text-[11px] tracking-[0.14em] text-vermilion-deep uppercase">
        {notFound ? "Not found" : "Could not load"}
      </p>
      {title ? <p className="text-xl font-medium tracking-[-0.02em]">{title}</p> : null}
      <p className="text-base text-ink-soft">{notFound ? notFoundMessage : messageFor(error)}</p>
      {!notFound && onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** A short status line under a heading, for example "Could not refresh. Showing the last update." */
export function Notice({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "warning";
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn(
        "border-l-2 py-1 pl-4 text-sm",
        tone === "warning" ? "border-amber text-ink" : "border-cobalt text-ink-soft",
        className,
      )}
    >
      {children}
    </p>
  );
}
