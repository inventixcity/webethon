"use client";

import { DemoFrame } from "../demo-frame";
import { ExpandingPanels } from "./expanding-panels";

const PANELS = [
  { id: "plan", kicker: "Week one", title: "Plan", body: "Agree the goal, name an owner, and write down what done looks like." },
  { id: "draft", kicker: "Week two", title: "Draft", body: "Get a rough version in front of real people before it gets polished." },
  { id: "test", kicker: "Week three", title: "Test", body: "Watch five people use it. Fix what stopped them, and leave the rest." },
  { id: "ship", kicker: "Week four", title: "Ship", body: "Send it out with a way back, and tell everyone what changed and why." },
  { id: "learn", kicker: "After launch", title: "Learn", body: "Read the numbers after a week, keep what worked, and start again." },
];

export default function Demo() {
  return (
    <DemoFrame index="Layout" title="Expanding panels" note="The swell follows your pointer exactly. Leave it alone and it rolls along the row by itself.">
      <ExpandingPanels panels={PANELS} />
    </DemoFrame>
  );
}
