import { GridPulse } from "@/components/loaders/shape-loaders";
import { Button } from "@/components/ui/button";

/** The loading state for a candidate panel. The loader is one status region for screen readers. */
export function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-5 py-16">
      <GridPulse size={32} label={label} />
      <p className="font-mono text-[11px] tracking-[0.14em] uppercase">{label}</p>
    </div>
  );
}

/** An inline failure with a way out. Used where a route error page would hide the rest of the page. */
export function PanelError({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="grid gap-5 border-y border-ink py-10">
      <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] uppercase">
        <span aria-hidden="true" className="size-1.5 bg-vermilion" />
        Error
      </p>
      <h2 className="text-2xl font-medium tracking-[-0.02em]">{title}</h2>
      <p className="max-w-[60ch] text-base text-ink-soft">{message}</p>
      {onRetry && (
        <div>
          <Button type="button" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

/** A quiet empty state for a list with nothing in it. */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="border-t border-rule py-8 text-base text-ink-soft">{children}</p>;
}
