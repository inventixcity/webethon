import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";
import type { VerifyStatus } from "@/features/auth/use-verify";
import { paintRipples, paintWater } from "./pond";

const COUNT = 6;

type Bloom = { digit?: string; open: number; velocity: number };
type Ripple = { x: number; y: number; age: number; strength: number };

/** Six lotus buds on the water. A digit opens one, a wrong code closes them all, and the right one lights them. */
export class LotusScene implements LiveScene {
  dirty = false;

  private blooms: Bloom[] = Array.from({ length: COUNT }, () => ({ open: 0, velocity: 0 }));
  private ripples: Ripple[] = [];
  private verified = false;
  private shake = 0;
  private width = 0;
  private height = 0;

  private place(index: number): [number, number] {
    const across = this.width > 1024 ? this.width * 0.62 : this.width;
    const x = across * ((index + 0.5) / COUNT) * 0.86 + across * 0.07;
    return [x, this.height * (0.5 + Math.sin(index * 1.15 + 0.4) * 0.14)];
  }

  setCode(code: string) {
    this.blooms.forEach((bloom, index) => {
      const digit = code[index];
      if (digit && !bloom.digit) {
        const [x, y] = this.place(index);
        this.ripples.push({ x, y, age: 0, strength: 1 });
      }
      bloom.digit = digit;
    });
    this.dirty = true;
  }

  setStatus(status: VerifyStatus) {
    this.verified = status === "verified";
    if (status === "wrong") this.shake = 1;
    this.dirty = true;
  }

  private petal(ctx: CanvasRenderingContext2D, length: number, width: number) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(width, -length * 0.3, width * 0.7, -length * 0.8, 0, -length);
    ctx.bezierCurveTo(-width * 0.7, -length * 0.8, -width, -length * 0.3, 0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  draw(ctx: CanvasRenderingContext2D, frame: LiveFrame) {
    const { width, height, time, dt, reduced, colors, headingFont } = frame;
    this.width = width;
    this.height = height;
    this.shake = Math.max(0, this.shake - dt * 1.6);

    paintWater(ctx, frame);
    for (const ripple of this.ripples) ripple.age += dt;
    this.ripples = this.ripples.filter((ripple) => ripple.age < 2.8);
    paintRipples(ctx, this.ripples, colors);

    const size = Math.min((width > 1024 ? width * 0.62 : width) / (COUNT * 1.5), height * 0.17);

    this.blooms.forEach((bloom, index) => {
      const target = bloom.digit ? (this.verified ? 1 : 0.72) : 0.04;
      if (reduced) {
        bloom.open = target;
      } else {
        // A soft spring, so petals overshoot and relax as they open.
        bloom.velocity += (target - bloom.open) * 46 * dt;
        bloom.velocity *= Math.exp(-7 * dt);
        bloom.open += bloom.velocity * dt;
      }
      const [baseX, baseY] = this.place(index);
      const x = baseX + Math.sin(time * 26 + index) * this.shake * 5;
      const y = baseY + (reduced ? 0 : Math.sin(time * 0.8 + index) * 3);

      // The pad beneath.
      ctx.fillStyle = colors.sceneC;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.ellipse(x, y + size * 0.42, size * 1.18, size * 0.36, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.save();
      ctx.translate(x, y + size * 0.36);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1;
      ctx.fillStyle = colors.raised;
      const spread = 1.5 * bloom.open + 0.06;
      for (const [petals, length, widthScale, fan] of [
        [7, size * 1.14, 0.34, 1],
        [5, size * 1.02, 0.3, 0.68],
        [3, size * 0.86, 0.26, 0.34],
      ] as const) {
        for (let petal = 0; petal < petals; petal++) {
          const angle = ((petal - (petals - 1) / 2) / Math.max(1, (petals - 1) / 2)) * spread * fan;
          ctx.save();
          ctx.rotate(angle);
          this.petal(ctx, length, size * widthScale);
          ctx.restore();
        }
      }
      ctx.restore();

      if (bloom.digit) {
        // Always ink: the accent is too faint on the bone petals in light mode, when the code is verified.
        ctx.fillStyle = colors.ink;
        ctx.font = `300 ${size * 0.74}px ${headingFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(bloom.digit, x, y - size * 0.1);
      }
    });
  }
}
