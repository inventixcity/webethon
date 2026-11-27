import Link from "next/link";
import type { ReactNode } from "react";
import { WaveText } from "@/components/effects/wave-text";
import { Art, hasArt } from "@/components/ui/art";
import { cn } from "@/lib/utils";

export type Crumb = { label: string; href?: string };

/** Wide, quiet banner images in public/images. Each one is shown only when its file exists. */
export type PageBanner = "bg-candidate" | "bg-examiner" | "bg-admin" | "bg-results";

type PageHeaderProps = {
  /** Two-digit section number, for example "02". Shown before the eyebrow. */
  index?: string;
  /** The mono caption above the headline, for example "Question bank". */
  eyebrow: string;
  title: ReactNode;
  /** One line that says what this page is for. */
  description?: ReactNode;
  /** Primary actions. They sit on the right from md up, and under the text on phones. */
  actions?: ReactNode;
  /** Trail back to the parent pages. The last crumb is the current page and has no link. */
  breadcrumb?: Crumb[];
  /** Extra content under the description: a meta row, a timeline. */
  children?: ReactNode;
  /** h1 for a page, h2 for a section inside a page that already has its own h1 (the exam tabs). */
  level?: 1 | 2;
  /** A low-opacity banner image behind the title, on the right. Nothing renders when the file is absent. */
  banner?: PageBanner;
  id?: string;
  className?: string;
};

/** Mono, uppercase, tracked: the label voice of the product. */
export function Eyebrow({
  index,
  children,
  className,
  tone = "accent",
}: {
  index?: string;
  children: ReactNode;
  className?: string;
  /** accent: the vermilion focal mark. info: a cobalt rule mark for section headers. */
  tone?: "accent" | "info";
}) {
  return (
    <p className={cn("flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase", className)}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0", tone === "info" ? "bg-cobalt" : "bg-vermilion")} />
      <span>
        {index ? (
          <>
            <span className="text-ink tabular-nums">{index}</span>
            <span aria-hidden="true"> / </span>
          </>
        ) : null}
        {children}
      </span>
    </p>
  );
}

export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase", className)}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-2">
              {item.href && !last ? (
                <Link href={item.href} className="underline-offset-4 transition-colors duration-(--duration-fast) hover:text-ink hover:underline">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className="max-w-[28ch] truncate text-ink-soft">
                  {item.label}
                </span>
              )}
              {!last ? <span aria-hidden="true">/</span> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/*
 * Compacts WaveText's full-screen hero into a header band. The overrides are !important because wave-text.css is
 * unlayered, and it would otherwise win over Tailwind utilities.
 */
const WAVE_CLASS = cn(
  "!min-h-0",
  "[&_.wave-text-body]:!pt-8 [&_.wave-text-body]:!pb-6 md:[&_.wave-text-body]:!pt-10",
  "[&_.wave-text-headline]:!mb-0 [&_.wave-text-headline]:!text-[clamp(2.5rem,6vw,4.5rem)] [&_.wave-text-headline]:!leading-[0.95]",
  "[&_.wave-text-support]:!mt-0 [&_.wave-text-support]:!ml-0 [&_.wave-text-support]:!w-full",
  "[&_.wave-text-support_p]:!max-w-[62ch]",
  "[&_.wave-text-content]:!p-5 md:[&_.wave-text-content]:!p-8",
);

/**
 * The header every screen opens with: a numbered mono eyebrow, a large tight headline, one line of description and
 * the primary actions. A level 1 string title renders as a WaveText band, which keeps the headline as a real h1 and
 * hides its water copy from assistive technology. Level 2 is the smaller plain variant for a section inside a page
 * that already has its own h1.
 */
export function PageHeader({
  index,
  eyebrow,
  title,
  description,
  actions,
  breadcrumb,
  children,
  level = 1,
  banner,
  id,
  className,
}: PageHeaderProps) {
  const crumbs = breadcrumb && breadcrumb.length > 0 ? <Breadcrumb items={breadcrumb} /> : null;
  const showBanner = banner !== undefined && hasArt(banner);
  const bannerLayer = showBanner ? (
    <Art
      name={banner}
      alt=""
      position="object-right"
      sizes="100vw"
      className="pointer-events-none absolute inset-0 -z-10 opacity-30 dark:opacity-20"
    />
  ) : null;

  if (level === 1 && typeof title === "string" && (description === undefined || typeof description === "string")) {
    return (
      <header className={cn("grid gap-6", showBanner && "relative isolate overflow-hidden", className)}>
        {bannerLayer}
        {crumbs}
        <WaveText
          headingAs="h1"
          eyebrow={index ? `${index} / ${eyebrow}` : eyebrow}
          edition=""
          headline={title}
          description={description ?? ""}
          actionLabel=""
          caption=""
          waveHeight={0.3}
          speed={0.6}
          amplitude={36}
          interactive={false}
          className={WAVE_CLASS}
        />
        {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
        {children}
      </header>
    );
  }

  const Heading = level === 1 ? "h1" : "h2";
  return (
    <header
      className={cn(
        "grid gap-6",
        showBanner && "relative isolate overflow-hidden",
        level === 1 ? "border-b border-ink pt-10 pb-8 md:pt-14 md:pb-10" : "border-b border-rule pt-10 pb-6",
        className,
      )}
    >
      {bannerLayer}
      {crumbs}
      <div className="grid gap-6 md:grid-cols-12 md:items-end md:gap-8">
        <div className={cn("grid min-w-0 gap-4", actions ? "md:col-span-8" : "md:col-span-12")}>
          <Eyebrow index={index} tone={level === 1 ? "accent" : "info"}>
            {eyebrow}
          </Eyebrow>
          <Heading
            id={id}
            className={cn(
              "font-medium tracking-[-0.03em] break-words",
              level === 1
                ? "text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.95]"
                : "text-[clamp(1.875rem,4vw,2.75rem)] leading-none",
            )}
          >
            {title}
          </Heading>
          {description ? <p className="max-w-[62ch] text-base text-ink-soft">{description}</p> : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-3 md:col-span-4 md:justify-end">{actions}</div>
        ) : null}
      </div>
      {children}
    </header>
  );
}

/**
 * A numbered rule heading for a block inside a page, for example "02 / Marks". The rule sits under the label so
 * blocks read as chapters, not boxes.
 */
export function SectionHeading({
  index,
  title,
  description,
  actions,
  id,
  as: Tag = "h2",
  className,
}: {
  index?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
  as?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3 border-b border-ink pb-4", className)}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Tag id={id} className="font-mono text-[11px] tracking-[0.14em] uppercase">
          {index ? (
            <>
              <span className="tabular-nums text-cobalt-deep">{index}</span>
              <span aria-hidden="true" className="text-ink-muted">
                {" / "}
              </span>
            </>
          ) : null}
          {title}
        </Tag>
        {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
      </div>
      {description ? <p className="max-w-[62ch] text-sm text-ink-soft">{description}</p> : null}
    </div>
  );
}
