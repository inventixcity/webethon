/*
 * A quiet field of dots for empty states. A slow swell passes through it on the diagonal (one cycle in about
 * 14 seconds), and the pointer presses a ring into the field wherever it rests. Under reduced motion the swell
 * holds still, but the ring still follows the pointer.
 */
import type { AsciiFrame, AsciiScene } from "../ascii-canvas";
import { type AsciiGrid, approach, Tone } from "../grid";

const RAMP = ["·", "·", ":", "+", "×"];

export class DriftScene implements AsciiScene {
  fps = 16;
  dirty = false;
  /** Pointer in 0..1 of the canvas box, or null when it is away. */
  private target: { x: number; y: number } | null = null;
  private at = { x: 0.5, y: 0.5 };
  private presence = 0;

  point(x: number, y: number) {
    this.target = { x, y };
    this.dirty = true;
  }

  leave() {
    this.target = null;
    this.dirty = true;
  }

  draw(grid: AsciiGrid, { time, dt, reduced }: AsciiFrame) {
    const { cols, rows } = grid;
    if (cols === 0 || rows === 0) return;

    if (this.target) {
      this.at.x = approach(this.at.x, this.target.x, 8, dt, reduced);
      this.at.y = approach(this.at.y, this.target.y, 8, dt, reduced);
    }
    this.presence = approach(this.presence, this.target ? 1 : 0, 5, dt, reduced);
    // Keep easing toward the pointer between frames, even with no new input.
    if (Math.abs(this.presence - (this.target ? 1 : 0)) > 0.01) this.dirty = true;

    const px = this.at.x * cols;
    const py = this.at.y * rows;
    const phase = (time / 14) * Math.PI * 2;

    for (let y = 1; y < rows; y += 2) {
      for (let x = (y >> 1) % 2 === 0 ? 1 : 3; x < cols; x += 4) {
        // The swell: a soft diagonal wave.
        const swell = (Math.sin((x * 0.11 + y * 0.23) - phase) + 1) / 2;
        // The press: distance to the pointer, with cells twice as tall as wide.
        const dx = x - px;
        const dy = (y - py) * 2;
        const d = Math.sqrt(dx * dx + dy * dy);
        const ring = this.presence * Math.max(0, 1 - Math.abs(d - 9) / 4);
        const level = Math.min(RAMP.length - 1, Math.floor(swell * 2.2 + ring * 3));
        const char = RAMP[level] ?? "·";
        grid.set(x, y, char, level >= 3 ? Tone.base : Tone.muted);
      }
    }

    if (this.presence > 0.5) {
      const cx = Math.round(px);
      const cy = Math.round(py);
      grid.set(cx, cy, "+", Tone.accent);
    }
  }
}
