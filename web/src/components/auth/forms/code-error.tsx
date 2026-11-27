"use client";

import { type useVerify, CODE_ERROR_ID } from "@/features/auth/use-verify";
import { FieldError } from "../field";

/**
 * The wrong or used-up code message. The resend control is the screen's own "Resend code" button, so this
 * renders the message only and there is one resend control per verify screen.
 */
export function CodeError({ verify }: { verify: ReturnType<typeof useVerify> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <FieldError id={CODE_ERROR_ID} message={verify.codeError} />
    </div>
  );
}
