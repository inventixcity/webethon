"use client";

import { useState } from "react";
import { DemoFrame } from "../demo-frame";
import { HoldButton } from "./hold-button";

export default function Demo() {
  const [key, setKey] = useState(0);

  return (
    <DemoFrame index="Controls" title="Hold button" note="For the actions that shouldn't be one click. Let go early and it drains back.">
      <div className="grid justify-items-center gap-5">
        <HoldButton key={key} label="Hold to delete project" doneLabel="Project deleted" />
        <button
          type="button"
          onClick={() => setKey((value) => value + 1)}
          className="cursor-pointer font-mono text-[11px] tracking-[0.12em] uppercase underline underline-offset-4"
        >
          Reset
        </button>
      </div>
    </DemoFrame>
  );
}
