"use client";

import { useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";
import "./wave-text.css";

const styles = {
  "root": "wave-text-root",
  "content": "wave-text-content",
  "masthead": "wave-text-masthead",
  "body": "wave-text-body",
  "headline": "wave-text-headline",
  "support": "wave-text-support",
  "action": "wave-text-action",
  "caption": "wave-text-caption",
  "water": "wave-text-water",
  "waves": "wave-text-waves"
};

export interface WaveTextProps {
  /** Large, selectable headline. Newlines create intentional line breaks. */
  headline?: string;
  /** Supporting text; it reverses colour at the same edge as the headline. */
  description?: string;
  /** Small editorial text above the headline. */
  eyebrow?: string;
  /** Optional right-aligned masthead text. */
  edition?: string;
  /** Link label. Omit with an empty string to hide the action. */
  actionLabel?: string;
  /** Destination of the real, keyboard-accessible action link. */
  actionHref?: string;
  /** Small text along the lower edge of the section. */
  caption?: string;
  /** Mean fraction of the section covered by water, between 0 and 1. */
  waveHeight?: number;
  /** Time multiplier. 1 is a slow, roughly 20-second swell; 0 is still. */
  speed?: number;
  /** Vertical wave displacement in CSS pixels, scaled down on small screens. */
  amplitude?: number;
  /** Horizontal travel direction. */
  direction?: "left" | "right";
  /** Disable pointer-generated ripples while keeping the ambient waves. */
  interactive?: boolean;
  /** Use h1 for a standalone hero, h2 when composing with other sections. */
  headingAs?: "h1" | "h2";
  /** Additional classes on the section, including height overrides. */
  className?: string;
}

type Ripple = { x: number; born: number; strength: number };
const TAU = Math.PI * 2;
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;

/**
 * One clipped surface contains BOTH the water and the paper-coloured text.
 * There is no separate text mask to drift, and no blend mode approximating
 * the palette. The underlying content is real, selectable DOM; the visual
 * duplicate is inert and hidden from assistive technology.
 */
export function WaveText({
  headline = "Nothing\nstands still.",
  description = "A little movement can change everything. Make space for what comes next.",
  eyebrow = "A study in motion",
  edition = "Always becoming",
  actionLabel = "Explore the possibilities",
  actionHref = "#possibilities",
  caption = "Move gently. Make a ripple.",
  waveHeight = 0.52,
  speed = 1,
  amplitude = 140,
  direction = "right",
  interactive = true,
  headingAs: Heading = "h1",
  className,
}: WaveTextProps) {
  const rootRef = useRef<HTMLElement>(null);
  const waterRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<SVGPathElement>(null);
  const contourRef = useRef<SVGPathElement>(null);
  const accentRef = useRef<SVGPathElement>(null);
  const titleId = useId();

  useEffect(() => {
    const root = rootRef.current;
    const water = waterRef.current;
    const front = frontRef.current;
    const contour = contourRef.current;
    const accent = accentRef.current;
    if (!root || !water || !front || !contour || !accent) return;

    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const height = Math.max(0, Math.min(1, finite(waveHeight, 0.52)));
    const rate = Math.max(0, finite(speed, 1));
    const displacement = Math.max(0, finite(amplitude, 140));
    const sign = direction === "right" ? -1 : 1;
    let width = 1;
    let sectionHeight = 1;
    let time = 0;
    let previous = 0;
    let raf = 0;
    let visible = true;
    let disposed = false;
    let lastRipple = -1;
    const ripples: Ripple[] = [];

    function surface(x: number, layer: number) {
      const u = x / width;
      const phase = 2.2 + time * rate * 0.31 * sign;
      const size = displacement * Math.min(1, Math.max(0.85, width / 850));
      // Incommensurate harmonics avoid a mechanical, repeating sine silhouette.
      const swell = Math.sin(u * TAU * 0.82 + phase + layer * 0.8);
      const undertow = Math.sin(u * TAU * 1.43 - phase * 0.63 + layer * 1.7);
      let y = sectionHeight * (1 - height) + size * (swell * 0.76 + undertow * 0.24);
      y += layer * size * 0.44;
      for (const ripple of ripples) {
        const age = time - ripple.born;
        const distance = Math.abs(x - ripple.x);
        const envelope = Math.exp(-Math.pow((distance - age * 130) / 85, 2)) * Math.exp(-age * 1.1);
        y += Math.cos(distance * 0.035 - age * 5.4) * envelope * ripple.strength;
      }
      return y;
    }

    function draw() {
      let edge = "";
      let foreground = "";
      let seam = "";
      let accentEdge = "";
      const samples = Math.ceil(width / 5);
      const accentStart = 0.67 + Math.sin(time * rate * 0.13) * 0.1;
      for (let i = 0; i <= samples; i++) {
        const x = (i / samples) * width;
        const rearY = surface(x, 0);
        const frontY = surface(x, 1);
        const command = i === 0 ? "M" : "L";
        edge += `${command}${x.toFixed(2)},${Math.min(rearY, frontY).toFixed(2)}`;
        foreground += `${command}${x.toFixed(2)},${frontY.toFixed(2)}`;
        seam += `${command}${x.toFixed(2)},${(Math.max(rearY, frontY) + 36).toFixed(2)}`;
        if (i / samples >= accentStart && i / samples <= accentStart + 0.065) {
          accentEdge += `${accentEdge ? "L" : "M"}${x.toFixed(2)},${(Math.min(rearY, frontY) + 2).toFixed(2)}`;
        }
      }
      const close = `L${width},${sectionHeight}L0,${sectionHeight}Z`;
      // The water fill and reversed lettering share this ONE physical clip.
      water!.style.clipPath = `path("${edge}${close}")`;
      front!.setAttribute("d", foreground + close);
      contour!.setAttribute("d", seam);
      accent!.setAttribute("d", accentEdge);
    }

    function frame(now: number) {
      time += Math.min((now - previous) / 1000, 0.04);
      previous = now;
      while (ripples.length && time - ripples[0].born > 5) ripples.shift();
      draw();
      raf = requestAnimationFrame(frame);
    }

    function schedule() {
      cancelAnimationFrame(raf);
      if (disposed || !visible || document.hidden || preference.matches || rate === 0) return;
      previous = performance.now();
      raf = requestAnimationFrame(frame);
    }

    function resize() {
      // A page change can collapse the section to nothing, and the wave divides by its width.
      if (!root!.clientWidth || !root!.clientHeight) return;
      width = root!.clientWidth;
      sectionHeight = root!.clientHeight;
      draw();
    }

    function onPreference() {
      ripples.length = 0;
      if (preference.matches) time = 0;
      draw();
      schedule();
    }

    function onPointer(event: PointerEvent) {
      if (!interactive || preference.matches || rate === 0 || document.hidden) return;
      if (event.type === "pointermove" && time - lastRipple < 0.12) return;
      const bounds = root!.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const proximity = Math.exp(-Math.abs(y - Math.min(surface(x, 0), surface(x, 1))) / 220);
      ripples.push({ x, born: time, strength: (event.type === "pointerdown" ? 48 : 25) * proximity });
      if (ripples.length > 12) ripples.shift();
      lastRipple = time;
    }

    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    });
    resizeObserver.observe(root);
    intersectionObserver.observe(root);
    preference.addEventListener("change", onPreference);
    document.addEventListener("visibilitychange", schedule);
    root.addEventListener("pointermove", onPointer, { passive: true });
    root.addEventListener("pointerdown", onPointer, { passive: true });
    resize();
    schedule();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      preference.removeEventListener("change", onPreference);
      document.removeEventListener("visibilitychange", schedule);
      root.removeEventListener("pointermove", onPointer);
      root.removeEventListener("pointerdown", onPointer);
    };
  }, [waveHeight, speed, amplitude, direction, interactive]);

  function content(duplicate: boolean) {
    return (
      <div className={styles.content}>
        <div className={styles.masthead}>
          <span>{eyebrow}</span>
          <span>{edition}</span>
        </div>
        <div className={styles.body}>
          {duplicate ? <div className={styles.headline}>{headline}</div> : <Heading id={titleId} className={styles.headline}>{headline}</Heading>}
          <div className={styles.support}>
            <p>{description}</p>
            {actionLabel && (duplicate ? (
              <span className={styles.action}>{actionLabel}<span aria-hidden="true">↗</span></span>
            ) : (
              <a href={actionHref} className={styles.action}>{actionLabel}<span aria-hidden="true">↗</span></a>
            ))}
          </div>
        </div>
        <div className={styles.caption}>{caption}</div>
      </div>
    );
  }

  return (
    <section ref={rootRef} className={cn(styles.root, className)} aria-labelledby={titleId}>
      {content(false)}
      <div ref={waterRef} className={styles.water} aria-hidden="true" inert>
        <svg className={styles.waves} width="100%" height="100%" aria-hidden="true">
          <path ref={frontRef} fill="var(--ink)" />
          <path ref={contourRef} fill="none" stroke="var(--paper)" strokeOpacity="0.12" strokeWidth="1" />
          <path ref={accentRef} fill="none" stroke="var(--vermilion)" strokeWidth="2" />
        </svg>
        {content(true)}
      </div>
    </section>
  );
}
