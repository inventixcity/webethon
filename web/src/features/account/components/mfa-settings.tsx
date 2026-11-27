"use client";

import { useEffect, useState } from "react";
import { Field, PasswordField } from "@/components/auth/field";
import { SubmitButton } from "@/components/auth/submit-button";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { disableMfa, enableMfa, getMfaStatus, regenerateMfaCodes, setupMfa, type MfaSetup, type MfaStatus } from "../client";
import { showFormError, toastFor } from "../errors";

type Step = "status" | "setup" | "verify" | "disable" | "regenerate" | "codes";

const MFA_FIELDS = ["password", "code"] as const;
type FieldErrors = Partial<Record<(typeof MFA_FIELDS)[number], string>>;

export function MfaSettings({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<MfaStatus>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState<Step>("status");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<MfaSetup>();
  const [codes, setCodes] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    getMfaStatus()
      .then((value) => { if (active) setStatus(value); })
      .catch((cause) => {
        if (!active) return;
        setLoadFailed(true);
        toast.error(toastFor(cause));
      });
    return () => { active = false; };
  }, [toast]);

  function changeStep(next: Step) {
    setPassword("");
    setCode("");
    setSetup(undefined);
    setCodes([]);
    setFieldErrors({});
    setNotice("");
    setStep(next);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFieldErrors({});
    try {
      if (step === "setup") {
        const result = await setupMfa(password);
        changeStep("verify");
        setSetup(result);
      } else if (step === "verify") {
        const result = await enableMfa(code);
        changeStep("codes");
        setCodes(result.recoveryCodes);
        setStatus({ totpEnabled: true, recoveryCodesRemaining: result.recoveryCodes.length });
        onChanged();
      } else if (step === "disable") {
        await disableMfa(password, code);
        changeStep("status");
        setStatus({ totpEnabled: false, recoveryCodesRemaining: 0 });
        setNotice("Two-step verification is off.");
        onChanged();
      } else if (step === "regenerate") {
        const result = await regenerateMfaCodes(password, code);
        changeStep("codes");
        setCodes(result.recoveryCodes);
        setStatus({ totpEnabled: true, recoveryCodesRemaining: result.recoveryCodes.length });
      }
    } catch (cause) {
      showFormError(cause, MFA_FIELDS, toast, (field, message) => {
        setFieldErrors((current) => ({ ...current, [field]: message }));
      });
    } finally {
      setPending(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Copied to clipboard.");
    } catch {
      toast.error("Could not copy. Select and copy the text instead.");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([codes.join("\n") + "\n"], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  const qr = setup ? `data:image/svg+xml;base64,${btoa(Array.from(new TextEncoder().encode(setup.qrSvg), (byte) => String.fromCharCode(byte)).join(""))}` : "";

  return (
    <div className="grid gap-5">
      {step === "status" && (
        <>
          <p>{status ? (status.totpEnabled ? `Enabled · ${status.recoveryCodesRemaining} recovery codes remaining` : "Not enabled") : loadFailed ? "Status unavailable." : "Loading status…"}</p>
          {status && <div className="flex flex-wrap gap-3">
            {status.totpEnabled ? <>
              <Button type="button" onClick={() => changeStep("disable")}>Turn off</Button>
              <Button type="button" variant="secondary" onClick={() => changeStep("regenerate")}>Regenerate recovery codes</Button>
            </> : <Button type="button" onClick={() => changeStep("setup")}>Enable two-step verification</Button>}
          </div>}
        </>
      )}
      {step === "codes" && <>
        <p>Save these recovery codes somewhere safe. They will not be shown again. Each code can be used once.</p>
        <pre className="overflow-auto border border-rule bg-paper p-4 font-mono text-sm">{codes.join("\n")}</pre>
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="secondary" onClick={() => void copy(codes.join("\n"))}>Copy codes</Button>
          <Button type="button" variant="secondary" onClick={download}>Download .txt</Button>
          <Button type="button" onClick={() => changeStep("status")}>I saved them</Button>
        </div>
      </>}
      {step !== "status" && step !== "codes" && <form onSubmit={submit} className="grid gap-5">
        {step === "verify" && setup && <>
          <p>Scan this QR code in your authenticator app, or enter the secret manually.</p>
          <img src={qr} alt="Authenticator setup QR code" data-theme="light" className="size-48 bg-paper-raised" />
          <div className="break-all border border-rule bg-paper p-4 font-mono text-sm">{setup.secret}</div>
          <Button type="button" variant="secondary" onClick={() => void copy(setup.secret)}>Copy secret</Button>
        </>}
        {step === "regenerate" && <p>Generating new codes invalidates every old recovery code.</p>}
        {step !== "verify" && <PasswordField label="Current password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} error={fieldErrors.password} />}
        {step !== "setup" && <Field label={step === "verify" ? "Authenticator code" : "Authenticator or recovery code"} autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value)} error={fieldErrors.code} />}
        <SubmitButton pending={pending} pendingLabel="Working…">{step === "setup" ? "Continue" : step === "verify" ? "Enable" : step === "disable" ? "Turn off" : "Generate codes"}</SubmitButton>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => changeStep("status")}>Cancel</Button>
      </form>}
      <div aria-live="polite" className="font-mono text-xs text-ink-muted">{notice}</div>
    </div>
  );
}
