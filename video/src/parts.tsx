import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { c, display, mono } from "./theme";

/** The brand mark: an ink square with a vermilion notch. */
export const Mark: React.FC<{ size?: number; dark?: boolean }> = ({ size = 64, dark = false }) => (
  <div style={{ width: size, height: size, background: dark ? c.paper : c.ink, position: "relative" }}>
    <div style={{ position: "absolute", right: 0, bottom: 0, width: size * 0.32, height: size * 0.32, background: c.vermilion }} />
  </div>
);

/** Subtle paper grain and a hairline grid, the site's backdrop. */
export const Paper: React.FC<{ dark?: boolean; children?: React.ReactNode }> = ({ dark = false, children }) => {
  const frame = useCurrentFrame();
  const drift = (frame * 0.4) % 48;
  return (
    <AbsoluteFill style={{ background: dark ? c.night : c.paper, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${dark ? "rgba(243,238,227,0.05)" : "rgba(18,17,14,0.05)"} 1px, transparent 1px), linear-gradient(90deg, ${dark ? "rgba(243,238,227,0.05)" : "rgba(18,17,14,0.05)"} 1px, transparent 1px)`,
          backgroundSize: "48px 48px",
          backgroundPosition: `${drift}px ${drift}px`,
        }}
      />
      {children}
    </AbsoluteFill>
  );
};

/** Mono eyebrow, as on the site: "▪ 03 / EXAMINER". */
export const Eyebrow: React.FC<{ index: string; label: string; dark?: boolean; delay?: number }> = ({ index, label, dark, delay = 0 }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame - delay, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: mono, fontSize: 24, letterSpacing: "0.16em", textTransform: "uppercase", color: dark ? c.paper : c.inkSoft, opacity: o }}>
      <span style={{ width: 12, height: 12, background: c.vermilion }} />
      <span style={{ color: c.cobalt, fontWeight: 700 }}>{index}</span>
      <span>/</span>
      <span>{label}</span>
    </div>
  );
};

/** A word-by-word rise, used for big headlines. */
export const Rise: React.FC<{ text: string; size: number; delay?: number; color?: string; weight?: number; stagger?: number }> = ({ text, size, delay = 0, color = c.ink, weight = 700, stagger = 3 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: `0 ${size * 0.25}px`, fontFamily: display, fontWeight: weight, fontSize: size, lineHeight: 0.98, letterSpacing: "-0.035em", color }}>
      {text.split(" ").map((word, i) => {
        const s = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 16, stiffness: 160 } });
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", paddingBottom: size * 0.08 }}>
            <span style={{ display: "inline-block", transform: `translateY(${(1 - s) * 110}%)` }}>{word}</span>
          </span>
        );
      })}
    </div>
  );
};

/** A hairline that sweeps across, cobalt then amber, like the site's header rule. */
export const Sweep: React.FC<{ delay?: number; width?: number | string; dark?: boolean }> = ({ delay = 0, width = "100%", dark }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame - delay, [0, 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return (
    <div style={{ position: "relative", width, height: 3, background: dark ? "rgba(243,238,227,0.15)" : c.rule }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${p * 38}%`, background: c.cobalt }} />
      <div style={{ position: "absolute", left: `${p * 38}%`, top: 0, bottom: 0, width: `${p * 22}%`, background: c.amber }} />
    </div>
  );
};

export type Shot = {
  file: string;
  caption: string;
  eyebrow: string;
  /** Where the camera drifts to, 0..1 of the screenshot. */
  focus?: [number, number];
  zoom?: number;
  /** Where the cursor ends up and clicks, 0..1. */
  click?: [number, number];
  dark?: boolean;
  url?: string;
};

