"use client";

import Link from "next/link";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
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

const linkStyle = "underline underline-offset-4 hover:text-vermilion-deep";

/**
 * The public certificate check. The radar is the visual while a code is typed or checked. It locks on a valid
 * certificate, and shows a no-match burst for an invalid or revoked one. The result card is shown in full.
 */
export function CertificateCheck({ code, background }: { code?: string; background?: ReactNode }) {
  const [radar] = useState(() => new RadarScene());
  const [value, setValue] = useState(mask(code ?? ""));
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(code));

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

  // The radar follows the typed digits as they arrive.
  useEffect(() => {
    radar.setCode(radarCode(clean));
  }, [radar, clean]);

  // Scanning while the code is fetched, then locked for a valid certificate and no match otherwise.
  const radarState: RadarStatus = loading ? "checking" : result?.valid ? "locked" : result ? "wrong" : "listening";
  useEffect(() => {
    radar.setStatus(radarState);
  }, [radar, radarState]);

  function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    setValue(mask(event.target.value));
    // Typing returns the radar to its idle sweep until the code is checked.
    radar.setStatus("listening");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (clean.length !== CODE_CHARS) return;
    window.location.assign(`/verify/${encodeURIComponent(value)}`);
  }

  const state = result?.valid ? "VALID CERTIFICATE" : result?.revoked ? "REVOKED CERTIFICATE" : "INVALID CERTIFICATE";

  return (
    <main className="relative isolate min-h-screen overflow-hidden bg-paper px-5 py-12 text-ink sm:px-10">
      {background ? <div className="pointer-events-none absolute inset-0 -z-10 opacity-70">{background}</div> : null}
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:gap-16">
        <div>
          <div className="mb-12 h-0.5 w-16 bg-vermilion" />
          <p className="font-mono text-xs tracking-[0.12em] text-ink-muted uppercase">Inventix Invigil / Public record</p>
          <h1 className="mt-4 text-5xl font-semibold tracking-[-0.04em] sm:text-7xl">
            {code ? "Certificate check." : "Verify a result."}
          </h1>
          {!code && (
            <p className="mt-6 max-w-xl text-base text-ink-soft">
              Enter the 12 character certificate code printed on the result statement.
            </p>
          )}

          <form onSubmit={submit} className="mt-10 flex max-w-xl flex-col gap-4 sm:flex-row sm:items-end">
            <label className="block flex-1">
              <span className="font-mono text-xs tracking-[0.12em] uppercase">Certificate code</span>
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

          <section className="mt-10 border-t border-rule pt-7">
            <p
              aria-live="polite"
              role="status"
              className={cn(
                "font-mono text-xs tracking-[0.12em] uppercase",
                error || result ? "text-vermilion-deep" : "text-ink-muted",
              )}
            >
              {statusLine(clean, loading, result, error)}
            </p>

            {error && (
              <div role="alert" className="mt-6">
                <h2 className="text-2xl font-semibold">Could not verify</h2>
                <p className="mt-3 text-ink-muted">{error}</p>
              </div>
            )}

            {result && !loading && (
              <div className="mt-6">
                <p className="font-mono text-xs tracking-[0.12em] text-vermilion-deep uppercase">{state}</p>
                {result.statement && (
                  <dl className="mt-7 grid gap-5 sm:grid-cols-2">
                    <div>
                      <dt className="font-mono text-xs tracking-[0.12em] text-ink-muted uppercase">Candidate</dt>
                      <dd className="mt-1 text-xl">{result.statement.candidate}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-xs tracking-[0.12em] text-ink-muted uppercase">Examination</dt>
                      <dd className="mt-1 text-xl">{result.statement.examTitle}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-xs tracking-[0.12em] text-ink-muted uppercase">Result</dt>
                      <dd className="mt-1 text-xl">
                        {result.statement.percent}% · {result.statement.passed ? "Passed" : "Not passed"}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono text-xs tracking-[0.12em] text-ink-muted uppercase">Issued</dt>
                      <dd className="mt-1 text-xl">{new Date(result.statement.issuedAt).toLocaleDateString()}</dd>
                    </div>
                  </dl>
                )}
                {result.signature && (
                  <p className="mt-7 font-mono text-xs tracking-[0.1em] uppercase">
                    Signed with Ed25519 · key {result.signature.keyId}
                    {result.signature.valid ? " · signature valid" : " · signature invalid"}
                  </p>
                )}
                <p className="mt-8 max-w-2xl border-t border-rule pt-5 text-sm text-ink-muted">
                  The signature verifies that the masked statement was issued by Inventix Invigil and has not been
                  changed. This check does not show email addresses, candidate identifiers, answers, or per-question
                  marks.
                </p>
              </div>
            )}
          </section>

          {!code && (
            <p className="mt-12 max-w-xl border-t border-rule pt-5 text-sm text-ink-muted">
              Verification checks the signed, masked certificate statement and whether it has been revoked. It does not
              reveal candidate contact details or exam answers.
            </p>
          )}
          <Link
            href={code ? "/verify" : "/"}
            className={cn("mt-10 inline-block font-mono text-xs tracking-[0.12em] uppercase", linkStyle)}
          >
            {code ? "Enter another code" : "Inventix Invigil"}
          </Link>
        </div>

        <div className="relative min-h-[44dvh] border-rule lg:border-l lg:pl-12">
          <AsciiCanvas
            scene={radar}
            className="absolute inset-0 size-full"
          />
        </div>
      </div>
    </main>
  );
}
