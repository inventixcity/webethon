"use client";

// The previous full-page error layout: a masthead, a bordered headline panel, and a footer over the ocean.
// It is no longer used by default, because the error pages now use the Shark404 composition (error-page.tsx).
// It is kept as a ready alternative. To switch an error page to it, render ErrorPageAlt instead of ErrorPage.

import Link from "next/link";
import type { ReactNode } from "react";
import { useTheme } from "@/components/theme/theme";
import { Button } from "@/components/ui/button";
import { AsciiOcean } from "@/vendor/ascii-sharks/react";
import { RequestId } from "./request-id";
import { ERROR_SCENES } from "./scenes";
import { type ErrorPageProps, useErrorPageState } from "./error-state";

export function ErrorPageAlt(props: ErrorPageProps) {
  // A different error starts a fresh page, so the countdown and the scene reset with it.
  const key = `${props.code}|${props.retryAfterSeconds ?? ""}|${props.requestId ?? ""}`;
  return <ErrorPageAltView key={key} {...props} />;
}

function ErrorPageAltView(props: ErrorPageProps) {
  const { code, requestId, as = "main" } = props;
  const Root = as;
  const theme = useTheme();
  const { copy, headline, disabled, retry, signInHref } = useErrorPageState(props);

  let primary: ReactNode;
  if (copy.action.kind === "home") {
    primary = (
      <Button asChild size="lg">
        <Link href="/">{copy.action.label}</Link>
      </Button>
    );
  } else if (copy.action.kind === "signin") {
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

  return (
    <Root className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-paper text-ink">
      <AsciiOcean
        key={`${code}-${theme}`}
        className="absolute inset-0 -z-10 size-full font-mono"
        sharks={ERROR_SCENES[code]}
      />

      <header className="px-5 pt-6 md:px-8">
        <span className="inline-block bg-paper px-1.5 py-0.5 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          {copy.label}
        </span>
      </header>

      <div className="flex flex-1 items-end px-5 py-10 md:px-8 md:py-16">
        <section
          aria-labelledby="error-page-headline"
          className="grid w-full max-w-[52rem] gap-7 border border-rule bg-paper p-6 md:p-10"
        >
          <h1
            id="error-page-headline"
            className="text-[clamp(2.25rem,5vw,4rem)] leading-[1.02] font-medium tracking-[-0.035em] text-balance"
          >
            {headline}
          </h1>
          <p className="max-w-[44ch] text-lg text-ink-soft">{copy.body}</p>

          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
            {primary}
            {copy.action.kind !== "home" && (
              <Link
                href="/"
                className="font-mono text-xs tracking-[0.12em] uppercase underline underline-offset-4 hover:text-vermilion-deep"
              >
                Back to home
              </Link>
            )}
          </div>

          {requestId ? <RequestId id={requestId} /> : null}
        </section>
      </div>

      <footer className="px-5 pb-5 md:px-8">
        <p className="inline-block bg-paper px-1.5 py-0.5 font-mono text-[11px] tracking-[0.1em] text-ink-muted uppercase">
          Move your pointer over the water.
        </p>
      </footer>
    </Root>
  );
}
