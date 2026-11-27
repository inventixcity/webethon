"use client";

import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { AsciiCanvas } from "@/components/ascii/ascii-canvas";
import { type RadarStatus, RadarScene } from "@/components/ascii/scenes/radar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api/client";
import type { VerificationResult } from "@/lib/exam/types";
import { cn } from "@/lib/utils";

/** The radar has six contacts. Each one follows every second character of the 12 character code. */
const CONTACTS = 6;
const CODE_CHARS = 12;
/** How long the radar keeps scanning after the last keystroke. */
const TYPING_PAUSE_MS = 700;

/** Keeps the code in the XXXX-XXXX-XXXX shape, upper case, with no characters that look alike. */
function mask(value: string) {
  const chars = value
    .toUpperCase()
    .replace(/[^0-9A-HJKMNPQRSTVWXYZ]/g, "")
    .slice(0, CODE_CHARS);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].filter(Boolean).join("-");
}

/** Turns the typed characters into the radar's contacts, one contact for every second character. */
function radarCode(clean: string) {
  return Array.from({ length: CONTACTS }, (_, index) => clean[index * 2] ?? "").join("");
}

function statusLine(clean: string, loading: boolean, result: VerificationResult | null, error: string | null) {
  if (loading) return "Checking the signature";
  if (error) return "Could not verify";
  if (result?.valid) return "Certificate valid, signature checked";
  if (result?.revoked) return "Certificate revoked";
  if (result) return "No valid certificate for this code";
  if (clean.length === 0) return "Enter the 12 character code";
  return clean.length < CODE_CHARS ? `Reading the code, ${clean.length} of ${CODE_CHARS}` : "Ready to check";
}

/**
 * The issue date. The API sends an ISO string, or the time crate's tuple [year, ordinal day, hour, minute, second,
 * nanoseconds, ...] for some rows. Both are read here, so a row never shows "Invalid Date".
 */
function issuedLabel(value: unknown): string {
  if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") {
    const [year, ordinal, hour = 0, minute = 0, second = 0] = value as number[];
    const date = new Date(Date.UTC(year ?? 1970, 0, ordinal ?? 1, hour, minute, second));
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  }
  return "";
}

const label = "font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase";

/*
 * The result band is a fixed colour panel. data-theme="light" keeps its text pairs the same in both modes:
 * ivory on cobalt and vermilion, ink on amber.
 */
const bandStyle = {
  valid: "bg-cobalt text-paper",
  revoked: "bg-amber text-ink",
  invalid: "bg-vermilion text-paper",
  checking: "bg-paper-sunk text-ink",
} as const;

/**
 * The public certificate check, laid out for one laptop screen. The code and its result sit on the left, and the
 * radar is the hero on the right. It scans while the code is typed or checked, locks on a valid certificate, and
 * shows a no-match burst for an invalid or revoked one. On phones the radar is a band above the form.
 */
