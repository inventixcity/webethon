"use client";

import { useEffect, useState } from "react";
import { AsciiCanvas, type AsciiFrame, type AsciiScene } from "@/components/ascii/ascii-canvas";
import { type AsciiGrid, approach, Tone } from "@/components/ascii/grid";
import { useTheme } from "@/components/theme/theme";
import donut from "@/vendor/ascii-rest/donut";
import hourglass from "@/vendor/ascii-rest/hourglass";

class FrameScene implements AsciiScene {
  size: { cols: number; rows: number };
  fps: number;
  /** Whether the art sits on a light surface. */
  paper = true;
  private readonly frame: (time: number, paper: boolean) => string;

  constructor(frame: (time: number, paper: boolean) => string, cols: number, rows: number, fps: number) {
    this.frame = frame;
    this.size = { cols, rows };
    this.fps = fps;
  }

  draw(grid: AsciiGrid, { time }: AsciiFrame) {
    this.frame(time, this.paper)
      .split("\n")
      .forEach((line, row) => {
        grid.text(0, row, line);
      });
  }
}

/** The classic spinning torus, drawn in characters. */
export function DonutLoader({ className }: { className?: string }) {
  const [scene] = useState(() => {
    const frame = donut();
    return new FrameScene((time, paper) => frame(time * 1.4, { paper }), 40, 22, 30);
  });
  scene.paper = useTheme() === "light";

  return (
    <div role="status" aria-label="Loading" className={className}>
      <AsciiCanvas scene={scene} />
    </div>
  );
}

/** An hourglass with real falling sand, for longer waits. */
export function HourglassLoader({ className }: { className?: string }) {
  const [scene] = useState(() => {
    const frame = hourglass();
    return new FrameScene((time, paper) => frame(time, { paper }), 43, 21, 20);
  });
  scene.paper = useTheme() === "light";

  return (
    <div role="status" aria-label="Loading" className={className}>
      <AsciiCanvas scene={scene} />
    </div>
  );
}

const SHARK_COLS = 72;
const SHARK_ROWS = 6;
// Two frames, jaw shut and jaw open with teeth.
const SHARK = [
  ["          ,/|", " \\\\______/  |_____", " ||              o\\", " //__\\__/________.'"],
  ["          ,/|", " \\\\______/  |_____", " ||              o\\", " //__\\__/vVvVvVvV/ "],
];
const SHARK_WIDTH = 19;
const WATERLINE = 3;
const EYE_COLUMN = 17;

class SharkScene implements AsciiScene {
  size = { cols: SHARK_COLS, rows: SHARK_ROWS };
  fps = 18;
  dirty = false;
  target = 0;
  private shown = 0;

  setValue(value: number) {
    this.target = value;
    this.dirty = true;
  }

  draw(grid: AsciiGrid, { time, dt, reduced }: AsciiFrame) {
    this.shown = approach(this.shown, this.target, 6, dt, reduced);
    const front = Math.round((this.shown / 100) * (SHARK_COLS - 7));
    const left = front - SHARK_WIDTH + 2;

    // The shark eats the dots as it passes. What's behind it stays clear.
    for (let x = front + 1; x < SHARK_COLS - 5; x += 2) grid.set(x, WATERLINE, "·", Tone.base);
    for (let x = 0; x < left; x++) {
      if ((x + Math.floor(time * 3)) % 9 === 0) grid.set(x, WATERLINE - 1, "~", Tone.muted);
    }
    const sprite = SHARK[Math.floor(time * 5) % SHARK.length] ?? SHARK[0] ?? [];
    sprite.forEach((line, row) => {
      grid.blit(line, left, 1 + row);
    });
    grid.set(left + EYE_COLUMN, WATERLINE, "o", Tone.accent);
    grid.text(SHARK_COLS - 4, WATERLINE, `${String(Math.round(this.shown)).padStart(3, " ")}%`, Tone.accent);
  }
}

/** A shark that eats its way along the bar. Pass real progress from 0 to 100. */
export function SharkProgress({ value, className }: { value: number; className?: string }) {
  const [scene] = useState(() => new SharkScene());

  useEffect(() => {
    scene.setValue(value);
  }, [scene, value]);

  return (
    <div
      role="progressbar"
      aria-label="Progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      className={className}
    >
      <AsciiCanvas scene={scene} />
    </div>
  );
}
