/** Shared imperative clock for the five typographic effects. No React renders per frame. */
export type MotionFrame = { time: number; delta: number; reduced: boolean };

export function createMotionClock(element: HTMLElement, draw: (frame: MotionFrame) => void) {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  let visible = false;
  let disposed = false;
  let frame = 0;
  let last = 0;
  let time = 0;
  const render = (delta = 0) => draw({ time: preference.matches ? 4 : time, delta, reduced: preference.matches });
  const tick = (now: number) => {
    const delta = last ? Math.min((now - last) / 1000, 0.04) : 0;
    last = now;
    time += delta;
    render(delta);
    frame = requestAnimationFrame(tick);
  };
  const sync = () => {
    cancelAnimationFrame(frame);
    last = 0;
    if (disposed) return;
    render();
    if (visible && !document.hidden && !preference.matches) frame = requestAnimationFrame(tick);
  };
  const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
  observer.observe(element);
  preference.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  render();
  return {
    redraw: () => { if (!disposed) render(); },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      preference.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    },
  };
}

/** Re-resolve inherited tokens when a host changes its theme. */
export function observeTheme(element: HTMLElement, update: () => void) {
  const observer = new MutationObserver(update);
  let ancestor: HTMLElement | null = element;
  while (ancestor) {
    observer.observe(ancestor, { attributes: true, attributeFilter: ["class", "style"] });
    ancestor = ancestor.parentElement;
  }
  return () => observer.disconnect();
}

export function canvasSize(canvas: HTMLCanvasElement, width: number, height: number) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d");
  context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}
