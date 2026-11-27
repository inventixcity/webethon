import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";
import { paintWater } from "./pond";

export type FernInput = { typed: number; strength: number; terms: boolean };

const STEPS = 70;

/** A fiddlehead that uncoils with every letter, sprouts fronds with a strong password, and seeds at the end. */
export class FernScene implements LiveScene {
  dirty = false;

  private unfurl = 0;
  private unfurlTarget = 0.08;
  private leaves = 0;
  private leavesTarget = 0;
  private seeds = 0;
  private seedsTarget = 0;
  private gust = 0;
  private last = 0;

  update({ typed, strength, terms }: FernInput) {
    if (typed !== this.last) this.gust = 1;
    this.last = typed;
    this.unfurlTarget = Math.min(1, 0.08 + (typed / 28) * 0.92);
    this.leavesTarget = Math.min(1, Math.max(strength, typed > 10 ? 0.25 : 0));
    this.seedsTarget = terms ? 1 : 0;
    this.dirty = true;
  }

  draw(ctx: CanvasRenderingContext2D, frame: LiveFrame) {
    const { width, height, time, dt, reduced, colors } = frame;
    const ease = (rate: number) => (reduced ? 1 : 1 - Math.exp(-rate * dt));
    this.unfurl += (this.unfurlTarget - this.unfurl) * ease(4);
    this.leaves += (this.leavesTarget - this.leaves) * ease(3);
    this.seeds += (this.seedsTarget - this.seeds) * ease(2);
    this.gust = Math.max(0, this.gust - dt * 2.2);

    paintWater(ctx, frame);

    const baseX = width > 1024 ? width * 0.3 : width * 0.5;
    const baseY = height + 8;
    const length = height * (0.45 + 0.5 * this.unfurl);
    const coil = (1 - this.unfurl) * 15; // radians of curl left at the tip
    const sway = reduced ? 0 : Math.sin(time * 0.7) * 0.03 + Math.sin(time * 9) * this.gust * 0.03;

    const stem: [number, number, number][] = [];
    let x = baseX;
    let y = baseY;
    let angle = -Math.PI / 2 + 0.16 + sway;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      stem.push([x, y, angle]);
      angle += (coil * t * t * t * 4) / STEPS + (0.5 / STEPS) * (1 - this.unfurl) + (sway * t) / 6;
      const step = (length / STEPS) * (1 - t * t * 0.5);
      x += Math.cos(angle) * step;
      y += Math.sin(angle) * step;
    }

    // Fronds first, so the stem sits over them.
    ctx.lineCap = "round";
    const reach = height * 0.24;
    for (let i = 10; i < STEPS - 3; i += 3) {
      const t = i / STEPS;
      const grown = Math.max(0, Math.min(1, this.unfurl * 1.5 - t * 0.6));
      if (grown <= 0.02) continue;
      const size = reach * Math.sin(Math.PI * Math.pow(t, 0.8)) * grown;
      const point = stem[i];
      if (!point) continue;
      for (const side of [-1, 1]) {
        const out = point[2] + side * (1.2 - t * 0.5);
        const tipX = point[0] + Math.cos(out) * size;
        const tipY = point[1] + Math.sin(out) * size;
        const bendX = point[0] + Math.cos(out + side * 0.3) * size * 0.55;
        const bendY = point[1] + Math.sin(out + side * 0.3) * size * 0.55;

        ctx.strokeStyle = colors.sceneC;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(point[0], point[1]);
        ctx.quadraticCurveTo(bendX, bendY, tipX, tipY);
        ctx.stroke();

        const count = Math.floor(9 * this.leaves);
        ctx.fillStyle = colors.sceneC;
        for (let leaf = 1; leaf <= count; leaf++) {
          const u = leaf / (count + 1);
          const px = (1 - u) * (1 - u) * point[0] + 2 * (1 - u) * u * bendX + u * u * tipX;
          const py = (1 - u) * (1 - u) * point[1] + 2 * (1 - u) * u * bendY + u * u * tipY;
          const leafSize = size * 0.15 * (1 - u * 0.75);
          for (const flank of [-1, 1]) {
            const dir = out + flank * 0.95;
            ctx.beginPath();
            ctx.ellipse(
              px + Math.cos(dir) * leafSize * 0.6,
              py + Math.sin(dir) * leafSize * 0.6,
              leafSize * 0.6,
              leafSize * 0.2,
              dir,
              0,
              Math.PI * 2,
            );
            ctx.fill();
          }
          if (this.seeds > 0.05 && leaf % 2 === 0) {
            ctx.fillStyle = colors.accent;
            ctx.globalAlpha = this.seeds;
            ctx.beginPath();
            ctx.arc(px, py, 1.8, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = colors.sceneC;
          }
        }
      }
    }

    // The stem, tapering toward the tip.
    ctx.strokeStyle = colors.sceneC;
    for (let i = 1; i <= STEPS; i++) {
      const a = stem[i - 1];
      const b = stem[i];
      if (!a || !b) continue;
      ctx.lineWidth = 1.2 + (1 - i / STEPS) * 7;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.lineCap = "butt";
  }
}
