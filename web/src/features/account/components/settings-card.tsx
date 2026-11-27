import { cn } from "@/lib/utils";

type SettingsCardProps = {
  id: string;
  /** Two-digit section number, for example "01". */
  number: string;
  /** Small mono label above the title, for example "Security". */
  eyebrow: string;
  title: string;
  description: string;
  tone?: "default" | "danger";
  children: React.ReactNode;
};

/** One section of the settings page. The heading is what the section is labelled by. */
export function SettingsCard({
  id,
  number,
  eyebrow,
  title,
  description,
  tone = "default",
  children,
}: SettingsCardProps) {
  const titleId = `${id}-title`;

  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cn(
        "grid gap-8 border bg-paper-raised p-5 md:grid-cols-12 md:gap-x-10 md:p-8",
        tone === "danger" ? "border-vermilion-deep" : "border-rule",
      )}
    >
      <header className="grid content-start gap-3 md:col-span-4">
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          {number} / {eyebrow}
        </p>
        <h2 id={titleId} className="text-4xl leading-none font-medium tracking-[-0.03em]">
          {title}
        </h2>
        <p className="text-ink-soft">{description}</p>
      </header>
      <div className="min-w-0 md:col-span-7 md:col-start-6">{children}</div>
    </section>
  );
}
