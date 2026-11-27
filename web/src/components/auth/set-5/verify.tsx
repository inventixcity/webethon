"use client";

import { useState } from "react";
import { Reveal } from "@/components/motion/reveal";
import { maskEmail } from "@/features/auth/schemas";
import { useVerify } from "@/features/auth/use-verify";
import { VerifyPanel } from "../forms/verify-panel";
import { LotusScene } from "./lotus";
import { Shell, titleClass } from "./shell";

export default function Verify({ email, next }: { email?: string; next?: string }) {
  const [lotus] = useState(() => new LotusScene());
  const verify = useVerify({
    next,
    onCode: (code) => lotus.setCode(code),
    onStatus: (status) => lotus.setStatus(status),
  });

  return (
    <Shell scene={lotus}>
      <h1 className={titleClass}>
        <Reveal key={verify.verified ? "done" : "wait"}>{verify.verified ? "In full bloom" : "Six buds to open"}</Reveal>
      </h1>
      <p className="mt-2 mb-7 text-[15px] text-ink-soft">
        {verify.verified
          ? "You're verified."
          : email
            ? `Six digits are on their way to ${maskEmail(email)}.`
            : "Six digits are on their way."}
      </p>
      <VerifyPanel verify={verify} next={next} cellClassName="font-heading text-2xl font-light" />
    </Shell>
  );
}
