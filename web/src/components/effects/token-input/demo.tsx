"use client";

import { useState } from "react";
import { DemoFrame } from "../demo-frame";
import { TokenInput } from "./token-input";

const SKILLS = ["Design", "Development", "Marketing", "Research", "Sales", "Strategy", "Support", "Writing"];

export default function Demo() {
  const [tags, setTags] = useState(["Design", "Research"]);

  return (
    <DemoFrame index="Controls" title="Token input" note="Type to filter, press Enter or comma to add, and Backspace to take the last one away.">
      <TokenInput label="Team skills" value={tags} onChange={setTags} suggestions={SKILLS} />
    </DemoFrame>
  );
}
