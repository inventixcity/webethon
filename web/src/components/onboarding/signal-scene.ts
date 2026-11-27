import type { AsciiFrame, AsciiScene } from "@/components/ascii/ascii-canvas";
import { type AsciiGrid, Tone } from "@/components/ascii/grid";

export type SignalState = { lit: number; total: number };

const TAU = Math.PI * 2;

function wrapAngle(angle: number) {
  let value = angle % TAU;
  if (value > Math.PI) value -= TAU;
  if (value < -Math.PI) value += TAU;
  return value;
}

/**
 * A radar sweep that answers the visitor. Each question answered lights one blip, and the count reads
 * out under the scope. The sweep keeps turning on its own, and stops under reduced motion.
 *
 * `state` is read on every frame, so the caller only changes the numbers and sets `scene.dirty` to
 * redraw straight away.
 */
export function createSignalScene(state: { current: SignalState }): AsciiScene & { dirty: boolean } {
  return {
    fps: 30,
    dirty: false,
    draw(grid: AsciiGrid, frame: AsciiFrame) {
      const { lit, total } = state.current;
      const cx = (grid.cols - 1) / 2;
      const cy = (grid.rows - 1) / 2;
      // Terminal cells are about twice as tall as they are wide, so vertical distances are doubled.
      const radius = Math.max(4, Math.min(grid.cols * 0.42, grid.rows * 0.8));
      const sweep = frame.reduced ? 0 : frame.time * 0.9;

      for (let y = 0; y < grid.rows; y++) {
        for (let x = 0; x < grid.cols; x++) {
          const dx = x - cx;
          const dy = (y - cy) * 2;
          const distance = Math.hypot(dx, dy);
          const angle = Math.atan2(dy, dx);
          if (Math.abs(distance - radius) < 0.6 || Math.abs(distance - radius * 0.5) < 0.45) {
            grid.set(x, y, "·", Tone.muted);
          } else if (distance < radius) {
            const behind = wrapAngle(angle - sweep);
            if (Math.abs(behind) < 0.05) grid.set(x, y, "|", Tone.accent);
            else if (behind < 0 && behind > -0.9) grid.set(x, y, "░", Tone.muted);
          }
        }
      }

      // One blip per question. Answered blips are solid; the rest are faint placeholders.
      const count = Math.max(total, 1);
      for (let index = 0; index < total; index++) {
        const angle = -Math.PI / 2 + (index / count) * TAU;
        const bx = Math.round(cx + Math.cos(angle) * radius * 0.7);
        const by = Math.round(cy + (Math.sin(angle) * radius * 0.7) / 2);
        if (index < lit) grid.set(bx, by, "●", Tone.accent);
        else grid.set(bx, by, "+", Tone.muted);
      }

      const label = `${lit} OF ${total} SIGNALS`;
      const row = Math.max(0, grid.rows - 1);
      grid.text(Math.max(0, Math.round(cx - label.length / 2)), row, label, Tone.muted);
    },
  };
}
