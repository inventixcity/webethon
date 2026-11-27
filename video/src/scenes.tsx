import React from "react";
import { AbsoluteFill, Audio, Easing, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { c, display, mono } from "./theme";
import { Caption, Eyebrow, Mark, Paper, Rise, Shot, ShotFrame, Sweep } from "./parts";

/** 01: the problem in three beats, then the name and promise. */
export const Opening: React.FC<{ duration: number }> = ({ duration }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beats = ["The Wi-Fi drops.", "A tab switches.", "A result gets questioned."];
  const lead = 96;
  const beatLen = 30;
  const titleAt = lead + beats.length * beatLen + 22;
  const flash = interpolate(frame, [titleAt - 2, titleAt + 6], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const markIn = spring({ frame: frame - titleAt, fps, config: { damping: 12, stiffness: 180 } });
  return (
    <Paper dark={frame < titleAt}>
      {frame < titleAt ? (
        <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 140 }}>
          <Eyebrow index="00" label="Online exams, today" dark />
          <div style={{ height: 30 }} />
          {frame < lead ? <Rise text="Online exams break at the worst possible moment." size={96} color={c.paper} /> : null}
          {beats.map((b, i) =>
            frame >= lead + i * beatLen ? (
              <Sequence key={b} from={lead + i * beatLen} layout="none">
                <Rise text={b} size={110} color={i === 2 ? c.amber : c.paper} />
              </Sequence>
            ) : null,
          )}
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 140 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 26, transform: `scale(${0.6 + markIn * 0.4})`, transformOrigin: "left center", opacity: markIn }}>
            <Mark size={84} />
            <div style={{ fontFamily: mono, fontSize: 34, letterSpacing: "0.22em", fontWeight: 700 }}>INVENTIX INVIGIL</div>
          </div>
          <div style={{ height: 36 }} />
          <Sequence from={titleAt + 6} layout="none">
            <Rise text="Exams that hold up." size={170} weight={800} stagger={4} />
          </Sequence>
          <div style={{ height: 40, width: 1100 }}>
            <Sweep delay={titleAt + 20} />
          </div>
          <Sequence from={titleAt + 30} layout="none">
            <div style={{ fontFamily: mono, fontSize: 26, letterSpacing: "0.14em", color: c.inkSoft, textTransform: "uppercase" }}>
              Secure · Failure-resilient · Verifiable online examinations
            </div>
          </Sequence>
        </AbsoluteFill>
      )}
      <AbsoluteFill style={{ background: c.paper, opacity: frame >= titleAt - 2 ? flash : 0 }} />
      {beats.map((_, i) => (
        <Sequence key={i} from={lead + i * beatLen} durationInFrames={20}>
          <Audio src={staticFile("sfx/pop.wav")} volume={0.32} />
        </Sequence>
      ))}
      <Sequence from={titleAt - 40} durationInFrames={60}>
        <Audio src={staticFile("sfx/riser.wav")} volume={0.3} />
      </Sequence>
      <Sequence from={titleAt} durationInFrames={40}>
        <Audio src={staticFile("sfx/impact.wav")} volume={0.45} />
      </Sequence>
      {duration > 0 ? null : null}
    </Paper>
  );
};

const STACK: Array<{ group: string; items: string; accent: string }> = [
  { group: "Core API", items: "Rust · Axum 0.8 · SQLx · Tokio", accent: c.vermilion },
  { group: "Database", items: "PostgreSQL 17 · Supabase · Row-level security", accent: c.cobalt },
  { group: "Web", items: "Next.js 16 · React 19 · Tailwind 4", accent: c.ink },
  { group: "Sessions", items: "__Host- HttpOnly cookies · CSRF · rate limits", accent: c.amber },
  { group: "Identity", items: "Argon2 passwords · TOTP · admin step-up", accent: c.vermilion },
  { group: "Resilience", items: "HMAC time leases · hash-chained offline journal", accent: c.cobalt },
  { group: "Trust", items: "Ed25519-signed results · audit trail", accent: c.ink },
  { group: "AI", items: "Gemini grading assistant · no personal data", accent: c.amber },
  { group: "Ship", items: "Vercel · Render · GitHub Actions · Resend", accent: c.cobalt },
];

