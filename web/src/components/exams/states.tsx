import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/loaders/shape-loaders";
import { messageFor } from "@/lib/errors/describe";
import { isNotFound } from "./format";

export function LoadingState({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="grid gap-3 py-6">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const notFound = isNotFound(error);
  return (
    <div role="alert" className="grid max-w-prose gap-4 border-l-2 border-ink py-2 pl-5">
      <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">{notFound ? "Not found" : "Could not load"}</p>
      <p className="text-base text-ink-soft">
        {notFound ? "This exam doesn't exist, or you don't have access to it." : messageFor(error)}
      </p>
      {!notFound && onRetry ? (
        <Button variant="secondary" size="sm" className="w-fit" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid max-w-prose justify-items-start gap-4 border-t border-rule py-10">
      <p className="text-xl font-medium tracking-[-0.01em]">{title}</p>
      {children ? <p className="text-ink-soft">{children}</p> : null}
      {action}
    </div>
  );
}
