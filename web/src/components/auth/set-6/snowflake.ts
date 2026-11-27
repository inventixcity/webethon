import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";
import { hash } from "@/components/ascii/grid";

type Branch = { along: number; length: number; angle: number; grown: number };

const ARMS = 6;

/** A snow crystal that grows a new branch for each character, so every signup makes a different flake. */
export class SnowflakeScene implements LiveScene {
  dirty = false;

  private branches: Branch[] = [];
  private arm = 0;
  private armTarget = 0;
  private spin = 0;
  private strength = 0;
  private finished = false;
  private burst = 0;

  update(text: string, passwordLength: number, strength: number, terms: boolean) {
    const all = `${text}${"*".repeat(passwordLength)}`.slice(0, 26);
    this.branches = Array.from(all, (char, index) => {
      const existing = this.branches[index];
      const code = char.charCodeAt(0);
      return {
        along: 0.14 + (index / 26) * 0.76,
        length: 0.1 + hash(code, index + 2) * 0.28,
        angle: 0.8 + hash(code + 3, index) * 0.5,
        grown: existing?.grown ?? 0,
      };
    });
    this.armTarget = Math.min(1, 0.12 + all.length / 26);
    this.strength = strength;
    if (terms && !this.finished) this.burst = 1;
    this.finished = terms;
    this.dirty = true;
  }

  draw(ctx: CanvasRenderingContext2D, { width, height, dt, reduced, colors }: LiveFrame) {
    const ease = (rate: number) => (reduced ? 1 : 1 - Math.exp(-rate * dt));
    this.arm += (this.armTarget - this.arm) * ease(6);
    this.spin += dt * (0.07 + this.burst * 1.4);
    this.burst = Math.max(0, this.burst - dt * 0.8);

    const radius = Math.min(height * 0.42, width * 0.36);
    const cx = width > 900 ? width * 0.76 : width * 0.5;
    const cy = height * 0.54;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.spin);
    ctx.strokeStyle = colors.ink;
    ctx.lineCap = "round";

    const length = radius * this.arm;
    for (let arm = 0; arm < ARMS; arm++) {
      ctx.save();
      ctx.rotate((arm / ARMS) * Math.PI * 2);
      ctx.lineWidth = 2 + this.strength * 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(length, 0);
      ctx.stroke();

      for (const branch of this.branches) {
        if (branch.along * radius > length) continue;
        const x = branch.along * radius;
        const size = branch.length * radius * branch.grown;
        ctx.lineWidth = 1 + this.strength;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + Math.cos(branch.angle) * size, side * Math.sin(branch.angle) * size);
          ctx.stroke();
          // A strong password adds a second tier of tiny side branches.
          if (this.strength > 0.45) {
            const midX = x + Math.cos(branch.angle) * size * 0.6;
            const midY = side * Math.sin(branch.angle) * size * 0.6;
            ctx.beginPath();
            ctx.moveTo(midX, midY);
            ctx.lineTo(midX + size * 0.26 * this.strength, midY);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    for (const branch of this.branches) branch.grown += (1 - branch.grown) * ease(7);

    ctx.fillStyle = this.finished ? colors.accent : colors.ink;
    ctx.beginPath();
    for (let side = 0; side < 6; side++) {
      const angle = (side / 6) * Math.PI * 2;
      const size = 7 + this.arm * 8;
      if (side === 0) ctx.moveTo(Math.cos(angle) * size, Math.sin(angle) * size);
      else ctx.lineTo(Math.cos(angle) * size, Math.sin(angle) * size);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.lineCap = "butt";
  }
}
