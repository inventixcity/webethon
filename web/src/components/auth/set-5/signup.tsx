"use client";

import { useCallback, useState } from "react";
import { Reveal } from "@/components/motion/reveal";
import { type SignupProgress, SignupForm } from "../forms/signup-form";
import { FernScene } from "./fern";
import { Shell, titleClass } from "./shell";

export default function Signup() {
  const [fern] = useState(() => new FernScene());
  const onProgress = useCallback(
    ({ name, email, passwordLength, strength, terms }: SignupProgress) => {
      fern.update({ typed: name.length + email.length + passwordLength, strength, terms });
    },
    [fern],
  );

  return (
    <Shell scene={fern}>
      <h1 className={titleClass}>
        <Reveal>Put down roots</Reveal>
      </h1>
      <p className="mt-2 mb-6 text-[15px] text-ink-soft">The fern uncoils a little with every letter.</p>
      <SignupForm layout="stack" onProgress={onProgress} />
    </Shell>
  );
}
