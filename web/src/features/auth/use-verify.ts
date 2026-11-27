"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { resendCode, verifyCode } from "./client";
import { useAuthAction } from "./use-auth-action";
import { useAuthRoutes } from "./use-auth-routes";

export const CODE_LENGTH = 6;
const RESEND_SECONDS = 30;
/** Long enough to see the success state before moving on. */
const SUCCESS_PAUSE = 900;
/** The id of the code error. The code input points at it with aria-describedby. */
export const CODE_ERROR_ID = "verify-code-error";
const CODE_FIELDS = ["code"] as const;

export type VerifyStatus = "idle" | "checking" | "wrong" | "verified";

type UseVerifyOptions = {
  /** Set to "reset" when the visitor arrived from the forgot password flow. */
  next?: string;
  onCode?: (code: string) => void;
  onStatus?: (status: VerifyStatus) => void;
};

export function useVerify({ next, onCode, onStatus }: UseVerifyOptions = {}) {
  const router = useRouter();
  const routes = useAuthRoutes();
  const toast = useToast();
  const { pending, locked, fieldErrors, run } = useAuthAction();
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [wait, setWait] = useState(RESEND_SECONDS);
  // Authenticator codes (MFA) can't be resent by email, so the screen doesn't offer it.
  const [mfa, setMfa] = useState(false);

  useEffect(() => {
    setMfa(new URLSearchParams(window.location.search).has("mfa"));
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((value) => value - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);

  function change(value: string) {
    setCode(value);
    onCode?.(value);
    onStatus?.("idle");
  }

  async function complete(value: string) {
    onStatus?.("checking");
    const failure = await run("verify", () => verifyCode(value), CODE_FIELDS);
    if (failure) {
      setCode("");
      onCode?.("");
      onStatus?.("wrong");
      setAttempt((count) => count + 1);
      return;
    }
    onStatus?.("verified");
    setVerified(true);
    if (next === "reset") window.setTimeout(() => router.push(routes.reset), SUCCESS_PAUSE);
  }

  async function resend() {
    if (mfa) {
      toast.info("Codes come from your authenticator app.");
      return;
    }
    const failure = await run("resend", resendCode);
    if (!failure) setWait(RESEND_SECONDS);
  }

  const codeError = fieldErrors.code;

  return {
    code,
    change,
    complete,
    resend,
    verified,
    /** Bumps on each wrong code, so the input can remount and clear. */
    attempt,
    /** Seconds until the code can be sent again. */
    wait,
    checking: pending === "verify",
    sending: pending === "resend",
    busy: pending !== null,
    /** The wrong or used-up code message. Render it with <CodeError>, next to the code input. */
    codeError,
    /** Spread onto the code input: marks it invalid and links it to the error. */
    codeInputProps: {
      "aria-invalid": codeError ? true : undefined,
      "aria-describedby": codeError ? CODE_ERROR_ID : undefined,
    } as const,
    /** Seconds left on a rate limit. The code input stays disabled until it is 0. */
    locked,
    /** False for authenticator codes, where a new code can't be requested. */
    canResend: !mfa,
    routes,
  };
}
