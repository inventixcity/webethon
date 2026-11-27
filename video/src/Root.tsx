import React from "react";
import { AbsoluteFill, Audio, Composition, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { FPS } from "./theme";
import { Close, Opening, ScreenScene, Stack } from "./scenes";
import type { Shot } from "./parts";
import durations from "../durations.json";
import shots from "../shots.json";

type SceneDef = { id: string; kind: "opening" | "stack" | "screen" | "close"; index?: string; label?: string; title?: string; pad?: number };

const SCENES: SceneDef[] = [
  { id: "01-open", kind: "opening", pad: 1.4 },
  { id: "02-stack", kind: "stack", pad: 1.0 },
  { id: "03-examiner", kind: "screen", index: "02", label: "Examiner", title: "Build the paper.", pad: 1.0 },
  { id: "04-publish", kind: "screen", index: "03", label: "Publish", title: "Enrol. Check. Publish.", pad: 0.8 },
  { id: "05-candidate", kind: "screen", index: "04", label: "Candidate", title: "Sit the exam.", pad: 0.6 },
  { id: "06-offline", kind: "screen", index: "05", label: "Resilience", title: "Offline? Keep going.", pad: 1.0 },
  { id: "07-monitor", kind: "screen", index: "06", label: "Control room", title: "Watch it live.", pad: 1.0 },
  { id: "08-grading", kind: "screen", index: "07", label: "Grading", title: "Blind grading, AI-assisted.", pad: 0.8 },
  { id: "09-results", kind: "screen", index: "08", label: "Results", title: "Results you can verify.", pad: 1.0 },
  { id: "10-admin", kind: "screen", index: "09", label: "Admin", title: "In control, on record.", pad: 0.8 },
  { id: "11-close", kind: "close", pad: 3.0 },
];

const d = durations as Record<string, number>;
const S = shots as Record<string, Shot[]>;
// Screen scenes get a 26-frame title card before the voice starts.
const leadIn = (s: SceneDef) => (s.kind === "screen" ? 26 : s.kind === "close" ? 10 : s.kind === "opening" ? 6 : 18);
const frames = (s: SceneDef) => Math.ceil(((d[s.id] ?? 6) + (s.pad ?? 1)) * FPS) + leadIn(s);
const starts: number[] = [];
SCENES.reduce((acc, s, i) => {
  starts[i] = acc;
  return acc + frames(s);
}, 0);
const TOTAL = starts[SCENES.length - 1] + frames(SCENES[SCENES.length - 1]);

const Walkthrough: React.FC = () => {
  const frame = useCurrentFrame();
  // Music sits under the voice; it lifts in the opening and closing.
  const music = interpolate(
    frame,
    [0, 20, starts[1] - 10, starts[1] + 10, starts[SCENES.length - 1], starts[SCENES.length - 1] + 20, TOTAL - 60, TOTAL],
    [0, 0.38, 0.38, 0.11, 0.11, 0.34, 0.34, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (
    <AbsoluteFill>
      <Audio src={staticFile("sfx/music.wav")} volume={music} />
      {SCENES.map((s, i) => {
        const len = frames(s);
        return (
          <Sequence key={s.id} from={starts[i]} durationInFrames={len}>
            {s.kind === "opening" ? <Opening duration={len} /> : null}
            {s.kind === "stack" ? <Stack duration={len} /> : null}
            {s.kind === "screen" ? <ScreenScene duration={len} index={s.index!} label={s.label!} title={s.title!} shots={S[s.id] ?? []} /> : null}
            {s.kind === "close" ? <Close duration={len} /> : null}
            <Sequence from={leadIn(s)}>
              <Audio src={staticFile(`vo/${s.id}.mp3`)} volume={1} />
            </Sequence>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => (
  <Composition id="Walkthrough" component={Walkthrough} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
);
