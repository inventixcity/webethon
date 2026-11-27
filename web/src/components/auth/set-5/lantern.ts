import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";
import { hash } from "@/components/ascii/grid";

type Firefly = { x: number; y: number; seed: number; inside: boolean; freed: boolean };

const FULL = 22;

/** A paper lantern at dusk. Each letter sends a firefly in, and sending the address sets them all free. */
export class LanternScene implements LiveScene {
  dirty = false;

  private flies: Firefly[] = [];
  private wanted = 0;
  private valid = false;
  private sent = false;
  private glow = 0;
  private swing = 0;
  private serial = 0;
  private width = 0;
  private height = 0;

  typed(length: number, valid: boolean) {
    this.wanted = Math.min(FULL, length);
    this.valid = valid;
    this.swing = 1;
    this.dirty = true;
  }

  setSent(sent: boolean) {
    this.sent = sent;
    for (const fly of this.flies) fly.freed = sent;
    this.dirty = true;
  }

  rejected() {
    this.swing = 2;
    this.dirty = true;
  }

  draw(ctx: CanvasRenderingContext2D, frame: LiveFrame) {
    const { width, height, time, dt, reduced, colors } = frame;
    this.width = width;
    this.height = height;

    // Dusk over the garden wall.
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, colors.sceneB);
    sky.addColorStop(1, colors.sceneA);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = colors.sceneC;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    for (let blade = 0; blade < 90; blade++) {
      const x = hash(blade, 3) * width;
      const tall = 30 + hash(blade, 9) * 80;
      const lean = Math.sin(time * 0.8 + blade) * 8 + (hash(blade, 5) - 0.5) * 30;
      ctx.beginPath();
      ctx.moveTo(x, height);
      ctx.quadraticCurveTo(x + lean * 0.3, height - tall * 0.6, x + lean, height - tall);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    this.swing = Math.max(0, this.swing - dt * 0.9);
    const hangX = width > 1024 ? width * 0.3 : width * 0.5;
    const tilt = reduced ? 0 : Math.sin(time * 1.1) * 0.02 + Math.sin(time * 6) * this.swing * 0.09;
    const cordLength = height * 0.3;
    const lanternX = hangX + Math.sin(tilt) * cordLength;
    const lanternY = Math.cos(tilt) * cordLength;
    const size = Math.min(width, height) * 0.13;

    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(hangX, 0);
    ctx.lineTo(lanternX, lanternY);
    ctx.stroke();

    while (this.flies.filter((fly) => !fly.freed).length < this.wanted) {
      this.serial += 1;
      this.flies.push({
        x: hash(this.serial, 2) * width,
        y: height * (0.7 + hash(this.serial, 4) * 0.3),
        seed: this.serial,
        inside: false,
        freed: this.sent,
      });
    }
    const penned = this.flies.filter((fly) => !fly.freed);
    if (penned.length > this.wanted) {
      const excess = penned[penned.length - 1];
      if (excess) excess.freed = true;
    }

    const caught = this.flies.filter((fly) => fly.inside && !fly.freed).length;
    const glowTarget = this.valid && !this.sent ? 1 : caught / FULL;
    this.glow += (glowTarget - this.glow) * (reduced ? 1 : 1 - Math.exp(-4 * dt));

    if (this.glow > 0.01) {
      const halo = ctx.createRadialGradient(lanternX, lanternY, size * 0.2, lanternX, lanternY, size * 3.4);
      halo.addColorStop(0, colors.accent);
      halo.addColorStop(1, "transparent");
      ctx.save();
      // Screen lightens the sage sky instead of covering it, so the glow reads as light, not as a brown stain.
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = halo;
      ctx.globalAlpha = 0.5 * this.glow;
      ctx.fillRect(lanternX - size * 3.5, lanternY - size * 3.5, size * 7, size * 7);
      ctx.restore();
    }

    // The lantern: a paper box with bamboo ribs, lit from within.
    ctx.save();
    ctx.translate(lanternX, lanternY);
    ctx.rotate(tilt);
    ctx.fillStyle = colors.raised;
    ctx.fillRect(-size * 0.7, 0, size * 1.4, size * 1.9);
    ctx.fillStyle = colors.accent;
    ctx.globalAlpha = 0.85 * this.glow;
    ctx.fillRect(-size * 0.7, 0, size * 1.4, size * 1.9);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(-size * 0.7, 0, size * 1.4, size * 1.9);
    for (let rib = 1; rib < 5; rib++) {
      const y = (rib / 5) * size * 1.9;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(-size * 0.7, y);
      ctx.lineTo(size * 0.7, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = colors.ink;
    ctx.fillRect(-size * 0.84, -5, size * 1.68, 6);
    ctx.fillRect(-size * 0.84, size * 1.9 - 1, size * 1.68, 6);
    ctx.restore();

    const centreY = lanternY + size;
    for (const fly of this.flies) {
      const wobbleX = Math.sin(time * 2.4 + fly.seed) * 26;
      const wobbleY = Math.cos(time * 1.9 + fly.seed * 2) * 20;
      if (fly.freed) {
        fly.x += (width * 1.1 - fly.x) * dt * 0.5 + wobbleX * dt;
        fly.y += (-40 - fly.y) * dt * 0.42 + wobbleY * dt;
      } else {
        const targetX = lanternX + Math.cos(fly.seed * 2.1) * size * 0.45;
        const targetY = centreY + Math.sin(fly.seed * 1.3) * size * 0.7;
        const pull = reduced ? 1 : 1 - Math.exp(-1.6 * dt);
        fly.x += (targetX - fly.x) * pull + wobbleX * dt;
        fly.y += (targetY - fly.y) * pull + wobbleY * dt;
        if (Math.hypot(targetX - fly.x, targetY - fly.y) < size * 0.6) fly.inside = true;
      }
      const pulse = 0.55 + Math.sin(time * 4 + fly.seed * 3) * 0.45;
      ctx.fillStyle = colors.accent;
      ctx.globalAlpha = 0.2 * pulse;
      ctx.beginPath();
      ctx.arc(fly.x, fly.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = Math.min(1, 0.45 + pulse);
      ctx.beginPath();
      ctx.arc(fly.x, fly.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    this.flies = this.flies.filter((fly) => fly.y > -30 && fly.x < this.width + 30);
  }
}
