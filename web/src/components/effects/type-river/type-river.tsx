"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { canvasSize, createMotionClock, observeTheme } from "../invert-lens/motion-clock";

export interface TypeRiverProps {
  /** Newlines create separate obstacles in the current; remains real, selectable text. */
  headline?: string;
  /** Decorative alphabet carried by the flow field. */
  characters?: string;
  /** Approximate character spacing in CSS pixels. */
  spacing?: number;
  /** Flow speed in CSS pixels per second. */
  speed?: number;
  className?: string;
}

type Particle = { x: number; y: number; vx: number; vy: number; glyph: number; lane: number };
type Rock = { x: number; y: number; rx: number; ry: number };

export function TypeRiver({ headline = "Find your\nown flow.", characters = "01:/+−·", spacing = 23, speed = 42, className }: TypeRiverProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const element = host.current, surface = canvas.current, heading = title.current;
    if (!element || !surface || !heading) return;
    const context = surface.getContext("2d");
    if (!context) return;
    let width = 1, height = 1, particles: Particle[] = [], rocks: Rock[] = [];
    let disposed = false;
    const alphabet = Array.from(characters || "01");
    const pitch = Math.max(17, spacing);
    const velocity = Math.max(8, Math.min(speed, 180));
    const pointer = { x: -1000, y: -1000, active: false };
    const atlas = document.createElement("canvas");
    const cell = 28;
    const colors = { muted: "", ink: "", accent: "" };
    const prepareAtlas = () => {
      const style = getComputedStyle(element);
      colors.muted = style.getPropertyValue("--ink-muted").trim();
      colors.ink = style.getPropertyValue("--ink").trim();
      colors.accent = style.getPropertyValue("--vermilion").trim();
      atlas.width = cell * alphabet.length; atlas.height = cell * 3;
      const pen = atlas.getContext("2d");
      if (!pen) return;
      pen.font = `22px ${style.getPropertyValue("--font-code").trim() || "monospace"}`;
      pen.textAlign = "center"; pen.textBaseline = "middle";
      [colors.muted, colors.ink, colors.accent].forEach((color, row) => {
        pen.fillStyle = color;
        alphabet.forEach((char, i) => pen.fillText(char, i * cell + cell / 2, row * cell + cell / 2));
      });
    };
    // Potential flow around elliptical obstacles derived from each live headline line.
    // A collision projection keeps particles outside the actual text's safety envelope.
    const advance = (particle: Particle, delta: number, interactive: boolean) => {
      let fx = 1, fy = 0;
      for (const rock of rocks) {
        let dx = (particle.x - rock.x) / rock.rx, dy = (particle.y - rock.y) / rock.ry;
        const r2 = dx * dx + dy * dy;
        if (r2 < 1.08) {
          if (Math.abs(dy) < 0.02) dy = particle.lane % 2 ? 0.03 : -0.03;
          const scale = 1.05 / Math.max(0.001, Math.hypot(dx, dy));
          dx *= scale; dy *= scale;
          particle.x = rock.x + dx * rock.rx; particle.y = rock.y + dy * rock.ry;
        }
        const r4 = Math.max(1, (dx * dx + dy * dy) ** 2);
        fx -= (dx * dx - dy * dy) / r4;
        fy -= 2 * dx * dy / r4 * rock.ry / rock.rx;
      }
      let scatterX = 0, scatterY = 0;
      if (interactive && pointer.active) {
        const dx = particle.x - pointer.x, dy = particle.y - pointer.y;
        const distance = Math.hypot(dx, dy);
        const force = Math.max(0, 1 - distance / 110) ** 2 * 280;
        scatterX = dx / Math.max(1, distance) * force;
        scatterY = dy / Math.max(1, distance) * force;
      }
      const ease = 1 - Math.exp(-delta * 5);
      particle.vx += (velocity * Math.max(0.12, fx) + scatterX - particle.vx) * ease;
      particle.vy += (velocity * fy + scatterY - particle.vy) * ease;
      particle.x += particle.vx * delta; particle.y += particle.vy * delta;
      if (particle.x > width + 24 || particle.y < -50 || particle.y > height + 50) {
        particle.x = -24; particle.y = ((particle.lane + 0.5) * pitch) % height;
        particle.vx = velocity; particle.vy = 0;
      }
    };
    const measure = () => {
      width = element.clientWidth; height = element.clientHeight;
      canvasSize(surface, width, height);
      const parent = element.getBoundingClientRect();
      rocks = Array.from(heading.children).map((line) => {
        const box = line.getBoundingClientRect();
        return { x: box.left - parent.left + box.width / 2, y: box.top - parent.top + box.height / 2, rx: box.width / 2 + 28, ry: box.height / 2 + 22 };
      });
      particles = [];
      for (let lane = 0; lane < Math.ceil(height / pitch); lane++) {
        for (let column = 0; column < Math.ceil(width / pitch); column++) {
          particles.push({ x: column * pitch + (lane % 2) * pitch / 2, y: (lane + 0.5) * pitch, vx: velocity, vy: 0, glyph: (lane * 17 + column * 7) % alphabet.length, lane });
        }
      }
      for (let step = 0; step < 80; step++) for (const p of particles) advance(p, 0.04, false);
    };
    prepareAtlas(); measure();
    const clock = createMotionClock(element, ({ delta, reduced }) => {
      context.clearRect(0, 0, width, height);
      for (const p of particles) {
        if (!reduced && delta) advance(p, delta, true);
        let near = false, inside = false;
        for (const rock of rocks) {
          const distance = ((p.x - rock.x) / rock.rx) ** 2 + ((p.y - rock.y) / rock.ry) ** 2;
          near ||= distance < 1.8; inside ||= distance < 1.02;
        }
        if (inside) continue;
        const row = p.lane === Math.floor(height / pitch * 0.48) ? 2 : near ? 1 : 0;
        context.globalAlpha = row === 0 ? 0.55 : 0.9;
        context.drawImage(atlas, p.glyph * cell, row * cell, cell, cell, p.x - 7, p.y - 7, 14, 14);
      }
      context.globalAlpha = 1;
    });
    const resize = new ResizeObserver(() => { measure(); clock.redraw(); });
    resize.observe(element); resize.observe(heading);
    const move = (event: PointerEvent) => {
      const box = element.getBoundingClientRect(); pointer.x = event.clientX - box.left; pointer.y = event.clientY - box.top; pointer.active = true;
    };
    const leave = () => { pointer.active = false; };
    element.addEventListener("pointermove", move); element.addEventListener("pointerleave", leave); element.addEventListener("pointercancel", leave); element.addEventListener("pointerup", leave);
    const stopTheme = observeTheme(element, () => { prepareAtlas(); clock.redraw(); });
    void document.fonts.ready.then(() => { if (!disposed) { prepareAtlas(); measure(); clock.redraw(); } });
    return () => {
      disposed = true; clock.dispose(); resize.disconnect(); stopTheme();
      element.removeEventListener("pointermove", move); element.removeEventListener("pointerleave", leave); element.removeEventListener("pointercancel", leave); element.removeEventListener("pointerup", leave);
      atlas.width = 0; atlas.height = 0;
    };
  }, [headline, characters, spacing, speed]);

  return (
    <div ref={host} className={cn("relative isolate flex min-h-[580px] items-center overflow-hidden bg-paper px-8 py-24 text-ink sm:px-16 lg:min-h-[680px] lg:px-24", className)}>
      <canvas ref={canvas} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
      <h2 ref={title} className="relative z-10 flex max-w-full flex-col items-start gap-2 text-[clamp(3.2rem,8.4vw,8rem)] font-semibold leading-[0.94] tracking-[-0.03em]" aria-label={headline}>
        {headline.split("\n").map((line, i) => <span key={i} aria-hidden="true" className="max-w-full break-words">{line || "\u00a0"}</span>)}
      </h2>
    </div>
  );
}
