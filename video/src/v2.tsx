import React from "react";
import { AbsoluteFill, Audio, Composition, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { c, display, FPS, mono } from "./theme";
import { Caption, Eyebrow, Mark, Paper, Rise } from "./parts";
import { Close, Opening, Stack } from "./scenes";
import durations from "../durations2.json";
import clips from "../clips.json";

type Scene = { id: string; kind: "opening" | "stack" | "clip" | "mobile" | "close"; clip?: string; index?: string; label?: string; title?: string; eyebrow?: string; caption?: string; dark?: boolean };

const SCENES: Scene[] = [
  { id: "a01-open", kind: "opening" },
  { id: "a02-stack", kind: "stack" },
  { id: "a03-landing", kind: "clip", clip: "landing", index: "02", label: "Live site", title: "The live site.", eyebrow: "Public · Landing", caption: "invigil-ivory.vercel.app" },
  { id: "a04-signin", kind: "clip", clip: "signin", index: "03", label: "Access", title: "One-screen sign in.", eyebrow: "Access · Sign in", caption: "Accounts come from the institution" },
  { id: "a05-bank", kind: "clip", clip: "bank", index: "04", label: "Examiner", title: "The question bank.", eyebrow: "Examiner · Question bank", caption: "Filter, preview, see past performance" },
  { id: "a06-exam", kind: "clip", clip: "exam", index: "05", label: "Examiner", title: "New exam in a minute.", eyebrow: "Examiner · New exam", caption: "Window, marks and integrity rules" },
  { id: "a07-paper", kind: "clip", clip: "paper", index: "06", label: "Examiner", title: "Build the paper.", eyebrow: "Examiner · Paper", caption: "Fair papers: equal difficulty, different draws" },
  { id: "a08-publish", kind: "clip", clip: "publish", index: "07", label: "Examiner", title: "Enrol. Check. Publish.", eyebrow: "Examiner · Review & publish", caption: "Every rule checked before the freeze" },
  { id: "a09-candidate", kind: "clip", clip: "candidate", index: "08", label: "Candidate", title: "Sit the exam.", eyebrow: "Candidate · Dashboard & lobby", caption: "Server-timed, nothing hidden" },
  { id: "a10-workspace", kind: "clip", clip: "workspace", index: "09", label: "Candidate", title: "Answer. Flag. Note.", eyebrow: "Candidate · Workspace", caption: "Saved within a second" },
  { id: "a11-offline", kind: "clip", clip: "offline", index: "10", label: "Resilience", title: "Pull the plug.", eyebrow: "Resilience · Offline journal", caption: "Hash-chained on the device, synced on return" },
  { id: "a12-monitor", kind: "clip", clip: "monitor", index: "11", label: "Control room", title: "Watch it live.", eyebrow: "Control room · Live", caption: "Progress, connection, integrity signals" },
  { id: "a13-grading", kind: "clip", clip: "grading", index: "12", label: "Grading", title: "Blind grading + AI.", eyebrow: "Grading · AI assistant", caption: "A suggested mark. The examiner decides." },
  { id: "a14-results", kind: "clip", clip: "results", index: "13", label: "Results", title: "Results that explain themselves.", eyebrow: "Results · Analytics", caption: "Distribution, topics, item analysis" },
  { id: "a15-verify", kind: "clip", clip: "verify", index: "14", label: "Trust", title: "Verify in seconds.", eyebrow: "Trust · Public verify", caption: "Ed25519-signed and tamper-evident" },
  { id: "a16-admin", kind: "clip", clip: "admin", index: "15", label: "Admin", title: "In control, on record.", eyebrow: "Admin · Overview, audit, requests", caption: "Every action on the record" },
  { id: "a17-mobile", kind: "mobile", index: "16", label: "Responsive", title: "Pocket-sized." },
  { id: "a18-close", kind: "close" },
];

const d = durations as Record<string, number>;
const clipLen = clips as Record<string, number>;
const TITLE = 22; // frames of title card before the footage
const lead = (s: Scene) => (s.kind === "clip" || s.kind === "mobile" ? TITLE : s.kind === "opening" ? 6 : 12);
const len = (s: Scene) => Math.ceil(((d[s.id] ?? 5) + (s.kind === "close" ? 3 : s.kind === "mobile" ? 2.6 : s.kind === "clip" ? 2.25 : 0.8)) * FPS) + lead(s);
const starts: number[] = [];
SCENES.reduce((acc, s, i) => ((starts[i] = acc), acc + len(s)), 0);
const TOTAL = starts[SCENES.length - 1] + len(SCENES[SCENES.length - 1]);

/** Three accent bars that sweep across: the fast cut between scenes. */
const Wipe: React.FC = () => {
  const f = useCurrentFrame();
  const cols = [c.cobalt, c.amber, c.vermilion];
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {cols.map((col, i) => {
        const x = interpolate(f, [i * 2, i * 2 + 12], [-110, 110], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return <div key={col} style={{ position: "absolute", top: `${i * 33.4}%`, height: "33.4%", left: 0, right: 0, background: col, transform: `translateX(${x}%) skewX(-12deg)` }} />;
      })}
    </AbsoluteFill>
  );
};

/** Full-frame footage (no zoom), sped to fit the voice, with a slam-in title before it. */
const ClipScene: React.FC<{ s: Scene; duration: number }> = ({ s, duration }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const visible = duration - TITLE;
  const src = clipLen[s.clip!] ?? visible / fps;
  const rate = Math.min(2.6, Math.max(0.75, src / (visible / fps)));
  const slam = spring({ frame: f, fps, config: { damping: 11, stiffness: 220 } });
  const titleOut = interpolate(f, [TITLE - 5, TITLE], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const footIn = interpolate(f, [TITLE - 4, TITLE + 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: c.ink }}>
      <Sequence from={TITLE - 4}>
        <AbsoluteFill style={{ opacity: footIn }}>
          <OffthreadVideo src={staticFile(`clips/${s.clip}.mp4`)} playbackRate={rate} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
        <Sequence from={8}>
          <Caption eyebrow={s.eyebrow!} text={s.caption!} />
        </Sequence>
        <ProgressTag index={s.index!} label={s.label!} />
      </Sequence>
      {f < TITLE ? (
        <AbsoluteFill style={{ background: c.paper, justifyContent: "center", paddingLeft: 140, opacity: titleOut }}>
          <div style={{ transform: `scale(${0.85 + slam * 0.15})`, transformOrigin: "left center" }}>
            <Eyebrow index={s.index!} label={s.label!} />
            <div style={{ height: 18 }} />
            <div style={{ fontFamily: display, fontWeight: 800, fontSize: 130, letterSpacing: "-0.04em", lineHeight: 0.95, color: c.ink }}>{s.title}</div>
          </div>
        </AbsoluteFill>
      ) : null}
      <Sequence durationInFrames={16}>
        <Wipe />
      </Sequence>
    </AbsoluteFill>
  );
};

/** Top-right chapter tag on the footage. */
const ProgressTag: React.FC<{ index: string; label: string }> = ({ index, label }) => (
  <div style={{ position: "absolute", top: 28, right: 36, display: "flex", alignItems: "center", gap: 10, background: c.ink, color: c.paper, padding: "8px 14px", fontFamily: mono, fontSize: 18, letterSpacing: "0.14em", textTransform: "uppercase" }}>
    <span style={{ width: 9, height: 9, background: c.vermilion }} />
    <span style={{ color: "#9DB0FF", fontWeight: 700 }}>{index}</span>
    <span>{label}</span>
  </div>
);

/** Two tilted phones, portrait and landscape, scrolling the real site. */
const Phone: React.FC<{ clip: string; w: number; h: number; tilt: string; delay: number }> = ({ clip, w, h, tilt, delay }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = spring({ frame: f - delay, fps, config: { damping: 14, stiffness: 120 } });
  return (
    <div style={{ perspective: 1600, opacity: k }}>
      <div style={{ transform: `${tilt} translateY(${(1 - k) * 120}px)`, transformStyle: "preserve-3d", padding: 16, background: c.ink, borderRadius: 46, boxShadow: `24px 30px 0 ${c.cobalt}55, 0 40px 80px rgba(0,0,0,0.35)` }}>
        <div style={{ width: w, height: h, borderRadius: 32, overflow: "hidden", background: c.paper }}>
          <OffthreadVideo src={staticFile(`clips/${clip}.mp4`)} muted playbackRate={1.4} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      </div>
    </div>
  );
};
const MobileScene: React.FC<{ s: Scene; duration: number }> = ({ s }) => {
  const f = useCurrentFrame();
  return (
    <Paper>
      {f < TITLE ? (
        <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 140 }}>
          <Eyebrow index={s.index!} label={s.label!} />
          <div style={{ height: 18 }} />
          <div style={{ fontFamily: display, fontWeight: 800, fontSize: 130, letterSpacing: "-0.04em" }}>{s.title}</div>
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 140 }}>
          <Phone clip="mobile-portrait" w={330} h={714} tilt="rotateY(22deg) rotateX(8deg) rotateZ(-4deg)" delay={TITLE} />
          <Phone clip="mobile-landscape" w={714} h={330} tilt="rotateY(-20deg) rotateX(10deg) rotateZ(3deg)" delay={TITLE + 6} />
          <div style={{ position: "absolute", left: 120, bottom: 70, fontFamily: mono, fontSize: 22, letterSpacing: "0.14em", textTransform: "uppercase", color: c.inkSoft }}>Portrait · Landscape · same live site</div>
        </AbsoluteFill>
      )}
      <Sequence durationInFrames={16}>
        <Wipe />
      </Sequence>
    </Paper>
  );
};

