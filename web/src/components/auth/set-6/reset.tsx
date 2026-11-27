"use client";

import { useCallback, useState } from "react";
import { LiveCanvas } from "@/components/canvas/live-canvas";
import { ShaderCanvas } from "@/components/canvas/shader-canvas";
import { Reveal } from "@/components/motion/reveal";
import { ResetForm } from "../forms/reset-form";
import { Aurora } from "./aurora";
import { Shell } from "./shell";
import { ShardScene } from "./shards";

export default function Reset() {
  const [{ aurora, shards }] = useState(() => ({ aurora: new Aurora(0.2), shards: new ShardScene() }));
  const onValues = useCallback(
    (password: string, confirm: string, strength: number) => {
      shards.update(password, confirm, strength);
      aurora.rise(0.15 + strength * 0.8);
      if (password) aurora.pulse(0.4 + (Math.min(password.length, 16) / 16) * 0.56);
    },
    [aurora, shards],
  );

  return (
    <Shell
      sky={
        <>
          <div className="absolute inset-0">
            <ShaderCanvas scene={aurora} />
          </div>
          <div className="absolute inset-0">
            <LiveCanvas scene={shards} />
          </div>
        </>
      }
      title={<Reveal>Hard as ice</Reveal>}
      note="Every character raises a shard. Strength lights the sky, and repeating it caps each one."
    >
      <ResetForm onValues={onValues} />
    </Shell>
  );
}
