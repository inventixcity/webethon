import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";
import { hash } from "@/components/ascii/grid";

const MAX_RINGS = 24;
const POINTS = 96;

/** A tree's cross-section. Each character lays a growth ring, and retyping traces them in brass. */
export class RingsScene implements LiveScene {
  dirty = false;

  private seeds: number[] = [];
  private grown = 0;
  private matched = 0;
  private strength = 0;
  private strengthShown = 0;
  private sealed = false;

  update(password: string, confirm: string, strength: number) {
    this.seeds = Array.from(password.slice(0, MAX_RINGS), (char, index) => hash(char.charCodeAt(0), index + 1));
    let same = 0;
    while (same < confirm.length && confirm[same] === password[same]) same += 1;
    this.matched = same;
    this.strength = strength;
    this.sealed = password.length > 0 && password === confirm;
    this.dirty = true;
  }

  draw(ctx: CanvasRenderingContext2D, { width, height, time, dt, reduced, colors }: LiveFrame) {
    const ease = reduced ? 1 : 1 - Math.exp(-8 * dt);
    this.grown += (this.seeds.length - this.grown) * ease;
    this.strengthShown += (this.strength - this.strengthShown) * ease;

    ctx.fillStyle = colors.sceneA;
    ctx.fillRect(0, 0, width, height);

    const cx = width > 1024 ? width * 0.31 : width * 0.5;
    const cy = height * (width > 1024 ? 0.5 : 0.28);
    const maxRadius = Math.min(width > 1024 ? width * 0.27 : width * 0.44, height * 0.42);

    // The cut face of the log.
    ctx.fillStyle = colors.raised;
    ctx.beginPath();
    for (let i = 0; i <= POINTS; i++) {
      const angle = (i / POINTS) * Math.PI * 2;
      const r = maxRadius * (1.02 + Math.sin(angle * 3 + 1) * 0.015 + Math.sin(angle * 7) * 0.01);
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.fill();

    const breathing = reduced ? 0 : Math.sin(time * 0.6) * 0.004;
    const count = Math.ceil(this.grown);
    for (let ring = 0; ring < count; ring++) {
      const seed = this.seeds[ring] ?? 0.5;
      const share = Math.min(1, this.grown - ring);
      const radius = maxRadius * (0.08 + ((ring + share) / MAX_RINGS) * 0.92);
      const isMatched = ring < this.matched;

      ctx.strokeStyle = isMatched ? colors.accent : colors.ink;
      ctx.globalAlpha = isMatched ? 1 : 0.3 + this.strengthShown * 0.55;
      ctx.lineWidth = isMatched ? 2.2 : 0.9 + seed * 1.4 * this.strengthShown;
      ctx.beginPath();
      for (let i = 0; i <= POINTS; i++) {
        const angle = (i / POINTS) * Math.PI * 2;
        // A slight wander, different for every character, so no two passwords grow the same tree.
        const wander =
          Math.sin(angle * 3 + seed * 6) * 0.018 + Math.sin(angle * 5 + seed * 11) * 0.012 + breathing;
        const r = radius * (1 + wander);
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = this.sealed ? colors.accent : colors.ink;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(3, maxRadius * 0.05), 0, Math.PI * 2);
    ctx.fill();
  }
}
