"use client";

import { useState } from "react";
import { LiveCanvas } from "@/components/canvas/live-canvas";
import { ShaderCanvas } from "@/components/canvas/shader-canvas";
import { Reveal } from "@/components/motion/reveal";
import { maskEmail } from "@/features/auth/schemas";
import { useVerify } from "@/features/auth/use-verify";
import { VerifyPanel } from "../forms/verify-panel";
import { Aurora } from "./aurora";
import { OrbitScene } from "./orbits";
import { Shell } from "./shell";

export default function Verify({ email, next }: { email?: string; next?: string }) {
  const [{ aurora, orbits }] = useState(() => ({ aurora: new Aurora(0.26), orbits: new OrbitScene() }));
  const verify = useVerify({
    next,
    onCode: (code) => {
      orbits.setCode(code);
      if (code) aurora.pulse(code.length / 7);
    },
    onStatus: (status) => {
      orbits.setStatus(status);
      aurora.rise(status === "verified" ? 1 : 0.26);
    },
  });

  return (
    <Shell
      sky={
        <>
          <div className="absolute inset-0">
            <ShaderCanvas scene={aurora} />
          </div>
          <div className="absolute inset-0">
            <LiveCanvas scene={orbits} />
          </div>
        </>
      }
      title={<Reveal key={verify.verified ? "done" : "wait"}>{verify.verified ? "In alignment" : "Six moons"}</Reveal>}
      note={
        verify.verified
          ? "You're verified."
          : email
            ? `Each digit sent to ${maskEmail(email)} puts a moon in orbit.`
            : "Each digit puts a moon in orbit."
      }
    >
      <div className="mx-auto w-full max-w-xl px-5 py-6">
        <VerifyPanel verify={verify} next={next} />
      </div>
    </Shell>
  );
}
