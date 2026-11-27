"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api/client";
import type { VerificationResult } from "@/lib/exam/types";

function mask(value: string) {
  const chars = value.toUpperCase().replace(/[^0-9A-HJKMNPQRSTVWXYZ]/g, "").slice(0, 12);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].filter(Boolean).join("-");
}

export default function CertificateVerificationPage() {
  const params = useParams<{ code: string }>();
  const code = Array.isArray(params.code) ? params.code[0] : params.code;
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(mask(code ?? ""));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api<VerificationResult>(`/verify/${encodeURIComponent(code ?? "")}`)
      .then((data) => { if (active) setResult(data); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof ApiError ? cause.message : "Verification could not be completed."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [code]);

  const state = result?.valid ? "VALID CERTIFICATE" : result?.revoked ? "REVOKED CERTIFICATE" : "INVALID CERTIFICATE";
  return (
    <main className="min-h-screen bg-paper px-5 py-12 text-ink sm:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-12 h-0.5 w-16 bg-vermilion" />
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">Inventix Invigil / Public record</p>
        <h1 className="mt-4 text-5xl font-semibold tracking-[-0.04em] sm:text-7xl">Certificate check.</h1>
        <form onSubmit={(event) => { event.preventDefault(); window.location.assign(`/verify/${encodeURIComponent(value)}`); }} className="mt-8 flex max-w-xl flex-col gap-4 sm:flex-row sm:items-end">
          <label className="block flex-1"><span className="font-mono text-xs uppercase tracking-[0.12em]">Certificate code</span><Input aria-label="Certificate code" autoComplete="off" value={value} onChange={(event) => setValue(mask(event.target.value))} className="mt-2 font-mono uppercase tracking-[0.18em]" /></label>
          <Button type="submit" disabled={value.replaceAll("-", "").length !== 12}>Check code</Button>
        </form>
        <section aria-live="polite" className="mt-10 border-t border-rule pt-7">
          {loading ? <p className="font-mono text-xs uppercase tracking-[0.12em]" role="status">Checking signature…</p> : error ? <div role="alert"><h2 className="text-2xl font-semibold">Could not verify</h2><p className="mt-3 text-ink-muted">{error}</p></div> : result ? <>
            <p className="font-mono text-xs uppercase tracking-[0.12em] text-vermilion-deep">{state}</p>
            {result.statement && <dl className="mt-7 grid gap-5 sm:grid-cols-2">
              <div><dt className="font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">Candidate</dt><dd className="mt-1 text-xl">{result.statement.candidate}</dd></div>
              <div><dt className="font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">Examination</dt><dd className="mt-1 text-xl">{result.statement.examTitle}</dd></div>
              <div><dt className="font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">Result</dt><dd className="mt-1 text-xl">{result.statement.percent}% · {result.statement.passed ? "Passed" : "Not passed"}</dd></div>
              <div><dt className="font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">Issued</dt><dd className="mt-1 text-xl">{new Date(result.statement.issuedAt).toLocaleDateString()}</dd></div>
            </dl>}
            {result.signature && <p className="mt-7 font-mono text-xs uppercase tracking-[0.1em]">Signed with Ed25519 · key {result.signature.keyId}{result.signature.valid ? " · signature valid" : " · signature invalid"}</p>}
            <p className="mt-8 max-w-2xl border-t border-rule pt-5 text-sm text-ink-muted">The signature verifies that the masked statement was issued by Inventix Invigil and has not been changed. This check does not show email addresses, candidate identifiers, answers, or per-question marks.</p>
          </> : null}
        </section>
        <Link href="/verify" className="mt-10 inline-block font-mono text-xs uppercase tracking-[0.12em] underline underline-offset-4">Enter another code</Link>
      </div>
    </main>
  );
}
