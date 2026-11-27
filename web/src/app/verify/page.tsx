"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function formatCode(value: string) {
  const chars = value.toUpperCase().replace(/[^0-9A-HJKMNPQRSTVWXYZ]/g, "").slice(0, 12);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].filter(Boolean).join("-");
}

export default function VerifyPage() {
  const [code, setCode] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (code.replaceAll("-", "").length === 12) window.location.assign(`/verify/${encodeURIComponent(code)}`);
  };

  return (
    <main className="min-h-screen bg-paper px-5 py-12 text-ink sm:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-12 h-0.5 w-16 bg-vermilion" />
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">Inventix Invigil / Public record</p>
        <h1 className="mt-4 text-5xl font-semibold tracking-[-0.04em] sm:text-7xl">Verify a result.</h1>
        <p className="mt-6 max-w-xl text-base text-ink-soft">Enter the 12 character certificate code printed on the result statement.</p>
        <form onSubmit={submit} className="mt-10 flex max-w-xl flex-col gap-5 sm:flex-row sm:items-end">
          <label className="block flex-1">
            <span className="font-mono text-xs uppercase tracking-[0.12em]">Certificate code</span>
            <Input aria-label="Certificate code" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={(event) => setCode(formatCode(event.target.value))} placeholder="XXXX-XXXX-XXXX" className="mt-2 font-mono uppercase tracking-[0.18em]" />
          </label>
          <Button type="submit" disabled={code.replaceAll("-", "").length !== 12}>Verify code</Button>
        </form>
        <p className="mt-10 max-w-xl border-t border-rule pt-5 text-sm text-ink-muted">Verification checks the signed, masked certificate statement and whether it has been revoked. It does not reveal candidate contact details or exam answers.</p>
        <Link href="/" className="mt-12 inline-block font-mono text-xs uppercase tracking-[0.12em] underline underline-offset-4">Inventix Invigil</Link>
      </div>
    </main>
  );
}
