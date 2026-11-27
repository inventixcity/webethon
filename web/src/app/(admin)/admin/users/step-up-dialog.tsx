"use client";

import { useId, useState, type FormEvent } from "react";
import { api } from "@/lib/api/client";
import { FieldError } from "@/components/feedback/field-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { messageOf } from "@/components/analytics/format";

/** Confirms an admin's identity before retrying a sensitive action. */
export function StepUpDialog({ onCancel, onVerified }: { onCancel: () => void; onVerified: () => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<{ expiresAt: string }>("/admin/step-up", {
        body: { password, ...(code.trim() ? { code: code.trim() } : {}) },
      });
      setPassword("");
      setCode("");
      onVerified();
    } catch (cause) {
      setPassword("");
      setCode("");
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/60 p-4">
      <form role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`} onSubmit={submit} className="grid w-full max-w-md gap-5 border border-ink bg-paper p-6 text-ink">
        <h2 id={`${ids}-title`} className="text-2xl leading-none font-semibold tracking-tight">Verify your identity</h2>
        <p className="text-sm text-ink-soft">Enter your password and, if you use one, your authenticator code. Then the action will run again.</p>
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-password`}>Password</Label>
          <Input id={`${ids}-password`} type="password" autoComplete="current-password" required autoFocus value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby={error ? `${ids}-error` : undefined} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-code`}>Authenticator code (if enabled)</Label>
          <Input id={`${ids}-code`} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
        </div>
        <FieldError id={`${ids}-error`} message={error} />
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" size="sm" loading={busy} disabled={!password}>Verify</Button>
        </div>
      </form>
    </div>
  );
}
