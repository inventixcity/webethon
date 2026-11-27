import fractalTree from "@/vendor/ascii-rest/fractal-tree";
import type { AsciiFrame, AsciiScene } from "../ascii-canvas";
import { type AsciiGrid, approach, clamp, hash, Tone } from "../grid";

export type TreeInput = {
  /** Characters typed into each field. */
  name: number;
  email: number;
  password: number;
  /** Password strength from 0 to 1. */
  strength: number;
  /** Whether the terms are accepted. */
  terms: boolean;
};

const COLS = 60;
const ROWS = 29;
/** The rows above this hold the crown, where blossoms can open. */
const CROWN_FLOOR = 20;

/** A tree that grows from the signup form: each keystroke adds to it and stirs the branches. */
export class TreeScene implements AsciiScene {
  size = { cols: COLS, rows: ROWS };
  fps = 18;
  dirty = false;

  private readonly picture = fractalTree();
  private growthTarget = 0;
  private leavesTarget = 0;
  private blossomTarget = 0;
  private growth = 0;
  private leaves = 0;
  private blossom = 0;
  private gust = 0;
  private typed = 0;
  private paper = true;

  /** Tells the tree whether it sits on a light surface, which flips how leaves are shaded. */
  setSurface(paper: boolean) {
    this.paper = paper;
    this.dirty = true;
  }

  update({ name, email, password, strength, terms }: TreeInput) {
    const typed = name + email + password;
    if (typed !== this.typed) {
      this.typed = typed;
      this.gust = 1;
    }
    // Name raises the trunk, email spreads the limbs, and a strong password fills the crown.
    this.growthTarget = clamp(
      0.12 + clamp(name / 12) * 0.28 + clamp(email / 18) * 0.42 + clamp(password / 10) * 0.18,
    );
    this.leavesTarget = clamp((email >= 6 ? 0.15 : 0) + strength * 0.85);
    this.blossomTarget = terms ? 1 : 0;
    this.dirty = true;
  }

  draw(grid: AsciiGrid, { time, dt, reduced }: AsciiFrame) {
    this.growth = approach(this.growth, this.growthTarget, 3.5, dt, reduced);
    this.leaves = approach(this.leaves, this.leavesTarget, 3, dt, reduced);
    this.blossom = approach(this.blossom, this.blossomTarget, 2.5, dt, reduced);
    this.gust = reduced ? 0 : Math.max(0, this.gust - dt * 2.2);

    const frame = this.picture(time, {
      paper: this.paper,
      growth: this.growth,
      leaves: this.leaves,
      gust: this.gust * 1.6,
    });
    frame.split("\n").forEach((line, row) => {
      grid.text(0, row, line);
    });

    if (this.blossom < 0.02) return;
    for (let y = 0; y < CROWN_FLOOR; y++) {
      for (let x = 0; x < grid.cols; x++) {
        const char = grid.get(x, y);
        if (char === " " || char === "/" || char === "\\" || char === "|") continue;
        if (hash(x + 3, y + 9) < 0.09 * this.blossom) grid.set(x, y, "*", Tone.accent);
      }
    }
  }
}
