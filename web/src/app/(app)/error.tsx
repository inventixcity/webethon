"use client";

import { Shark404 } from "@/components/effects/shark-404";
import { Button } from "@/components/ui/button";
import { ErrorPage } from "@/components/errors/error-page";
import { readErrorDetails } from "@/components/errors/read-error";
import { ERROR_SCENES } from "@/components/errors/scenes";

/**
 * Shown when the session can't be checked, for example while the API is down. It is deliberately vague,
 * because production errors don't carry their details to the browser.
 *
 * A gateway or service-unavailable status from the API (502, 503, 504) gets the shared error page instead.
 * Every other error keeps this account message, on the same Shark404 design.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const details = readErrorDetails(error, 500);
  if (details.status === 502 || details.status === 503 || details.status === 504) {
    return (
      <ErrorPage
        code={details.code}
        requestId={details.requestId}
        retryAfterSeconds={details.retryAfterSeconds}
        onRetry={retry}
      />
    );
  }

  return (
    <Shark404
      as="main"
      code="—"
      eyebrow="Error / Account"
      title="We couldn't load your account."
      description="The service may be busy or briefly unreachable. Try again in a moment."
      sharks={ERROR_SCENES[500]}
      actions={
        <Button type="button" size="lg" onClick={retry}>
          Try again
        </Button>
      }
    />
  );
}
