"use client";

import { useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";
import { canvasSize, createMotionClock, observeTheme } from "../invert-lens/motion-clock";

export interface VariableSwellProps {
  /** Display text. A short headline gives each variable glyph room to breathe. */
  text?: string;
  /** Wave period in seconds. */
  period?: number;
  /** Optional same-origin/CORS-enabled variable font URL, otherwise discovered from --font-display. */
  fontUrl?: string;
  /** CSS token used for the face of the type. */
  colorToken?: string;
  className?: string;
}

// Canvas has no fontVariationSettings property. Distinct FontFace instances expose
// the real wght/wdth/opsz coordinates to its text renderer without per-frame DOM layout.
function findFontSource(family: string): string | undefined {
  const matches: { source: string; latin: boolean }[] = [];
  const inspect = (rules: CSSRuleList, base: string) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule && rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim() === family) {
        const source = rule.style.getPropertyValue("src").match(/url\(["']?([^"')]+)["']?\)/)?.[1];
        if (source) matches.push({ source: new URL(source, base).href, latin: /U\+0{0,3}0-FF/i.test(rule.style.getPropertyValue("unicode-range")) });
      } else if ("cssRules" in rule) {
        inspect((rule as CSSGroupingRule).cssRules, base);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { inspect(sheet.cssRules, sheet.href || document.baseURI); } catch { /* Cross-origin sheets require an explicit fontUrl. */ }
  }
  return matches.find((entry) => entry.latin)?.source ?? matches.at(-1)?.source;
}

export function VariableSwell({ text = "Breathe.", period = 9, fontUrl, colorToken = "--ink", className }: VariableSwellProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fallback = useRef<HTMLSpanElement>(null);
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "");

  useEffect(() => {
    const element = host.current, surface = canvas.current;
    if (!element || !surface) return;
    const pen = surface.getContext("2d");
    if (!pen) return;
    let disposed = false, loaded = false;
    let width = 1, height = 1, size = 100, color = "", family = "sans-serif";
    let positions: number[] = [], advances: number[] = [];
    const glyphs = Array.from(text);
    const faces: FontFace[] = [];
    const steps = 64;
    const abort = new AbortController();
    const pointer = { x: -1000, active: false, strength: 0 };
    const theme = () => {
      const style = getComputedStyle(element);
      color = style.getPropertyValue(colorToken).trim();
      family = (style.getPropertyValue("--font-display").trim() || "sans-serif").split(",")[0].replace(/["']/g, "").trim();
    };
    const measure = () => {
      width = element.clientWidth; height = element.clientHeight;
      canvasSize(surface, width, height);
      pen.font = loaded ? `100px "${faces.at(-1)!.family}"` : `800 100px "${family}"`;
      const units = glyphs.map((glyph) => Math.max(16, pen.measureText(glyph).width) + 2);
      const total = units.reduce((sum, advance) => sum + advance, 0);
      size = Math.min(height * 0.65, (width - 32) / Math.max(1, total) * 100);
      advances = units.map((unit) => unit * size / 100);
      let x = (width - advances.reduce((sum, advance) => sum + advance, 0)) / 2;
      positions = advances.map((advance) => { const center = x + advance / 2; x += advance; return center; });
    };
    theme(); measure();
    const clock = createMotionClock(element, ({ time, delta, reduced }) => {
      if (!loaded) return;
      pen.clearRect(0, 0, width, height);
      pen.fillStyle = color; pen.textAlign = "center"; pen.textBaseline = "alphabetic";
      pointer.strength += ((pointer.active && !reduced ? 1 : 0) - pointer.strength) * (1 - Math.exp(-delta * 5));
      for (let i = 0; i < glyphs.length; i++) {
        const wave = (Math.sin(time * Math.PI * 2 / Math.max(6, period) - i * 0.62) + 1) / 2;
        const local = Math.exp(-(((positions[i] - pointer.x) / Math.max(50, size * 0.85)) ** 2)) * pointer.strength;
        const swell = Math.min(1, wave * 0.88 + local * 0.65);
        const index = Math.round(swell * (steps - 1));
        pen.font = `${size}px "${faces[index].family}"`;
        pen.fillText(glyphs[i], positions[i], height / 2 + size * 0.33);
      }
    });
    const load = async () => {
      try {
        await document.fonts.ready;
        if (disposed) return;
        theme();
        const source = fontUrl ?? findFontSource(family);
        if (!source) return; // Keep the accessible, designed DOM fallback visible.
        const response = await fetch(source, { signal: abort.signal });
        if (!response.ok) return;
        const buffer = await response.arrayBuffer();
        if (disposed) return;
        for (let i = 0; i < steps; i++) {
          const amount = i / (steps - 1);
          faces.push(new FontFace(`Swell${instance}_${i}`, buffer, { variationSettings: `"wght" ${200 + amount * 600}, "wdth" ${75 + amount * 25}, "opsz" ${12 + amount * 84}` }));
        }
        await Promise.all(faces.map((face) => face.load()));
        if (disposed) return;
        faces.forEach((face) => document.fonts.add(face));
        loaded = true; measure(); clock.redraw();
        if (fallback.current) fallback.current.style.opacity = "0";
        surface.style.opacity = "1";
      } catch { /* Font/network failures leave the still headline intact. */ }
    };
    void load();
    const resize = new ResizeObserver(() => { measure(); clock.redraw(); });
    resize.observe(element);
    const move = (event: PointerEvent) => { pointer.x = event.clientX - element.getBoundingClientRect().left; pointer.active = true; };
    const leave = () => { pointer.active = false; };
    element.addEventListener("pointermove", move); element.addEventListener("pointerleave", leave); element.addEventListener("pointercancel", leave); element.addEventListener("pointerup", leave);
    const stopTheme = observeTheme(element, () => { theme(); clock.redraw(); });
    return () => {
      disposed = true; abort.abort(); clock.dispose(); resize.disconnect(); stopTheme();
      faces.forEach((face) => document.fonts.delete(face));
      element.removeEventListener("pointermove", move); element.removeEventListener("pointerleave", leave); element.removeEventListener("pointercancel", leave); element.removeEventListener("pointerup", leave);
      if (fallback.current) fallback.current.style.opacity = "1";
    };
  }, [text, period, fontUrl, colorToken, instance]);

  return (
    <div ref={host} className={cn("relative h-[clamp(260px,30vw,460px)] w-full overflow-hidden text-ink", className)}>
      <h2 className="absolute inset-0 flex items-center justify-center" aria-label={text}><span ref={fallback} aria-hidden="true" className="max-w-full break-words text-center text-[clamp(3rem,15vw,13rem)] font-semibold leading-none tracking-[-0.03em]">{text}</span></h2>
      <canvas ref={canvas} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full opacity-0" />
    </div>
  );
}
