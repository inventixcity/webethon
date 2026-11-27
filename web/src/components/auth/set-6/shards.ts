import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";
import { hash } from "@/components/ascii/grid";

const MAX = 16;

/** A line of ice shards on the horizon. Each character raises one, and retyping it caps it in colour. */
export class ShardScene implements LiveScene {
  dirty = false;

  private targets = new Array<number>(MAX).fill(0);
  private heights = new Array<number>(MAX).fill(0);
  private capped = new Array<boolean>(MAX).fill(false);
  private tips = new Array<number>(MAX).fill(0);

  update(password: string, confirm: string, strength: number) {
    for (let slot = 0; slot < MAX; slot++) {
      const code = password.charCodeAt(slot);
      if (Number.isNaN(code)) {
        this.targets[slot] = 0;
        this.capped[slot] = false;
        continue;
      }
      // A strong password stands tall. Height varies by character, so it reads as a real ridge.
      this.targets[slot] = (0.28 + hash(code, slot + 2) * 0.32) * (0.55 + strength * 0.45);
      this.tips[slot] = hash(code + 5, slot) - 0.5;
      this.capped[slot] = slot < confirm.length && confirm[slot] === password[slot];
    }
    this.dirty = true;
  }

  draw(ctx: CanvasRenderingContext2D, { width, height, dt, reduced, colors }: LiveFrame) {
    const ease = reduced ? 1 : 1 - Math.exp(-11 * dt);
    const left = width > 900 ? width * 0.36 : width * 0.04;
    const span = width - left - width * 0.04;
    const slot = span / MAX;
    const ground = height;

    for (let i = 0; i < MAX; i++) {
      const current = (this.heights[i] ?? 0) + ((this.targets[i] ?? 0) - (this.heights[i] ?? 0)) * ease;
      this.heights[i] = current;
      if (current < 0.005) continue;
      const shardHeight = current * height;
      const x = left + slot * i;
      const tipX = x + slot * (0.5 + (this.tips[i] ?? 0) * 0.6);
      const tipY = ground - shardHeight;

      // Two facets, one lit and one in shade, so each shard reads as a solid crystal.
      ctx.fillStyle = colors.raised;
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x + 2, ground);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(x + slot * 0.55, ground);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = colors.sunk;
      ctx.beginPath();
      ctx.moveTo(x + slot * 0.55, ground);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(x + slot - 2, ground);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      if (this.capped[i]) {
        const cap = 0.3;
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX + (x + 2 - tipX) * cap, tipY + shardHeight * cap);
        ctx.lineTo(tipX + (x + slot - 2 - tipX) * cap, tipY + shardHeight * cap);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}
