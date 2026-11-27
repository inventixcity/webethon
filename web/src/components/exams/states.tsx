import type { ReactNode } from "react";
import { EmptyState as SharedEmptyState } from "@/components/ui/empty-state";
import { ErrorState as SharedErrorState, LoadingState } from "@/components/ui/state";

export { LoadingState };

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <SharedErrorState
      error={error}
      onRetry={onRetry}
      notFoundMessage="This exam doesn't exist, or you don't have access to it."
      className="my-8"
    />
  );
}

/** An empty block inside the exam screens. `panel` adds the live ASCII field for a whole-tab empty state. */
export function EmptyState({
  title,
  children,
  action,
  eyebrow,
  variant = "panel",
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  eyebrow?: string;
  variant?: "panel" | "inline";
}) {
  return <SharedEmptyState title={title} description={children} actions={action} eyebrow={eyebrow} variant={variant} />;
}
