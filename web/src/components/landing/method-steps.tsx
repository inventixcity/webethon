export type MethodStep = { title: string; text: string };

/**
 * The method as one clean row of six steps: a mono number, a title and a two-line description, with hairline
 * separators. A subtle cobalt underline draws under the title on hover. Two columns on small screens.
 */
export function MethodSteps({ steps }: { steps: readonly MethodStep[] }) {
  return (
    <ol className="grid grid-cols-2 border-t border-ink md:grid-cols-3 lg:grid-cols-6">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className="group grid content-start gap-3 border-b border-rule py-7 pr-4 pl-0 md:px-5 md:first:pl-0 lg:border-b-0 lg:border-l lg:px-5 lg:first:border-l-0 lg:first:pl-0"
        >
          <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted tabular-nums">{String(index + 1).padStart(2, "0")} /</span>
          <h3 className="relative inline-block w-fit text-2xl font-medium tracking-[-0.02em] after:absolute after:inset-x-0 after:-bottom-1 after:h-px after:origin-left after:scale-x-0 after:bg-cobalt after:transition-transform after:duration-300 group-hover:after:scale-x-100 motion-reduce:after:transition-none">
            {step.title}
          </h3>
          <p className="max-w-[26ch] text-sm leading-relaxed text-ink-soft">{step.text}</p>
        </li>
      ))}
    </ol>
  );
}