export function CertificateCheck({ code, background }: { code?: string; background?: ReactNode }) {
  const router = useRouter();
  const [radar] = useState(() => new RadarScene());
  const [value, setValue] = useState(mask(code ?? ""));
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(code));
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clean = value.replaceAll("-", "");

  useEffect(() => {
    if (!code) return;
    let active = true;
    api<VerificationResult>(`/verify/${encodeURIComponent(code)}`)
      .then((data) => {
        if (active) setResult(data);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof ApiError ? cause.message : "Verification could not be completed.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [code]);

  useEffect(() => {
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, []);

  // The radar follows the typed digits as they arrive.
  useEffect(() => {
    radar.setCode(radarCode(clean));
  }, [radar, clean]);

  // Scanning while typing or fetching, locked on a valid certificate, and a no-match burst otherwise.
  const radarState: RadarStatus = loading || typing ? "checking" : result?.valid ? "locked" : result ? "wrong" : "listening";
  useEffect(() => {
    radar.setStatus(radarState);
  }, [radar, radarState]);

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(mask(event.target.value));
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), TYPING_PAUSE_MS);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (clean.length !== CODE_CHARS) return;
    router.push(`/verify/${encodeURIComponent(value)}`);
  }

  const band = loading
    ? { style: bandStyle.checking, text: "Checking" }
    : error
      ? { style: bandStyle.invalid, text: "Could not verify" }
      : result?.valid
        ? { style: bandStyle.valid, text: "Valid certificate" }
        : result?.revoked
          ? { style: bandStyle.revoked, text: "Revoked certificate" }
          : result
            ? { style: bandStyle.invalid, text: "Invalid certificate" }
            : null;

  const signal = radarState === "checking" ? "Scanning" : radarState === "locked" ? "Locked" : radarState === "wrong" ? "No match" : "Listening";

  return (
    <main className="flex flex-1 flex-col px-5 pt-6 pb-12 sm:px-10 lg:h-[calc(100dvh-3.5rem)] lg:overflow-hidden lg:px-12 lg:py-6">
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-10 lg:grid lg:h-full lg:grid-cols-12 lg:gap-12">
        <section aria-labelledby="verify-title" className="flex flex-col justify-center lg:col-span-5 lg:min-h-0">
          <p className={label}>Verify / Certificate</p>
          <h1 id="verify-title" className="mt-3 text-5xl leading-[0.95] font-semibold tracking-[-0.03em] lg:text-[3.5rem]">
            Check a result.
          </h1>
          <p className="mt-3 max-w-md text-base text-ink-soft">
            {code
              ? "Showing the signed, masked statement for this code."
              : "Enter the 12 character certificate code printed on the result statement."}
          </p>

          <form onSubmit={submit} className="mt-7 flex max-w-md flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block min-w-0 flex-1">
              <span className={cn(label, "text-ink")}>Certificate code</span>
              <Input
                aria-label="Certificate code"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={value}
                onChange={onChange}
                placeholder="XXXX-XXXX-XXXX"
                className="mt-2 font-mono tracking-[0.18em] uppercase"
              />
            </label>
            <Button type="submit" disabled={clean.length !== CODE_CHARS}>
              {code ? "Check code" : "Verify code"}
            </Button>
          </form>

          <div className="mt-3 flex min-h-10 max-w-md flex-wrap items-center justify-between gap-x-6 gap-y-2">
            {loading || error || result ? null : (
              <p
                aria-live="polite"
                role="status"
                className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase"
              >
                {statusLine(clean, loading, result, error)}
              </p>
            )}
            {code ? (
              <div className="flex items-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => router.push("/verify")}>
                  Check another code
                </Button>
              </div>
            ) : null}
          </div>

          {(loading || error || result) && (
            <article aria-label="Result" className="mt-4 max-w-xl border border-rule bg-paper-raised">
              {band ? (
                <div
                  data-theme="light"
                  role="status"
                  aria-live="polite"
                  className={cn("px-5 py-2.5 font-mono text-[11px] tracking-[0.14em] uppercase", band.style)}
                >
                  {band.text}
                </div>
              ) : null}

              <div className="space-y-3.5 p-4 sm:p-5">
                {error && (
                  <div role="alert">
                    <h2 className="text-xl font-semibold">Could not verify</h2>
                    <p className="mt-2 text-ink-muted">{error}</p>
                  </div>
                )}

                {result && !loading && result.statement && (
                  <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    <div>
                      <dt className={label}>Candidate</dt>
                      <dd className="mt-1 text-base">{result.statement.candidate}</dd>
                    </div>
                    <div>
                      <dt className={label}>Result</dt>
                      <dd className="mt-1 text-base">
                        {result.statement.percent}% · {result.statement.passed ? "Passed" : "Not passed"}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className={label}>Examination</dt>
                      <dd className="mt-1 text-base">{result.statement.examTitle}</dd>
                    </div>
                    <div>
                      <dt className={label}>Issued</dt>
                      <dd className="mt-1 text-base">{issuedLabel(result.statement.issuedAt)}</dd>
                    </div>
                    <div>
                      <dt className={label}>Certificate ID</dt>
                      <dd className="mt-1 font-mono text-xs break-all">{result.statement.certificateId}</dd>
                    </div>
                  </dl>
                )}

                {result && !loading && !result.statement && (
                  <p className="text-ink-muted">No statement is available for this code.</p>
                )}

                {result && !loading && result.signature && (
                  <p className="border-t border-rule pt-3 font-mono text-[11px] tracking-[0.06em] uppercase">
                    Signed with Ed25519 · key {result.signature.keyId}
                    {result.signature.valid ? " · signature valid" : " · signature invalid"}
                  </p>
                )}

                {result && !loading && (
                  <p className="border-t border-rule pt-3 text-xs leading-snug text-ink-muted">
                    The signature verifies that the masked statement was issued by Inventix Invigil and has not been
                    changed. This check does not show email addresses, candidate identifiers, answers, or per-question
                    marks.
                  </p>
                )}
              </div>
            </article>
          )}

          {!code && (
            <p className="mt-8 max-w-xl border-t border-rule pt-4 text-sm text-ink-muted">
              Verification checks the signed, masked certificate statement and whether it has been revoked. It does not
              reveal candidate contact details or exam answers.
            </p>
          )}
        </section>

        <figure className="order-first flex h-[min(88vw,380px)] flex-col border border-rule bg-paper sm:h-[min(70vw,420px)] lg:order-none lg:h-full lg:min-h-0 lg:col-span-7">
          <figcaption className="flex items-center justify-between gap-4 border-b border-rule px-4 py-2.5 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
            <span>Signal / Ed25519</span>
            <span className={radarState === "locked" ? "text-cobalt-deep" : radarState === "wrong" ? "text-vermilion-deep" : undefined}>
              {signal}
            </span>
          </figcaption>
          <div className="relative min-h-0 flex-1">
            {background ? <div className="pointer-events-none absolute inset-0 opacity-15 grayscale">{background}</div> : null}
            <AsciiCanvas scene={radar} maxFont={40} className="absolute inset-0 size-full" />
          </div>
        </figure>
      </div>
    </main>
  );
}
