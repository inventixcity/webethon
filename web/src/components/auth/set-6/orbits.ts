import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";
import type { VerifyStatus } from "@/features/auth/use-verify";

const COUNT = 6;
const TILT = 0.34; // how much the rings are squashed, to read as a plane seen from an angle

type Moon = { digit?: string; angle: number; speed: number; arrive: number; fall: number };

/** Six moons entering orbit, one per digit. A wrong code decays them, and the right one lines them all up. */
export class OrbitScene implements LiveScene {
  dirty = false;

  private moons: Moon[] = Array.from({ length: COUNT }, (_, index) => ({
    angle: index * 2.1,
    speed: 0.62 - index * 0.075,
    arrive: 0,
    fall: 0,
  }));
  private aligned = false;

  setCode(code: string) {
    this.moons.forEach((moon, index) => {
      const digit = code[index];
      if (digit && !moon.digit) moon.arrive = 0;
      moon.digit = digit;
    });
    this.dirty = true;
  }

  setStatus(status: VerifyStatus) {
    this.aligned = status === "verified";
    if (status === "wrong") for (const moon of this.moons) moon.fall = 0.01;
    this.dirty = true;
  }

  draw(ctx: CanvasRenderingContext2D, { width, height, dt, reduced, colors, headingFont }: LiveFrame) {
    const cx = width > 900 ? width * 0.66 : width * 0.5;
    const cy = height * 0.56;
    const widest = Math.min(width * (width > 900 ? 0.31 : 0.46), height * 1.1);

    ctx.strokeStyle = colors.ink;
    for (let ring = 0; ring < COUNT; ring++) {
      const radius = widest * ((ring + 1.5) / (COUNT + 0.5));
      ctx.globalAlpha = this.moons[ring]?.digit ? 0.9 : 0.3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius, radius * TILT, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = this.aligned ? colors.accent : colors.ink;
    ctx.beginPath();
    ctx.arc(cx, cy, widest * 0.05, 0, Math.PI * 2);
    ctx.fill();

    const size = Math.max(11, widest * 0.04);
    this.moons.forEach((moon, index) => {
      const radius = widest * ((index + 1.5) / (COUNT + 0.5));
      if (reduced) {
        moon.arrive = 1;
        moon.fall = 0;
      }
      if (moon.fall > 0) {
        moon.fall += dt * 1.2;
        if (moon.fall > 1) moon.fall = 0;
      }
      moon.arrive = Math.min(1, moon.arrive + dt * 1.8);

      if (this.aligned) {
        // Every moon eases round to the same bearing, into one straight line.
        const wrapped = Math.atan2(Math.sin(-0.32 - moon.angle), Math.cos(-0.32 - moon.angle));
        moon.angle += wrapped * (reduced ? 1 : 1 - Math.exp(-4 * dt));
      } else {
        moon.angle += moon.speed * dt;
      }
      if (!moon.digit) return;

      const reach = radius * (1 + (1 - moon.arrive) ** 2 * 1.2) * (1 - moon.fall * moon.fall);
      const x = cx + Math.cos(moon.angle) * reach;
      const y = cy + Math.sin(moon.angle) * reach * TILT;

      ctx.fillStyle = this.aligned ? colors.accent : colors.raised;
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = this.aligned ? colors.paper : colors.ink;
      ctx.font = `800 ${size * 1.05}px ${headingFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(moon.digit, x, y + 1);
    });
  }
}
