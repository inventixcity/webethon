"use client";

import { DemoFrame } from "../demo-frame";
import { TreemapShift } from "./treemap-shift";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// name, starting size, growth over the year, how much it swings, where its swing starts
const LINES = [
  ["Subscriptions", 62, 0.4, 0.06, 0],
  ["Enterprise", 44, 0.9, 0.12, 1.4],
  ["Add-ons", 30, 0.2, 0.2, 2.2],
  ["Services", 34, -0.35, 0.1, 0.6],
  ["Marketplace", 16, 1.8, 0.14, 3.1],
  ["Training", 14, -0.2, 0.22, 4.2],
  ["Support plans", 18, 0.1, 0.08, 5],
  ["Partners", 12, 0.7, 0.25, 1],
  ["Hardware", 22, -0.55, 0.12, 2.8],
] as const;

const SERIES = LINES.map(([name, size, growth, swing, phase]) => ({
  id: name,
  name,
  values: MONTHS.map((_, month) =>
    Math.round(size * (1 + (growth * month) / 11) * (1 + swing * Math.sin(month * 0.9 + phase))),
  ),
}));

export default function Demo() {
  return (
    <DemoFrame index="Data" title="Treemap shift" note="A year of revenue on a loop. Drag the slider to scrub through it, and hover a tile for its numbers.">
      <TreemapShift label="Revenue by product line" series={SERIES} steps={MONTHS} format={(value) => `$${value}k`} />
    </DemoFrame>
  );
}
