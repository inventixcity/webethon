"use client";

import Link from "next/link";
import { Children, cloneElement, isValidElement, useEffect, useRef, type ReactNode } from "react";
import { Art, hasArt } from "@/components/ui/art";
import { cn } from "@/lib/utils";

export type Crumb = { label: string; href?: string };

/** Wide, quiet images in public/images. Each one is shown only when its file exists. */
export type PageBanner = "bg-candidate" | "bg-examiner" | "bg-admin" | "bg-results" | "bg-users" | "bg-audit" | "bg-system" | "bg-settings";

function separateActionArt(actions: ReactNode): { art: ReactNode; controls: ReactNode } {
  if (!isValidElement<{ children?: ReactNode }>(actions)) return { art: null, controls: actions };

  const parts = Children.toArray(actions.props.children);
  const artIndex = parts.findIndex((part) => isValidElement(part) && part.type === Art);
  if (artIndex < 0) return { art: null, controls: actions };

  const actionArt = parts[artIndex];
  if (!isValidElement<{ className?: string; position?: string }>(actionArt)) return { art: null, controls: actions };

  const classes = actionArt.props.className?.split(/\s+/).filter((name) => !["hidden", "sm:block", "aspect-[4/3]", "w-60"].includes(name)) ?? [];
  const art = cloneElement(actionArt, {
    position: "object-[78%_50%]",
    className: cn(...classes, "block aspect-[16/7] w-full md:aspect-[16/10] md:max-w-[22rem]"),
  });
  const controls = parts.filter((_, index) => index !== artIndex);
  return { art, controls };
}

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
  /** @deprecated The app shell's top bar shows the trail now. Accepted so existing calls still compile, and not rendered. */
  breadcrumb?: Crumb[];
  /** Extra content under the header, such as a meta row. */
  children?: ReactNode;
  /** h1 for a page, h2 for a section inside a page that already has its own h1. */
  level?: 1 | 2;
  /** A small editorial image on the right of the header. Nothing renders when the file is absent. Never behind the text. */
  /** A halftone figure on the right of the header, drawn from the image in public/images. Decorative. Never behind the text. */
  banner?: PageBanner;
  /** Explicit mono caption for a page banner. */
  bannerCaption?: string;
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

/**
 * The accent hairline under a page title. A cobalt rule with an amber layer that rises and falls over it, and a
 * short cobalt spark travelling along it. Only opacity and transform animate. It pauses when it scrolls out of view
 * or the tab is hidden. Under reduced motion the CSS animations are stopped, and it stays as a still cobalt rule with
 * the amber layer at rest. It is decorative, so it is hidden from assistive technology.
 */
export function AccentRule() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = root.current;
    if (!element || typeof element.getAnimations !== "function") return;
    const sync = () => {
      for (const animation of element.getAnimations({ subtree: true })) {
        if (document.hidden) animation.pause();
        else animation.play();
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      for (const animation of element.getAnimations({ subtree: true })) {
        if (entry.isIntersecting && !document.hidden) animation.play();
        else animation.pause();
      }
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return (
    <div ref={root} aria-hidden="true" className="relative h-[2px] w-full overflow-hidden bg-rule">
      <span className="absolute inset-0 bg-cobalt" />
      <span className="absolute inset-0 bg-amber animate-hairline-tone" />
      <span className="absolute inset-y-0 left-0 w-1/5 bg-cobalt animate-hairline-spark" />
    </div>
  );
}

/**
 * The header every screen opens with: a numbered mono eyebrow, a tight headline, one line of description and the
 * primary actions, with a thin wave rule under the title. Level 2 is the plain variant for a section inside a page
 * that already has its own h1.
 */
export function PageHeader({
  index,
  eyebrow,
  title,
  description,
  actions,
  children,
  level = 1,
  banner,
  bannerCaption,
  id,
  className,
}: PageHeaderProps) {
  const showBanner = banner !== undefined && hasArt(banner);
  const separated = !showBanner && actions ? separateActionArt(actions) : { art: null, controls: actions };
  const headerArt = showBanner && banner ? (
    <>
      <Art name={banner} alt="" sizes="(max-width: 767px) 100vw, 352px" position="object-[78%_50%]" className="aspect-[16/7] w-full border border-ink md:aspect-[16/10]" />
      <figcaption className="mt-2 font-mono text-[11px] tracking-[0.06em] text-ink-muted uppercase md:text-[10px] md:tracking-[0.12em]">
        {bannerCaption ?? `FIG. ${index ?? "01"} / ${eyebrow}`}
      </figcaption>
    </>
  ) : separated.art ? (
    <>
      {separated.art}
      <figcaption className="mt-2 font-mono text-[11px] tracking-[0.06em] text-ink-muted uppercase md:text-[10px] md:tracking-[0.12em]">
        FIG. {index ?? "01"} / {eyebrow}
      </figcaption>
    </>
  ) : null;
  const Heading = level === 1 ? "h1" : "h2";

  return (
    <header className={cn("grid w-full min-w-0 max-w-full gap-4", level === 1 ? "pb-5 md:pb-7" : "border-b border-rule pb-5", className)}>
      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] md:items-center md:gap-8">
        <div className="grid min-w-0 content-center gap-3">
          <Eyebrow index={index} tone={level === 1 ? "accent" : "info"}>
            {eyebrow}
          </Eyebrow>
          <Heading
            id={id}
            className={cn(
              "font-medium tracking-[-0.03em] break-words",
              level === 1
                ? "text-[clamp(1.75rem,1.3rem+2vw,3rem)] leading-[1] md:text-[clamp(2rem,1.2rem+2.6vw,3rem)]"
                : "text-[clamp(1.5rem,1rem+1.6vw,2rem)] leading-[1.05]",
            )}
          >
            {title}
          </Heading>
          {description ? <p className="max-w-[62ch] text-[15px] leading-relaxed text-ink-soft">{description}</p> : null}
          {separated.controls ? <div className="mt-1 flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">{separated.controls}</div> : null}
        </div>
        {headerArt ? (
          <figure aria-hidden="true" className="w-full min-w-0 md:w-full">
            {headerArt}
          </figure>
        ) : null}
      </div>
      {level === 1 ? <AccentRule /> : null}
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
