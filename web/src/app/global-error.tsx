"use client";

import type { CSSProperties } from "react";
import "./globals.css";
import { ErrorPage } from "@/components/errors/error-page";
import { readErrorDetails } from "@/components/errors/read-error";
import { ThemeScript } from "@/components/theme/theme-script";

/**
 * Replaces the root layout when the layout itself fails, so it renders its own document and needs
 * none of the app's providers. Fonts fall back to the system faces, because next/font can't load in a
 * Client Component. Dark mode still follows the saved theme through ThemeScript.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const details = readErrorDetails(error, 500);
  return (
    <html
      lang="en"
      suppressHydrationWarning
      style={
        {
          "--font-display": "ui-sans-serif, system-ui, sans-serif",
          "--font-code": "ui-monospace, monospace",
        } as CSSProperties
      }
    >
      <head>
        <ThemeScript />
        <title>Something broke on our side</title>
      </head>
      <body>
        <ErrorPage code={500} requestId={details.requestId} onRetry={retry} />
      </body>
    </html>
  );
}