/** 02: the stack as a grid of square cards, plus the test counter. */
export const Stack: React.FC<{ duration: number }> = ({ duration }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const per = Math.max(8, Math.floor((duration - 90) / STACK.length));
  const tests = Math.round(interpolate(frame, [duration - 110, duration - 40], [0, 520], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }));
  return (
    <Paper>
      <AbsoluteFill style={{ padding: "90px 120px", display: "grid", gridTemplateRows: "auto auto 1fr", gap: 28 }}>
        <Eyebrow index="01" label="Under the hood" />
        <Rise text="Built for exams that can't fail." size={92} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 22, alignContent: "start" }}>
          {STACK.map((s, i) => {
            const k = spring({ frame: frame - 20 - i * per, fps, config: { damping: 15, stiffness: 170 } });
            return (
              <div key={s.group} style={{ border: `2px solid ${c.ink}`, background: c.paperRaised, padding: "22px 26px", transform: `translateY(${(1 - k) * 40}px)`, opacity: k, boxShadow: `8px 8px 0 ${s.accent}` }}>
                <div style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.16em", textTransform: "uppercase", color: c.inkMuted }}>{s.group}</div>
                <div style={{ fontFamily: display, fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 8, color: c.ink }}>{s.items}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
      <div style={{ position: "absolute", right: 120, bottom: 70, display: "flex", alignItems: "baseline", gap: 16, opacity: frame > duration - 115 ? 1 : 0 }}>
        <span style={{ fontFamily: display, fontWeight: 800, fontSize: 120, color: c.cobalt, letterSpacing: "-0.04em" }}>{tests}+</span>
        <span style={{ fontFamily: mono, fontSize: 24, letterSpacing: "0.14em", textTransform: "uppercase", color: c.inkSoft }}>automated tests</span>
      </div>
      {STACK.map((_, i) => (
        <Sequence key={i} from={20 + i * per} durationInFrames={12}>
          <Audio src={staticFile("sfx/click.wav")} volume={0.3} />
        </Sequence>
      ))}
    </Paper>
  );
};

/** A walkthrough scene: a run of screenshots with a heading, a caption per shot and whooshes between them. */
export const ScreenScene: React.FC<{ duration: number; index: string; label: string; title: string; shots: Shot[] }> = ({ duration, index, label, title, shots }) => {
  const frame = useCurrentFrame();
  const intro = 26;
  const per = Math.floor((duration - intro) / Math.max(1, shots.length));
  const dark = shots.some((s) => s.dark) && frame >= intro && shots[Math.min(shots.length - 1, Math.floor((frame - intro) / per))]?.dark;
  const head = interpolate(frame, [0, 8, intro - 4, intro + 4], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Paper dark={Boolean(dark)}>
      <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 140, opacity: head }}>
        <Eyebrow index={index} label={label} />
        <div style={{ height: 22 }} />
        <Rise text={title} size={120} />
      </AbsoluteFill>
      {shots.map((shot, i) => (
        <Sequence key={shot.file + i} from={intro + i * per} durationInFrames={per}>
          <ShotFrame shot={shot} duration={per} />
          <Caption eyebrow={shot.eyebrow} text={shot.caption} dark={shot.dark} />
          <Audio src={staticFile("sfx/whoosh.wav")} volume={0.22} />
          {shot.click ? (
            <Sequence from={Math.round(per * 0.55)} durationInFrames={10}>
              <Audio src={staticFile("sfx/click.wav")} volume={0.3} />
            </Sequence>
          ) : null}
        </Sequence>
      ))}
    </Paper>
  );
};

/** 11: the sign-off. */
export const Close: React.FC<{ duration: number }> = ({ duration }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = spring({ frame, fps, config: { damping: 14, stiffness: 140 } });
  const words = ["Resilient.", "Fair.", "Verifiable."];
  return (
    <Paper>
      <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 140, gap: 26 }}>
        <div style={{ display: "flex", gap: 40 }}>
          {words.map((w, i) => (
            <Sequence key={w} from={i * 14} layout="none">
              <Rise text={w} size={110} color={[c.cobalt, c.amber, c.vermilion][i]} weight={800} />
            </Sequence>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 26, opacity: k, marginTop: 30 }}>
          <Mark size={76} />
          <div style={{ fontFamily: display, fontSize: 84, fontWeight: 800, letterSpacing: "-0.035em" }}>Inventix Invigil</div>
        </div>
        <div style={{ width: 1000 }}>
          <Sweep delay={40} />
        </div>
        <Sequence from={50} layout="none">
          <div style={{ display: "grid", gap: 12, fontFamily: mono, fontSize: 26, letterSpacing: "0.1em", color: c.inkSoft, textTransform: "uppercase" }}>
            <span style={{ color: c.ink, fontWeight: 700 }}>invigil-ivory.vercel.app</span>
            <span>Technoverse 5.0 Web-e-Thon · COMSATS University Lahore</span>
          </div>
        </Sequence>
      </AbsoluteFill>
      {words.map((_, i) => (
        <Sequence key={i} from={i * 14} durationInFrames={14}>
          <Audio src={staticFile("sfx/pop.wav")} volume={0.32} />
        </Sequence>
      ))}
      <Sequence from={44} durationInFrames={40}>
        <Audio src={staticFile("sfx/impact.wav")} volume={0.45} />
      </Sequence>
      {duration > 0 ? null : null}
    </Paper>
  );
};
