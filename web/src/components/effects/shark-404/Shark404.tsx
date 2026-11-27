"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AsciiOcean } from "@/vendor/ascii-sharks/react";
import type { SharkSpec } from "@/vendor/ascii-sharks";
import { cn } from "@/lib/utils";

const styles = {
  "root": "shark-404-root",
  "ocean": "shark-404-ocean",
  "masthead": "shark-404-masthead",
  "footer": "shark-404-footer",
  "content": "shark-404-content",
  "code": "shark-404-code",
  "title": "shark-404-title",
  "description": "shark-404-description",
  "home": "shark-404-home",
  "actions": "shark-404-actions",
  "details": "shark-404-details"
};

export interface Shark404Props {
  /** Display code; defaults to the standard not-found status. */
  code?: string;
  /** Accessible page title beneath the large status code. */
  title?: string;
  /** Brief explanation and recovery guidance. */
  description?: string;
  /** Label for the recovery link. */
  homeLabel?: string;
  /** Recovery destination. */
  homeHref?: string;
  /** Small masthead label. */
  eyebrow?: string;
  /** Optional interaction hint at the foot of the ocean. */
  caption?: string;
  /** Additional classes on the full-bleed section. */
  className?: string;
  /** The element the page renders as. Use "div" inside a screen that already has a <main> landmark. */
  as?: "section" | "main" | "div";
  /** The ocean's cast. Defaults to the original three-shark ocean. */
  sharks?: SharkSpec[];
  /** Replaces the default recovery link with custom controls, such as a retry button or a sign-in link. */
  actions?: ReactNode;
  /** Shown below the actions on a paper strip, such as a request id to quote to support. */
  details?: ReactNode;
}

const SHARKS: SharkSpec[] = [
  { kind: "classic", size: 1 },
  { kind: "hammerhead", size: 0.8 },
  { kind: "classic", size: 0.64 },
];

/** A living, token-coloured ASCII ocean using the vendored MIT shark engine. */
export function Shark404({
  code = "404",
  title = "This page has been eaten.",
  description = "There was something here. The sharks got to it first. Let's get you back to dry land.",
  homeLabel = "Back to dry land",
  homeHref = "/",
  eyebrow = "Uncharted waters",
  caption = "Go on. Test the waters.",
  className,
  as: Root = "section",
  sharks = SHARKS,
  actions,
  details,
}: Shark404Props) {
  return (
    <Root className={cn(styles.root, className)}>
      <AsciiOcean className={styles.ocean} sharks={sharks} />
      <header className={styles.masthead}>
        <span>{eyebrow}</span>
        <span aria-hidden="true">{code}</span>
      </header>
      <div className={styles.content}>
        <div className={styles.code} aria-hidden="true">{code}</div>
        <h1 className={styles.title}><span className="sr-only">{code}: </span>{title}</h1>
        <p className={styles.description}>{description}</p>
        {actions === undefined ? (
          <Link className={styles.home} href={homeHref}>{homeLabel}<span aria-hidden="true">↗</span></Link>
        ) : (
          <div className={styles.actions}>{actions}</div>
        )}
        {details ? <div className={styles.details}>{details}</div> : null}
      </div>
      <footer className={styles.footer}><span>{caption}</span></footer>
    </Root>
  );
}
