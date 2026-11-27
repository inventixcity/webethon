import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";

const POINTS = ["N", "E", "S", "W"];

/** A compass with a lost needle. Keystrokes spin it, a valid email settles it on north, and sending pings out. */
export class CompassScene implements LiveScene {
  dirty = false;

  private angle = 2.1;
  private velocity = 0.4;
  private settled = false;
  private pings: number[] = [];
  private shake = 0;

  typed(valid: boolean) {
    this.velocity += 2.6;
    this.settled = valid;
    this.dirty = true;
  }

  send() {
    this.pings.push(0, -0.5, -1);
    this.dirty = true;
  }

  rejected() {
    this.shake = 1;
    this.velocity += 5;
    this.dirty = true;
  }

  draw(ctx: CanvasRenderingContext2D, { width, height, time, dt, reduced, colors, headingFont }: LiveFrame) {
    if (reduced && this.settled) this.angle = 0;
    if (this.settled) {
      const wrapped = Math.atan2(Math.sin(-this.angle), Math.cos(-this.angle));
      this.velocity += wrapped * 22 * dt;
      this.velocity *= Math.exp(-5.5 * dt);
    } else {
      // Unsettled, it hunts: a slow drift with a nervous tremble.
      this.velocity += (Math.sin(time * 0.7) * 0.5 - this.velocity * 0.6) * dt * 2;
    }
    this.angle += this.velocity * dt;
    this.shake = Math.max(0, this.shake - dt * 2);

    const radius = Math.min(height * 0.36, width * 0.34);
    const cx = (width > 900 ? width * 0.8 : width * 0.5) + Math.sin(time * 30) * this.shake * 7;
    const cy = height * 0.54;

    for (let i = 0; i < this.pings.length; i++) {
      const age = (this.pings[i] ?? 0) + dt * 0.9;
      this.pings[i] = age;
      if (age <= 0) continue;
      ctx.strokeStyle = colors.accent;
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * (1 + age * 1.6), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (this.pings.length > 12) this.pings = this.pings.slice(-3);

    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    for (let tick = 0; tick < 72; tick++) {
      const a = (tick / 72) * Math.PI * 2;
      const major = tick % 18 === 0;
      const inner = radius * (major ? 0.86 : tick % 6 === 0 ? 0.9 : 0.94);
      ctx.lineWidth = major ? 2 : 1;
      ctx.globalAlpha = major ? 1 : 0.55;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(a) * inner, cy - Math.cos(a) * inner);
      ctx.lineTo(cx + Math.sin(a) * radius, cy - Math.cos(a) * radius);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = colors.ink;
    ctx.font = `800 ${radius * 0.13}px ${headingFont}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    POINTS.forEach((point, index) => {
      const a = (index / 4) * Math.PI * 2;
      ctx.fillText(point, cx + Math.sin(a) * radius * 0.72, cy - Math.cos(a) * radius * 0.72);
    });

    // The needle: a long diamond, with the north half in the accent colour.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.angle);
    const blade = radius * 0.62;
    const waist = radius * 0.055;
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.moveTo(0, -blade);
    ctx.lineTo(waist, 0);
    ctx.lineTo(-waist, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = colors.ink;
    ctx.beginPath();
    ctx.moveTo(0, blade);
    ctx.lineTo(waist, 0);
    ctx.lineTo(-waist, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = colors.paper;
    ctx.beginPath();
    ctx.arc(0, 0, waist * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
