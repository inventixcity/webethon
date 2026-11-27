"use client";

import { useCallback, useState } from "react";
import { Reveal } from "@/components/motion/reveal";
import { ResetForm } from "../forms/reset-form";
import { RingsScene } from "./rings";
import { Shell, titleClass } from "./shell";

export default function Reset() {
  const [rings] = useState(() => new RingsScene());
  const onValues = useCallback(
    (password: string, confirm: string, strength: number) => rings.update(password, confirm, strength),
    [rings],
  );

  return (
    <Shell scene={rings}>
      <h1 className={titleClass}>
        <Reveal>Grow a new one</Reveal>
      </h1>
      <p className="mt-2 mb-7 text-[15px] text-ink-soft">
        Each character lays a growth ring. Type it again to trace them in brass.
      </p>
      <ResetForm layout="column" hideMeter onValues={onValues} />
    </Shell>
  );
}