/** One screenshot inside a square browser frame, with a slow push-in toward the focus point and an optional click. */
export const ShotFrame: React.FC<{ shot: Shot; duration: number }> = ({ shot, duration }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 120 } });
  const exit = interpolate(frame, [duration - 8, duration], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const zoom = shot.zoom ?? 1.12;
  const p = interpolate(frame, [0, duration], [0, 1], { easing: Easing.inOut(Easing.cubic), extrapolateRight: "clamp" });
  const [fx, fy] = shot.focus ?? [0.5, 0.4];
  const scale = 1 + (zoom - 1) * p;
  const W = 1600;
  const H = 900;
  const tx = (0.5 - fx) * W * (scale - 1);
  const ty = (0.5 - fy) * H * (scale - 1);
  const dark = shot.dark ?? false;

  // Cursor glides in, then clicks at 55% of the shot.
  const clickAt = Math.round(duration * 0.55);
  const cur = shot.click;
  const glide = interpolate(frame, [8, clickAt], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const ripple = interpolate(frame, [clickAt, clickAt + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: exit }}>
      <div
        style={{
          width: W + 4,
          transform: `translateY(${(1 - enter) * 60}px) scale(${0.96 + enter * 0.04})`,
          border: `2px solid ${dark ? c.paper : c.ink}`,
          background: dark ? c.night : c.paperRaised,
          boxShadow: `14px 14px 0 ${c.cobalt}, 28px 28px 0 ${c.amber}`,
        }}
      >
        <div style={{ height: 46, display: "flex", alignItems: "center", gap: 10, padding: "0 16px", borderBottom: `2px solid ${dark ? c.paper : c.ink}`, background: dark ? "#16150F" : c.paper }}>
          {[c.vermilion, c.amber, c.cobalt].map((col) => (
            <span key={col} style={{ width: 12, height: 12, background: col }} />
          ))}
          <div style={{ marginLeft: 18, fontFamily: mono, fontSize: 17, letterSpacing: "0.04em", color: dark ? c.paper : c.inkSoft }}>
            {shot.url ?? "invigil-ivory.vercel.app"}
          </div>
        </div>
        <div style={{ width: W, height: H, overflow: "hidden", position: "relative" }}>
          <Img
            src={staticFile(`shots/${shot.file}`)}
            style={{ width: W, height: H, objectFit: "cover", objectPosition: "top", transform: `translate(${tx}px, ${ty}px) scale(${scale})`, transformOrigin: "center" }}
          />
          {cur ? (
            <>
              <div
                style={{
                  position: "absolute",
                  left: interpolate(glide, [0, 1], [W * 0.82, cur[0] * W]),
                  top: interpolate(glide, [0, 1], [H * 0.9, cur[1] * H]),
                  width: 0,
                  height: 0,
                }}
              >
                <div style={{ position: "absolute", left: -30, top: -30, width: 60, height: 60, border: `3px solid ${c.cobalt}`, opacity: 1 - ripple, transform: `scale(${0.3 + ripple * 1.4})` }} />
                <svg width="34" height="40" viewBox="0 0 17 20" style={{ position: "absolute", left: -3, top: -2, transform: `scale(${frame >= clickAt && frame < clickAt + 5 ? 0.85 : 1})` }}>
                  <path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" fill={c.ink} stroke={c.paper} strokeWidth="1.2" />
                </svg>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Bottom-left caption chip that names what we are looking at. */
export const Caption: React.FC<{ eyebrow: string; text: string; dark?: boolean }> = ({ eyebrow, text, dark }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - 6, fps, config: { damping: 18, stiffness: 140 } });
  return (
    <div style={{ position: "absolute", left: 80, bottom: 46, transform: `translateX(${(1 - s) * -60}px)`, opacity: s, display: "flex", alignItems: "stretch" }}>
      <div style={{ width: 10, background: c.vermilion }} />
      <div style={{ background: dark ? c.paper : c.ink, color: dark ? c.ink : c.paper, padding: "14px 22px", display: "grid", gap: 6 }}>
        <div style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.16em", textTransform: "uppercase", color: dark ? c.cobalt : "#9DB0FF" }}>{eyebrow}</div>
        <div style={{ fontFamily: display, fontSize: 34, fontWeight: 600, letterSpacing: "-0.02em" }}>{text}</div>
      </div>
    </div>
  );
};