const Walkthrough2: React.FC = () => {
  const frame = useCurrentFrame();
  const music = interpolate(frame, [0, 20, starts[1] - 10, starts[1] + 10, starts[SCENES.length - 1], starts[SCENES.length - 1] + 20, TOTAL - 60, TOTAL], [0, 0.4, 0.4, 0.13, 0.13, 0.36, 0.36, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: c.paper }}>
      <Audio src={staticFile("sfx/music2.wav")} volume={music} />
      {SCENES.map((s, i) => {
        const L = len(s);
        return (
          <Sequence key={s.id} from={starts[i]} durationInFrames={L}>
            {s.kind === "opening" ? <Opening duration={L} /> : null}
            {s.kind === "stack" ? <Stack duration={L} /> : null}
            {s.kind === "clip" ? <ClipScene s={s} duration={L} /> : null}
            {s.kind === "mobile" ? <MobileScene s={s} duration={L} /> : null}
            {s.kind === "close" ? <Close duration={L} /> : null}
            {s.kind === "clip" || s.kind === "mobile" ? (
              <Sequence durationInFrames={16}>
                <Audio src={staticFile("sfx/whoosh.wav")} volume={0.24} />
              </Sequence>
            ) : null}
            <Sequence from={lead(s)}>
              <Audio src={staticFile(`vo2/${s.id}.mp3`)} />
            </Sequence>
          </Sequence>
        );
      })}
      <div style={{ display: "none" }}>
        <Mark />
        <Rise text="" size={1} />
      </div>
    </AbsoluteFill>
  );
};

export const V2: React.FC = () => <Composition id="Walkthrough2" component={Walkthrough2} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />;
