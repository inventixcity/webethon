"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { animateSurface, fitType } from "../ink-tide/runtime";
import { createDotRenderer } from "./dot-renderer";

export interface HalftoneFieldProps {
  /** Headline rasterized into square printing dots and exposed to assistive technology. */
  headline?: string;
  /** Optional same-origin or CORS-enabled image; dark values produce larger dots. */
  imageSrc?: string;
  /** Accessible description when rendering an image. */
  imageAlt?: string;
  /** Desktop dot spacing (5–20px), scaled down on narrow sections to preserve detail. */
  spacing?: number;
  /** Called if an image cannot be loaded or sampled; the headline remains visible. */
  onImageError?: () => void;
  /** Section sizing and layout overrides. */
  className?: string;
}

/** Samples a type/image luminance mask once, then modulates square dot area in real time. */
export function HalftoneField({ headline = "More\nthan words.", imageSrc, imageAlt, spacing = 8, onImageError, className }: HalftoneFieldProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [contextVersion, setContextVersion] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    return animateSurface(ref.current, s => {
      const gpu = createDotRenderer(s);
      const ctx = gpu ? null : s.canvas.getContext("2d", { alpha: false });
      if (!gpu && !ctx) return null;
      const mask = document.createElement("canvas");
      const sampling = mask.getContext("2d", { willReadFrequently: true })!;
      let cols = 0, rows = 0, cell = spacing, values = new Float32Array(0);
      let image: HTMLImageElement | null = null, imageReady = false, disposed = false;
      let lastRipple = -10;
      const ripples: { x: number; y: number; time: number }[] = [];
      const sample = () => {
        cell = Math.min(20, Math.max(5, spacing)) * Math.min(1, Math.max(.45, s.width / 720));
        cols = Math.ceil(s.width / cell); rows = Math.ceil(s.height / cell);
        mask.width = Math.ceil(s.width); mask.height = Math.ceil(s.height);
        sampling.clearRect(0, 0, mask.width, mask.height);
        if (imageReady && image) {
          const scale = Math.min(s.width / image.naturalWidth, s.height / image.naturalHeight);
          const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
          sampling.drawImage(image, (s.width - w) / 2, (s.height - h) / 2, w, h);
        } else {
          const pad = Math.max(24, s.width * .055);
          const type = fitType(sampling, headline, s.width - pad * 2, s.height * .7, s.font, s.width * .19);
          sampling.fillStyle = s.colors.ink; sampling.textBaseline = "top";
          const top = (s.height - type.lines.length * type.lineHeight) / 2;
          type.lines.forEach((line, i) => sampling.fillText(line, pad, top + i * type.lineHeight));
        }
        try {
          const pixels = sampling.getImageData(0, 0, mask.width, mask.height).data;
          values = new Float32Array(cols * rows);
          for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
            // Four samples retain narrow strokes and make image downsampling less brittle.
            let total = 0;
            for (const [dx, dy] of [[.25,.25],[.75,.25],[.25,.75],[.75,.75]]) {
              const sx = Math.min(mask.width - 1, Math.floor((x + dx) * cell));
              const sy = Math.min(mask.height - 1, Math.floor((y + dy) * cell));
              const i = (sy * mask.width + sx) * 4;
              const alpha = pixels[i + 3] / 255;
              total += imageReady ? (1 - (.2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]) / 255) * alpha : alpha;
            }
            values[y * cols + x] = total / 4;
          }
          gpu?.upload(values, cols, cell);
        } catch {
          imageReady = false; onImageError?.(); sample();
        }
      };
      const draw = () => {
        const time = s.still ? 8 : s.time + 8;
        if (s.pointer.active && !s.still && s.time - lastRipple > .65) {
          ripples.push({ x: s.pointer.x, y: s.pointer.y, time: s.time }); lastRipple = s.time;
        }
        while (ripples.length && s.time - ripples[0].time > 3.5) ripples.shift();
        if (gpu) { gpu.draw(ripples); return; }
        if (!ctx) return;
        ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
        ctx.fillStyle = s.colors.paper; ctx.fillRect(0, 0, s.width, s.height);
        ctx.fillStyle = s.colors.ink; ctx.beginPath();
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
          const cx = (x + .5) * cell, cy = (y + .5) * cell;
          const radial = Math.hypot((cx - s.width * .6) * .8, cy - s.height * .4);
          const wave = .5 + .5 * Math.sin(cx * .009 + cy * .012 - time * .48 + Math.sin(radial * .013 - time * .31) * 1.8);
          let ripple = 0;
          if (!s.still) for (const ring of ripples) {
            const age = s.time - ring.time;
            const distance = Math.hypot(cx - ring.x, cy - ring.y);
            const envelope = (distance - age * 150) / 38;
            ripple += Math.exp(-envelope * envelope) * Math.exp(-age * .9) * .36;
          }
          const maskValue = values[y * cols + x] || 0;
          const coverage = Math.min(.96, .012 + wave * .09 + maskValue * (.53 + wave * .31) + ripple);
          const edge = Math.sqrt(coverage) * cell;
          ctx.rect(cx - edge / 2, cy - edge / 2, edge, edge);
        }
        ctx.fill();
      };
      if (imageSrc) {
        image = new Image(); image.crossOrigin = "anonymous"; image.decoding = "async";
        image.onload = () => { if (!disposed) { imageReady = true; sample(); draw(); } };
        image.onerror = () => { if (!disposed) onImageError?.(); };
        image.src = imageSrc;
      }
      const lost = (event: Event) => { event.preventDefault(); };
      const restored = () => { setContextVersion(version => version + 1); };
      s.canvas.addEventListener("webglcontextlost", lost);
      s.canvas.addEventListener("webglcontextrestored", restored);
      return { resize: sample, draw, dispose() {
        disposed = true;
        s.canvas.removeEventListener("webglcontextlost", lost); s.canvas.removeEventListener("webglcontextrestored", restored);
        gpu?.dispose();
        if (image) { image.onload = null; image.onerror = null; image.src = ""; }
      } };
    });
  }, [headline, imageSrc, spacing, onImageError, contextVersion]);
  return <section className={cn("relative min-h-[520px] overflow-hidden bg-paper font-sans text-ink md:min-h-[680px]", className)}>
    <h2 className="sr-only">{headline}</h2>
    {imageSrc && imageAlt && <span className="sr-only" role="img" aria-label={imageAlt} />}
    <canvas ref={ref} aria-hidden="true" className="absolute inset-0 h-full w-full" />
  </section>;
}
