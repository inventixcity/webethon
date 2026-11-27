/** Resolve the host's CSS palette once, outside the animation loop. */
// Named for the original black ocean: "ink" is the water and "paper" is the art, so light and dark modes both work.
export function oceanPalette(host: HTMLCanvasElement) {
  const style = getComputedStyle(host);
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas unavailable");
  function token(name: string) {
    context!.clearRect(0, 0, 1, 1);
    context!.fillStyle = style.getPropertyValue(name).trim();
    context!.fillRect(0, 0, 1, 1);
    return Array.from(context!.getImageData(0, 0, 1, 1).data).slice(0, 3);
  }
  const paper = token("--ink");
  const ink = token("--paper");
  const accent = token("--vermilion");
  const rgba = (rgb: number[], alpha = 1) => `rgba(${rgb.join(",")},${alpha})`;
  return {
    paper: rgba(paper),
    ink: rgba(ink),
    accent: rgba(accent),
    paperAlpha: (alpha: number) => rgba(paper, alpha),
    accentAlpha: (alpha: number) => rgba(accent, alpha),
    // All lighting is a mixture of paper and ink, with no species colour tint.
    shades: Array.from({ length: 256 }, (_, level) => rgba(ink.map((value, i) => Math.round(value + (paper[i] - value) * level / 255)))),
  };
}
