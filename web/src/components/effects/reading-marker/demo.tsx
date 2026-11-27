"use client";

import { Mark, ReadingMarker } from "./reading-marker";

const FILLER =
  "Teams that write things down argue less. Not because they agree more, but because the disagreement moves off people and on to the page, where it can be edited.";

export default function Demo() {
  return (
    <section className="bg-paper px-5 py-16 pb-[60dvh] text-ink md:px-16">
      <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Layout</p>
      <h1 className="mt-3 text-[clamp(2.25rem,4vw,3.5rem)] leading-none font-semibold tracking-[-0.03em]">Reading marker</h1>
      <p className="mt-3 max-w-xl text-base text-ink-soft">Scroll down slowly. The pen draws as each phrase reaches it, and backs up if you do.</p>

      <div className="mt-16">
        <ReadingMarker>
          <div className="grid gap-6 text-xl leading-relaxed">
            <p>
              Most projects don&apos;t fail in a single moment. <Mark>They drift, one small unwritten decision at a time,</Mark> until nobody
              can say what the goal was. {FILLER}
            </p>
            <p>
              {FILLER} The fix is rarely a better tool. <Mark>A one-page brief, kept up to date, beats any dashboard you can buy,</Mark> because
              somebody has to think to write it.
            </p>
            <p>
              {FILLER} {FILLER}
            </p>
            <p>
              Start small. Pick the next decision your team has to make, and{" "}
              <Mark>write down what you chose, what you turned down, and why, before you move on.</Mark> Do that for a month. {FILLER}
            </p>
            <p>
              {FILLER} People who join later can read how you got here. <Mark>That record is worth more than the meeting it came from.</Mark> {FILLER}
            </p>
          </div>
        </ReadingMarker>
      </div>
    </section>
  );
}
