import type { ReactNode } from "react";
import { Art } from "@/components/ui/art";
import { DriftField } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

/** A mono section label such as "01 / Method". The number is ink, so the label reads as an editorial index. */
export function Eyebrow({ num, children, className }: { num?: string; children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase",
        className,
      )}
    >
      {num ? <span className="text-ink tabular-nums">{num} /</span> : null}
      <span>{children}</span>
    </p>
  );
}

/** The opening of a numbered section: the mono label above a large headline that spans ten columns. */
export function SectionTitle({
  id,
  num,
  label,
  children,
  className,
}: {
  id: string;
  num: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-5 md:grid-cols-12", className)}>
      <div className="md:col-span-12">
        <Eyebrow num={num}>{label}</Eyebrow>
      </div>
      <h2
        id={id}
        className="text-[clamp(2.5rem,6.4vw,5.75rem)] leading-[0.94] font-medium tracking-[-0.04em] md:col-span-10"
      >
        {children}
      </h2>
    </div>
  );
}

/**
 * An editorial figure: a square frame with a grain layer and a numbered mono caption. Without its file it shows
 * the ASCII field, so the section still moves.
 */
export function Figure({
  name,
  darkName,
  alt,
  num,
  caption,
  ratio = "aspect-[4/3]",
  sizes = "(min-width: 768px) 42vw, 100vw",
  priority = false,
  position,
  className,
}: {
  name: string;
  darkName?: string;
  alt: string;
  num: string;
  caption: string;
  ratio?: string;
  sizes?: string;
  priority?: boolean;
  position?: string;
  className?: string;
}) {
  return (
    <figure className={cn("grid content-start gap-3", className)}>
      <Art
        name={name}
        darkName={darkName}
        alt={alt}
        sizes={sizes}
        priority={priority}
        position={position}
        className={cn("grain w-full border border-ink", ratio)}
        fallback={<DriftField className="size-full" />}
      />
      <figcaption className="flex flex-wrap justify-between gap-x-6 gap-y-1 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
        <span className="text-ink tabular-nums">FIG. {num}</span>
        <span>{caption}</span>
      </figcaption>
    </figure>
  );
}
