"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Shark404 } from "@/components/effects/shark-404";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme/theme";
import type { ErrorPageCode } from "@/lib/errors/types";
import { SharkRequestId } from "./request-id";
import { ERROR_SCENES } from "./scenes";
import { type ErrorPageProps, useErrorPageState } from "./error-state";

export type { ErrorPageProps } from "./error-state";

/** The big glyph. Numeric codes show as they are; the two non-HTTP states get a short word. */
const GLYPH: Partial<Record<ErrorPageCode, string>> = { offline: "off", "session-expired": "out" };

/**
 * A full-page error on the original Shark404 design: a live ocean, a masthead, the large code, the title and
 * the recovery action. The copy comes from copy.ts, and the cast of sharks from scenes.ts. The 404 page is this
 * same composition with its original copy, so it looks exactly like the plain Shark404.
 *
 * The ocean reacts to the pointer and stops looping under reduced motion, where it shows a still frame.
 */
export function ErrorPage(props: ErrorPageProps) {
  // A different error starts a fresh page, so the countdown and the scene reset with it.
  const key = `${props.code}|${props.retryAfterSeconds ?? ""}|${props.requestId ?? ""}`;
  return <ErrorPageView key={key} {...props} />;
}

function ErrorPageView(props: ErrorPageProps) {
  const { code, requestId, as = "main" } = props;
  const theme = useTheme();
  const { copy, headline, disabled, signInHref, retry } = useErrorPageState(props);

  // The label reads "Uncharted waters / 404" or "Error / 400". The masthead shows the part before the slash,
  // and the code is drawn large and on the right.
  const [eyebrow] = copy.label.split(" / ");
  const glyph = GLYPH[code] ?? String(code);

  // Every page except the plain "back to home" one gets its own primary action, plus a way home.
  let actions: ReactNode;
  if (copy.action.kind !== "home") {
    let primary: ReactNode;
    if (copy.action.kind === "signin") {
      primary = (
        <Button asChild size="lg">
          <Link href={signInHref} prefetch={false}>
            {copy.action.label}
          </Link>
        </Button>
      );
    } else if (copy.action.kind === "back") {
      primary = (
        <Button type="button" size="lg" onClick={() => window.history.back()}>
          {copy.action.label}
        </Button>
      );
    } else {
      primary = (
        <Button type="button" size="lg" disabled={disabled} onClick={retry}>
          {copy.action.label}
        </Button>
      );
    }
    actions = (
      <>
        {primary}
        <Link className="shark-404-secondary" href="/">
          Back to home
        </Link>
      </>
    );
  }

  return (
    <Shark404
      key={`${code}-${theme}`}
      as={as}
      code={glyph}
      eyebrow={eyebrow}
      title={headline}
      description={copy.body}
      sharks={ERROR_SCENES[code]}
      homeLabel={copy.action.label}
      homeHref="/"
      actions={actions}
      details={requestId ? <SharkRequestId id={requestId} /> : undefined}
    />
  );
}
