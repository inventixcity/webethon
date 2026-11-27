import { cn } from "@/lib/utils";

const WITHOUT = [
  ["Answers lost", "A dropped connection can wipe the page. Anything typed since the last save is gone, and nobody can recover it."],
  ["Unfair time", "The clock keeps running through an outage, so a candidate can lose minutes they cannot prove they lost."],
  ["Arguments by guess", "Examiners weigh claims of an outage with no record either way, and every decision is a judgement call."],
] as const;

const WITH = [
  ["An offline journal", "Answers are kept on the device in a hash-chained journal, then sent when the connection returns. Edits break the chain."],
  ["Signed time leases", "The server issues short signed leases, so a device clock never decides a deadline."],
  ["Outage credit, verified", "Gaps are recorded as heartbeats and credited only when an examiner approves them. Every credit is audited."],
] as const;

/** Without Invigil against With Invigil, side by side on the theme surfaces. The Without column is muted. */
export function ResilienceCompare({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-4 md:grid-cols-2", className)}>
      <section aria-label="Without Invigil" className="grid content-start gap-5 border border-rule bg-paper-sunk p-6 md:p-7">
        <h3 className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-soft uppercase">
          <span aria-hidden="true" className="size-2.5 bg-amber" />
          Without Invigil
        </h3>
        <ul className="grid gap-5">
          {WITHOUT.map(([title, text]) => (
            <li key={title} className="grid gap-1.5 border-t border-rule pt-4">
              <p className="font-medium text-ink-soft">{title}</p>
              <p className="text-sm leading-relaxed text-ink-soft">{text}</p>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="With Invigil" className="grid content-start gap-5 border border-ink bg-paper-raised p-6 md:p-7">
        <h3 className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-cobalt-deep uppercase dark:text-cobalt">
          <span aria-hidden="true" className="size-2.5 bg-cobalt" />
          With Invigil
        </h3>
        <ul className="grid gap-5">
          {WITH.map(([title, text]) => (
            <li key={title} className="grid gap-1.5 border-t border-rule pt-4">
              <p className="font-medium text-ink">{title}</p>
              <p className="text-sm leading-relaxed text-ink-soft">{text}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
