"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { animateSurface, fitType } from "../ink-tide/runtime";

export interface PendulumTypeProps {
  /** Accessible headline; use newlines to arrange rows of suspended letters. */
  headline?: string;
  /** Breeze strength, clamped to 0.1–2. */
  breeze?: number;
  /** Optional single accent glyph index, counting spaces and excluding newlines. */
  accentIndex?: number;
  /** Section sizing and layout overrides. */
  className?: string;
}

type Bob = { glyph: string; x: number; y: number; length: number; angle: number; velocity: number; index: number; row: number };

/** Fixed-step, damped nonlinear pendulums, coupled by torsion springs and a continuous breeze. */
export function PendulumType({ headline = "Make\nit move.", breeze = 1, accentIndex = -1, className }: PendulumTypeProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return animateSurface(ref.current, s => {
      const ctx = s.canvas.getContext("2d");
      if (!ctx) return null;
      let bobs: Bob[] = [], size = 100, accumulator = 0, physicsTime = 0;
      let lastPointerX = -1000, pointerVelocity = 0;
      return {
        resize() {
          const pad = Math.max(32, s.width * .08);
          const lines = headline.split("\n");
          const rowHeight = (s.height - 88) / Math.max(1, lines.length);
          const type = fitType(ctx, headline, s.width - pad * 2, rowHeight * lines.length * .42, s.font, Math.min(180, s.width * .16));
          size = type.size;
          ctx.font = `600 ${size}px ${s.font}`;
          let index = 0;
          bobs = lines.flatMap((line, row) => {
            const glyphs = Array.from(line);
            const widths = glyphs.map(glyph => ctx.measureText(glyph).width);
            const total = widths.reduce((a, b) => a + b, 0);
            let x = (s.width - total) / 2;
            return glyphs.map((glyph, i) => {
              const result = { glyph, x: x + widths[i] / 2, y: 36 + row * rowHeight,
                length: rowHeight * .46 + Math.sin(i * 1.1 + row) * rowHeight * .035,
                angle: Math.sin(index * .8 + 1) * .12, velocity: 0, index: index++, row };
              x += widths[i]; return result;
            });
          });
          accumulator = 0;
        },
        draw() {
          if (!s.still) {
            if (s.pointer.active) {
              pointerVelocity = lastPointerX === -1000 ? 0 : Math.max(-1200, Math.min(1200, (s.pointer.x - lastPointerX) / Math.max(.008, s.dt)));
              lastPointerX = s.pointer.x;
            } else { lastPointerX = -1000; pointerVelocity = 0; }
            accumulator += s.dt;
            const step = 1 / 120;
            while (accumulator >= step) {
              physicsTime += step;
              const accelerations = bobs.map((bob, i) => {
                const wind = Math.min(2, Math.max(.1, breeze)) * (.15 * Math.sin(physicsTime * .65 + bob.x / s.width * 1.8) + .07 * Math.sin(physicsTime * .93 + bob.index * .65));
                let spring = 0;
                for (const neighbor of [bobs[i - 1], bobs[i + 1]]) if (neighbor?.row === bob.row) spring += .7 * (neighbor.angle - bob.angle);
                const bx = bob.x + Math.sin(bob.angle) * bob.length;
                const by = bob.y + Math.cos(bob.angle) * bob.length;
                const dx = bx - s.pointer.x, dy = by - s.pointer.y;
                const proximity = s.pointer.active ? Math.exp(-(dx * dx + dy * dy) / 12000) : 0;
                const push = proximity * (dx / 100 * .65 + pointerVelocity * .0012);
                return -(100 / Math.max(45, bob.length)) * Math.sin(bob.angle) - .48 * bob.velocity + spring + wind + push;
              });
              bobs.forEach((bob, i) => {
                bob.velocity += accelerations[i] * step;
                bob.angle += bob.velocity * step;
                if (Math.abs(bob.angle) > .6) { bob.angle = Math.sign(bob.angle) * .6; bob.velocity *= -.3; }
              });
              accumulator -= step;
            }
          }
          ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
          ctx.clearRect(0, 0, s.width, s.height);
          ctx.font = `600 ${size}px ${s.font}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.lineWidth = .8;
          const rows = new Set<number>();
          for (const bob of bobs) {
            if (!rows.has(bob.row)) {
              ctx.strokeStyle = s.colors.rule; ctx.beginPath(); ctx.moveTo(24, bob.y); ctx.lineTo(s.width - 24, bob.y); ctx.stroke(); rows.add(bob.row);
            }
            if (bob.glyph === " ") continue;
            const angle = s.still ? Math.sin(bob.index * .8 + 1) * .12 : bob.angle;
            ctx.save(); ctx.translate(bob.x, bob.y); ctx.rotate(-angle);
            const glyphTop = ctx.measureText(bob.glyph).actualBoundingBoxAscent;
            ctx.strokeStyle = s.colors.muted; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, bob.length - glyphTop + 1); ctx.stroke();
            ctx.fillStyle = bob.index === accentIndex ? s.colors.accent : s.colors.ink;
            ctx.fillRect(-1.5, -1.5, 3, 3);
            ctx.fillText(bob.glyph, 0, bob.length); ctx.restore();
          }
        },
      };
    });
  }, [headline, breeze, accentIndex]);
  return <section className={cn("relative min-h-[600px] overflow-hidden bg-paper font-sans text-ink md:min-h-[720px]", className)}>
    <h2 className="sr-only">{headline}</h2>
    <canvas ref={ref} aria-hidden="true" className="absolute inset-0 h-full w-full" />
  </section>;
}
