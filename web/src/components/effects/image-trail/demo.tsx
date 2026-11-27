"use client";

import { ImageTrail } from "./image-trail";

const SPECIMENS = [
  { glyph: "A", tone: "bg-ink text-paper" },
  { glyph: "&", tone: "bg-vermilion text-white" },
  { glyph: "g", tone: "bg-paper-sunk text-ink" },
  { glyph: "?", tone: "bg-paper-raised text-ink" },
  { glyph: "R", tone: "bg-ink text-paper" },
  { glyph: "%", tone: "bg-paper-sunk text-vermilion" },
  { glyph: "Q", tone: "bg-vermilion text-white" },
];

const TILES = SPECIMENS.map(({ glyph, tone }) => (
  <div key={glyph} className={`flex size-44 items-center justify-center border border-ink font-heading text-[7.5rem] leading-none font-semibold ${tone}`}>
    {glyph}
  </div>
));

export default function Demo() {
  return (
    <ImageTrail items={TILES} className="flex min-h-dvh flex-col items-center justify-center bg-paper px-5 text-center text-ink">
      <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Layout</p>
      <h1 className="mt-3 text-[clamp(2.25rem,4vw,3.5rem)] leading-none font-semibold tracking-[-0.03em]">Image trail</h1>
      <p className="mt-3 max-w-md text-base text-ink-soft">Move across the page. Move faster and the tiles land bigger. Swap these for product shots.</p>
    </ImageTrail>
  );
}
