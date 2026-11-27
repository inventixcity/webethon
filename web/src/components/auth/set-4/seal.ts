import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";

/** The house monogram, gilded from the foot up as the password strengthens, and ringed once it's repeated. */
export class SealScene implements LiveScene {
  dirty = false;

  private readonly mark: string;
  private gold = 0;
  private goldTarget = 0;
  private ring = 0;
  private ringTarget = 0;
  private kick = 0;
  private matched = false;

  constructor(mark: string) {
    this.mark = mark;
  }

  update(password: string, confirm: string, strength: number) {
    this.goldTarget = Math.min(1, password.length / 12) * 0.5 + strength * 0.5;
    let same = 0;
    while (same < confirm.length && confirm[same] === password[same]) same += 1;
    this.ringTarget = password ? same / password.length : 0;
    this.matched = password.length > 0 && password === confirm;
    this.kick = 1;
    this.dirty = true;
  }

  draw(ctx: CanvasRenderingContext2D, { width, height, time, dt, reduced, colors, headingFont }: LiveFrame) {
    const ease = reduced ? 1 : 1 - Math.exp(-7 * dt);
    this.gold += (this.goldTarget - this.gold) * ease;
    this.ring += (this.ringTarget - this.ring) * ease;
    this.kick = Math.max(0, this.kick - dt * 5);

    const cx = width / 2;
    const cy = height / 2;
    const size = Math.min(width, height) * 0.62 * (1 + this.kick * 0.012);
    const font = `italic ${size}px ${headingFont}`;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = font;

    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.strokeText(this.mark, cx, cy);

    // Gold leaf, clipped so it rises through the letter.
    const top = cy + size * 0.5 - this.gold * size;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, width, height - top);
    ctx.clip();
    const leaf = ctx.createLinearGradient(cx - size * 0.5, cy - size * 0.5, cx + size * 0.5, cy + size * 0.5);
    const glint = reduced ? 0.5 : (time * 0.18) % 1;
    leaf.addColorStop(0, colors.accent);
    leaf.addColorStop(Math.max(0, glint - 0.08), colors.accent);
    leaf.addColorStop(glint, colors.sceneC);
    leaf.addColorStop(Math.min(1, glint + 0.08), colors.accent);
    leaf.addColorStop(1, colors.accent);
    ctx.fillStyle = leaf;
    ctx.fillText(this.mark, cx, cy);
    ctx.restore();

    // The ring draws itself round the letter as the password is repeated.
    const radius = Math.min(width, height) * 0.44;
    ctx.strokeStyle = colors.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    if (this.ring > 0.001) {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = this.matched ? 4 : 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + this.ring * Math.PI * 2);
      ctx.stroke();
    }
  }
}
