import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";

const STITCHES = 30;

/** A needle running stitches across the silk: one per letter, pulled taut once the address is valid. */
export class StitchScene implements LiveScene {
  dirty = false;

  private count = 0;
  private shown = 0;
  private taut = 0;
  private tautTarget = 0;
  private jab = 0;
  private flight = 0;
  private sent = false;
  private flash = 0;

  typed(length: number, valid: boolean) {
    this.count = Math.min(STITCHES, length);
    this.tautTarget = valid ? 1 : 0;
    this.jab = 1;
    this.dirty = true;
  }

  setSent(sent: boolean) {
    this.sent = sent;
    if (!sent) this.flight = 0;
    this.dirty = true;
  }

  rejected() {
    this.flash = 1;
    this.dirty = true;
  }

  draw(ctx: CanvasRenderingContext2D, { width, height, time, dt, reduced, colors }: LiveFrame) {
    const ease = reduced ? 1 : 1 - Math.exp(-14 * dt);
    this.shown += (this.count - this.shown) * ease;
    this.taut += (this.tautTarget - this.taut) * (reduced ? 1 : 1 - Math.exp(-5 * dt));
    this.jab = Math.max(0, this.jab - dt * 7);
    this.flash = Math.max(0, this.flash - dt * 1.6);
    if (this.sent) this.flight = reduced ? 1 : Math.min(1, this.flight + dt * 0.8);

    const left = width * 0.1;
    const span = width * 0.8;
    const sag = height * 0.13 * (1 - this.taut);
    const point = (u: number): [number, number] => [
      left + span * u,
      height * 0.52 + Math.sin(u * 7 + time * 0.6) * sag + Math.sin(this.flash * 30) * this.flash * 8,
    ];

    // Faint chalk marks where the stitches will go.
    ctx.fillStyle = colors.muted;
    ctx.globalAlpha = 0.45;
    for (let i = 0; i <= STITCHES; i++) {
      const [x, y] = point(i / STITCHES);
      ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "butt";
    const stitched = Math.floor(this.shown);
    for (let i = 0; i < stitched; i++) {
      const [x0, y0] = point((i + 0.14) / STITCHES);
      const [x1, y1] = point((i + 0.86) / STITCHES);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    const [tipX, tipY] = point(this.shown / STITCHES);
    if (this.flight < 1) {
      // The needle, and the thread trailing up to where it came from.
      const lift = this.flight * this.flight;
      const needleX = tipX + lift * width;
      const needleY = tipY - lift * height - (reduced ? 0 : Math.sin(time * 2) * 4) - this.jab * 12;

      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(needleX, needleY);
      ctx.quadraticCurveTo(needleX + width * 0.08, needleY - height * 0.24, width, height * 0.1);
      ctx.stroke();

      ctx.save();
      ctx.translate(needleX, needleY);
      ctx.rotate(-0.6);
      ctx.fillStyle = colors.ink;
      ctx.beginPath();
      ctx.moveTo(-3, -44);
      ctx.lineTo(3, -44);
      ctx.lineTo(0.6, 22);
      ctx.lineTo(-0.6, 22);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    if (this.tautTarget === 1 && this.flight < 0.2) {
      ctx.fillStyle = colors.accent;
      ctx.fillRect(tipX - 4, tipY - 4, 8, 8);
    }
  }
}
