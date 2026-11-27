"use client";

import { useCallback, useState } from "react";
import { LiveCanvas } from "@/components/canvas/live-canvas";
import { ShaderCanvas } from "@/components/canvas/shader-canvas";
import { Reveal } from "@/components/motion/reveal";
import { type SignupProgress, SignupForm } from "../forms/signup-form";
import { Aurora } from "./aurora";
import { Shell } from "./shell";
import { SnowflakeScene } from "./snowflake";

export default function Signup() {
  const [{ aurora, flake }] = useState(() => ({ aurora: new Aurora(0.3), flake: new SnowflakeScene() }));

  const onProgress = useCallback(
    ({ name, email, passwordLength, strength, terms }: SignupProgress) => {
      flake.update(`${name}${email}`, passwordLength, strength, terms);
      aurora.rise(0.25 + strength * 0.5);
      if (name.length + email.length + passwordLength > 0) aurora.pulse(0.68);
    },
    [aurora, flake],
  );

  return (
    <Shell
      sky={
        <>
          <div className="absolute inset-0">
            <ShaderCanvas scene={aurora} />
          </div>
          <div className="absolute inset-0">
            <LiveCanvas scene={flake} />
          </div>
        </>
      }
      title={<Reveal>No two alike</Reveal>}
      note="Your details grow a snowflake that belongs to you alone."
    >
      <div className="px-5 py-6 md:px-8">
        <SignupForm layout="row" onProgress={onProgress} />
      </div>
    </Shell>
  );
}
