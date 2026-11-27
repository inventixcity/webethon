import { cn } from "@/lib/utils";

type DemoFrameProps = {
  index: string;
  title: string;
  note: string;
  children: React.ReactNode;
  className?: string;
};

/** The shared layout for a component's preview page. */
export function DemoFrame({ index, title, note, children, className }: DemoFrameProps) {
  return (
    <section className="flex min-h-dvh flex-col bg-paper px-5 py-8 pb-20 text-ink md:px-16">
      <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">{index}</p>
      <h1 className="mt-3 text-[clamp(2.25rem,4vw,3.5rem)] leading-none font-semibold tracking-[-0.03em]">{title}</h1>
      <p className="mt-3 max-w-xl text-base text-ink-soft">{note}</p>
      <div className={cn("mt-10 flex flex-1 items-center justify-center", className)}>{children}</div>
    </section>
  );
}
