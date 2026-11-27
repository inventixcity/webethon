"use client";

/** Shared lifecycle for the four canvas studies. All coordinates are CSS pixels. */
export type Surface = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  dpr: number;
  time: number;
  dt: number;
  still: boolean;
  pointer: { x: number; y: number; active: boolean };
  colors: Record<"paper" | "ink" | "muted" | "rule" | "accent", string>;
  font: string;
};

type Painter = { draw: () => void; resize?: () => void; dispose?: () => void };

export function animateSurface(canvas: HTMLCanvasElement, factory: (surface: Surface) => Painter | null) {
  const host = canvas.parentElement!;
  const surface: Surface = {
    canvas, width: 1, height: 1, dpr: 1, time: 0, dt: 0, still: false,
    pointer: { x: -1000, y: -1000, active: false },
    colors: { paper: "", ink: "", muted: "", rule: "", accent: "" }, font: "",
  };
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let visible = false;
  let disposed = false;
  let previous = 0;
  const painter = factory(surface);
  if (!painter) return () => {};
  const tick = (now: number) => {
    frame = 0;
    surface.dt = previous ? Math.min((now - previous) / 1000, 0.04) : 1 / 60;
    previous = now;
    surface.time += surface.dt;
    painter.draw();
    if (visible && !document.hidden && !media.matches && !disposed) frame = requestAnimationFrame(tick);
  };
  const sync = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
    surface.still = media.matches;
    if (surface.still) painter.draw();
    else if (visible && !document.hidden && !disposed) frame = requestAnimationFrame(tick);
  };
  const resize = () => {
    if (disposed) return;
    const rect = host.getBoundingClientRect();
    surface.width = Math.max(1, rect.width);
    surface.height = Math.max(1, rect.height);
    surface.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(surface.width * surface.dpr);
    canvas.height = Math.round(surface.height * surface.dpr);
    const css = getComputedStyle(host);
    surface.colors = {
      paper: css.getPropertyValue("--paper").trim(), ink: css.getPropertyValue("--ink").trim(),
      muted: css.getPropertyValue("--ink-muted").trim(), rule: css.getPropertyValue("--rule").trim(),
      accent: css.getPropertyValue("--vermilion").trim(),
    };
    surface.font = css.fontFamily;
    surface.still = media.matches;
    painter.resize?.();
    painter.draw();
  };
  const pointer = (event: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    surface.pointer.x = event.clientX - rect.left;
    surface.pointer.y = event.clientY - rect.top;
    surface.pointer.active = true;
  };
  const leave = () => { surface.pointer.active = false; };
  const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
  const sizes = new ResizeObserver(resize);
  const theme = new MutationObserver(resize);
  for (let node: HTMLElement | null = host; node; node = node.parentElement) {
    theme.observe(node, { attributes: true, attributeFilter: ["class", "style"] });
  }
  observer.observe(host);
  sizes.observe(host);
  host.addEventListener("pointermove", pointer, { passive: true });
  host.addEventListener("pointerleave", leave);
  host.addEventListener("pointercancel", leave);
  document.addEventListener("visibilitychange", sync);
  media.addEventListener("change", sync);
  void document.fonts.ready.then(resize);
  resize();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect(); sizes.disconnect(); theme.disconnect();
    host.removeEventListener("pointermove", pointer);
    host.removeEventListener("pointerleave", leave);
    host.removeEventListener("pointercancel", leave);
    document.removeEventListener("visibilitychange", sync);
    media.removeEventListener("change", sync);
    painter.dispose?.();
  };
}

/** Fits explicit lines without clipping arbitrary consumer copy. */
export function fitType(ctx: CanvasRenderingContext2D, text: string, width: number, height: number, font: string, maxSize: number) {
  const lines = text.split("\n");
  let size = Math.min(maxSize, height / (lines.length * 0.95));
  ctx.font = `600 ${size}px ${font}`;
  const longest = Math.max(1, ...lines.map(line => ctx.measureText(line).width));
  size *= Math.min(1, width / longest);
  ctx.font = `600 ${size}px ${font}`;
  return { lines, size, lineHeight: size * 0.94 };
}
