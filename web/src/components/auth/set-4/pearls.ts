import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";
import type { VerifyStatus } from "@/features/auth/use-verify";

const COUNT = 6;

type Pearl = { digit?: string; along: number; y: number; fall: number };

/** A strand of six pearls. Each digit threads one on, a wrong code snaps it, and the right one clasps it. */
export class PearlScene implements LiveScene {
  dirty = false;

  private pearls: Pearl[] = Array.from({ length: COUNT }, () => ({ along: 0, y: 0, fall: 0 }));
  private snapped = 0;
  private clasped = false;
  private glint = -1;

  setCode(code: string) {
    this.pearls.forEach((pearl, index) => {
      const digit = code[index];
      if (digit && !pearl.digit) pearl.along = 0;
      pearl.digit = digit;
    });
    this.dirty = true;
  }

  setStatus(status: VerifyStatus) {
    if (status === "wrong") {
      this.snapped = 1;
      // Pearls already on the strand fall as they were; this only starts the fall.
      for (const pearl of this.pearls) pearl.fall = 0.01;
    }
    this.clasped = status === "verified";
    if (status === "verified") this.glint = 0;
    this.dirty = true;
  }

  draw(ctx: CanvasRenderingContext2D, { width, height, time, dt, reduced, colors, headingFont }: LiveFrame) {
    const left = width * 0.08;
    const span = width * 0.84;
    const sag = height * 0.3;
    const top = height * 0.3;
    const strand = (u: number): [number, number] => [left + span * u, top + sag * (1 - (2 * u - 1) ** 2)];
    const size = Math.min(span / (COUNT * 2.6), height * 0.13);

    this.snapped = Math.max(0, this.snapped - dt * 0.8);
    if (this.glint >= 0) this.glint = this.glint > 1.4 ? -1 : this.glint + dt * 0.9;

    // The strand. When snapped, it hangs from each end, parted in the middle.
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const gap = this.snapped > 0 ? 0.12 + this.snapped * 0.2 : 0;
    for (let i = 0; i <= 80; i++) {
      const u = i / 80;
      if (gap > 0 && Math.abs(u - 0.5) < gap) {
        ctx.stroke();
        ctx.beginPath();
        continue;
      }
      const [x, y] = strand(u);
      const droop = gap > 0 ? (0.5 - Math.abs(u - 0.5)) * height * 0.5 * this.snapped : 0;
      if (i === 0) ctx.moveTo(x, y + droop);
      else ctx.lineTo(x, y + droop);
    }
    ctx.stroke();

    // The clasp ends.
    ctx.fillStyle = this.clasped ? colors.accent : colors.ink;
    for (const u of [0, 1]) {
      const [x, y] = strand(u);
      ctx.fillRect(x - 5, y - 9, 10, 18);
    }

    this.pearls.forEach((pearl, index) => {
      if (pearl.fall > 0) {
        pearl.fall += dt * 2.4;
        if (pearl.fall > 1.6 || reduced) {
          pearl.fall = 0;
          pearl.digit = undefined;
          pearl.along = 0;
        }
      }
      const home = (index + 0.5) / COUNT;
      if (!pearl.digit) return;
      // Slides in from the left end of the strand, with a little overshoot.
      pearl.along += (1 - pearl.along) * (reduced ? 1 : 1 - Math.exp(-9 * dt));
      const u = home * pearl.along;
      const [x, y] = strand(u);
      const py = y + size * 0.9 + (pearl.fall > 0 ? pearl.fall * pearl.fall * height * 0.6 : 0);
      const bob = reduced ? 0 : Math.sin(time * 1.4 + index) * 1.5;

      const shine = ctx.createRadialGradient(x - size * 0.32, py - size * 0.36 + bob, size * 0.1, x, py + bob, size);
      shine.addColorStop(0, colors.raised);
      shine.addColorStop(0.62, colors.sunk);
      shine.addColorStop(1, colors.muted);
      ctx.fillStyle = shine;
      ctx.beginPath();
      ctx.arc(x, py + bob, size, 0, Math.PI * 2);
      ctx.fill();

      if (this.glint >= 0) {
        const sweep = Math.exp(-(((this.glint - index / COUNT) * 9) ** 2));
        if (sweep > 0.02) {
          ctx.fillStyle = colors.accent;
          ctx.globalAlpha = sweep * 0.8;
          ctx.beginPath();
          ctx.arc(x, py + bob, size, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      ctx.fillStyle = colors.ink;
      ctx.font = `italic ${size * 1.05}px ${headingFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(pearl.digit, x, py + bob + size * 0.04);
    });
  }
}
