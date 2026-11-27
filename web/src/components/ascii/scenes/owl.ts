/*
 * Adapted from the owl piece in ascii.rest by bas3line (MIT, see src/vendor/ascii-rest/LICENSE).
 * The art is theirs. The head, eyes and lids now follow the login form instead of a timeline,
 * and the night sky above it fills with a constellation as you type.
 */
import type { AsciiFrame, AsciiScene } from "../ascii-canvas";
import { type AsciiGrid, approach, clamp, hash, Tone } from "../grid";

const OWL_COLS = 41;
const OWL_HEIGHT = 20;
/** Rows kept below the branch, so the tail hanging under it stays in frame. */
const GROUND_OFFSET = 5;
const CX = 20;
const LOOP = 11;
const BLINKS = [0.6, 6.1, 6.9];
const BLINK = 0.7;

type Head = { top: string[]; eyes: [number, number][]; beak: number };

const HEADS: Head[] = [
  {
    top: ["          /\\                 /\\", "         /  \\_.--'''''''--._/  \\", "        /                       \\"],
    eyes: [
      [11, 0],
      [22, 0],
    ],
    beak: 20,
  },
  {
    top: ["           /\\                 /\\", "         _/  \\_.--'''''''--._/  \\", "        /                        |"],
    eyes: [
      [12, 0],
      [24, 1],
    ],
    beak: 22,
  },
  {
    top: ["            /\\                  /|", "         _./  \\_.--''''''''--._/ |", "        /                        |"],
    eyes: [
      [13, 0],
      [26, 1],
    ],
    beak: 24,
  },
];

const EYES = [
  [" .----. ", "/ .--. \\", "| (@@) |", "\\ `--' /", " `----' "],
  [" .--. ", "/.--.\\", "|(@@)|", "\\`--'/", " `--' "],
];

const HALF = [
  "       (\\",
  "      /  \\.",
  "     /  ( (\\",
  "    |  ( ( (|",
  "    |  ( ( ( \\",
  "    |  \\\\\\\\\\  \\",
  "    |  \\\\\\\\ \\  \\",
  "     \\  \\\\\\\\ \\  \\",
  "      \\  \\\\\\\\ \\  \\",
  "       `. \\\\\\\\ \\  `.",
  "         `-.\\\\\\ \\____",
];
const FLIP: Record<string, string> = { "/": "\\", "\\": "/", "(": ")", ")": "(", "`": "'" };
const BODY = HALF.map((line) => {
  const padded = line.padEnd(21);
  return (
    padded +
    [...padded.slice(0, 20)]
      .reverse()
      .map((c) => FLIP[c] ?? c)
      .join("")
  );
});
const BRANCH = "=-==-===-==-==-=====-=-=====-==-=-==-=-=";
const UNDER = " `-.__.-'~~`--.__.--'   `--.__.-'~`-.__/ ";

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function blinkAt(time: number) {
  const u = time % LOOP;
  for (const start of BLINKS) {
    const d = u - start;
    if (d >= 0 && d < BLINK) return d < 0.3 ? ease(d / 0.25) : 1 - ease((d - 0.3) / (BLINK - 0.3));
  }
  return 0;
}

export type OwlMood = "idle" | "watching" | "looking-away" | "peeking" | "thinking" | "wrong" | "happy";

type Mark = { x: number; y: number; char: string; secret: boolean };

/** The owl and its sky. The login form calls these methods as the visitor types. */
export class OwlScene implements AsciiScene {
  fps = 24;
  dirty = false;

  private mood: OwlMood = "idle";
  /** Where the form's caret or the pointer is, from -1 (left) to 1 (right). */
  private gaze = 0;
  private turn = 0;
  private pupil = 0;
  private shake = 0;
  private email = "";
  private secretLength = 0;
  private marks: Mark[] = [];
  private cols = 0;
  private rows = 0;

  setMood(mood: OwlMood) {
    if (mood === "wrong") this.shake = 1;
    this.mood = mood;
    this.dirty = true;
  }

  /** Points the owl's eyes. Accepts -1 to 1. */
  look(gaze: number) {
    this.gaze = clamp(gaze, -1, 1);
    this.dirty = true;
  }

  /** Follows the pointer, but only while no field has the owl's attention. */
  lookAtPointer(gaze: number) {
    if (this.mood === "idle") this.look(gaze);
  }

  /** Mirrors the form. The password only ever arrives as a length. */
  setText(email: string, secretLength: number) {
    if (email === this.email && secretLength === this.secretLength) return;
    this.email = email;
    this.secretLength = secretLength;
    this.layoutMarks();
    this.dirty = true;
  }

  private layoutMarks() {
    const { cols, rows } = this;
    this.marks = [];
    if (cols === 0) return;
    const skyBottom = Math.max(6, rows - GROUND_OFFSET - 2);
    let x = Math.floor(cols * 0.62);
    let y = 3;
    const text = this.email + "*".repeat(this.secretLength);
    const emailLength = this.email.length;

    // Each character steps away from the last, so the same text always draws the same shape.
    for (let i = 0; i < Math.min(text.length, 48); i++) {
      const code = text.charCodeAt(i);
      const angle = hash(i + 1, code) * Math.PI * 2;
      const step = 4 + hash(code, i + 3) * 7;
      let nextX = Math.round(x + Math.cos(angle) * step * 1.7);
      let nextY = Math.round(y + Math.sin(angle) * step * 0.6);
      if (nextX < 3 || nextX > cols - 4) nextX = Math.round(x - Math.cos(angle) * step * 1.7);
      if (nextY < 2 || nextY > skyBottom) nextY = Math.round(y - Math.sin(angle) * step * 0.6);
      x = Math.min(cols - 4, Math.max(3, nextX));
      y = Math.min(skyBottom, Math.max(2, nextY));
      // Below the top of the owl's head, stars keep clear of it on whichever side is nearer.
      const owlLeft = cols / 2 - OWL_COLS / 2 - 2;
      const owlRight = owlLeft + OWL_COLS + 4;
      if (y >= rows - OWL_HEIGHT - GROUND_OFFSET && x > owlLeft && x < owlRight) {
        x = Math.round(x < cols / 2 ? Math.max(3, owlLeft) : Math.min(cols - 4, owlRight));
      }
      this.marks.push({ x, y, char: text[i] ?? "*", secret: i >= emailLength });
    }
  }

  private drawSky(grid: AsciiGrid, time: number) {
    // Faint fixed stars, twinkling on their own clocks.
    const count = Math.floor((grid.cols * grid.rows) / 90);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(hash(i, 11) * grid.cols);
      const y = Math.floor(hash(i, 23) * (grid.rows - 8));
      const phase = Math.sin(time * (0.4 + hash(i, 5) * 0.9) + i);
      if (phase > -0.2) grid.set(x, y, phase > 0.75 ? "+" : ".", Tone.muted);
    }

    // The constellation: a dotted line joins each typed character to the one before it.
    let previous: Mark | undefined;
    for (const mark of this.marks) {
      if (previous) {
        const steps = Math.max(Math.abs(mark.x - previous.x), Math.abs(mark.y - previous.y) * 2);
        for (let s = 2; s < steps - 1; s += 2) {
          const u = s / steps;
          grid.set(
            Math.round(previous.x + (mark.x - previous.x) * u),
            Math.round(previous.y + (mark.y - previous.y) * u),
            "·",
            Tone.muted,
          );
        }
      }
      previous = mark;
    }
    this.marks.forEach((mark, index) => {
      const newest = index === this.marks.length - 1;
      grid.set(mark.x, mark.y, mark.char, newest ? Tone.accent : Tone.base);
    });
  }

  private drawOwl(grid: AsciiGrid, ox: number, oy: number, pose: number, lids: [number, number], offset: number) {
    const put = (x: number, y: number, value: string, tone: Tone = Tone.base) => grid.text(ox + x, oy + y, value, tone);

    BODY.forEach((line, row) => {
      const start = line.search(/\S/);
      grid.text(ox + start, oy + 9 + row, line.slice(start, line.trimEnd().length), Tone.base, true);
    });
    for (let r = 10; r < 19; r++) {
      const gap = r < 13 ? 4 : r < 16 ? 3 : 2;
      const shift = r & 1 ? Math.floor(gap / 2) : 0;
      for (let c = 11; c < 30; c++) {
        if (grid.get(ox + c, oy + r) === " " && (((c - CX + shift) % gap) + gap) % gap === 0) put(c, r, "v");
      }
    }
    for (let c = 10; c <= 30; c += 2) put(c, 9, c & 2 ? "'" : "`");
    put(CX - 7, 20, "mm");
    put(CX + 6, 20, "mm");
    put(CX - 2, 21, "|||||");
    put(CX - 2, 22, "'''''");

    const index = Math.abs(pose);
    const base = HEADS[index] ?? HEADS[0];
    if (!base) return;
    const mirror = (value: string) =>
      [...value.padEnd(OWL_COLS)]
        .reverse()
        .map((c) => (c === "`" ? c : (FLIP[c] ?? c)))
        .join("");
    const head: Head =
      pose >= 0
        ? base
        : {
            top: base.top.map(mirror),
            eyes: base.eyes
              .map(([x, e]): [number, number] => [OWL_COLS - x - (EYES[e]?.[0]?.length ?? 0), e])
              .reverse(),
            beak: OWL_COLS - 1 - base.beak,
          };

    // Blank the face first so nothing shows through it.
    for (let r = 3; r < 9; r++) grid.text(ox + 8, oy + r, " ".repeat(25), Tone.base, true);
    head.top.forEach((line, row) => {
      const start = line.search(/\S/);
      grid.text(ox + start, oy + 1 + row, line.slice(start).trimEnd(), Tone.base, true);
    });
    for (let r = 4; r < 9; r++) {
      put(7, r, "|");
      put(33, r, "|");
    }
    for (let r = 3; r < 9; r++) {
      for (let c = 9; c < 32; c++) {
        if ((r + c) & 1) continue;
        if (r >= 4 && c >= 10 && c <= 31) continue;
        if (grid.get(ox + c, oy + r) === " ") put(c, r, ((c >> 1) + r) & 1 ? "'" : "`", Tone.muted);
      }
    }

    head.eyes.forEach(([x, sprite], side) => {
      const eye = (EYES[sprite] ?? EYES[0] ?? []).slice();
      const width = eye[0]?.length ?? 0;
      const inner = width - 4;
      const lid = lids[side] ?? 0;
      if (lid > 0.2) eye[1] = `${(eye[1] ?? "").slice(0, 2)}${"_".repeat(inner)}${(eye[1] ?? "").slice(width - 2)}`;

      let pupilColumn = -1;
      if (lid > 0.6) {
        eye[2] = `${(eye[2] ?? "").slice(0, 2)}${"-".repeat(inner)}${(eye[2] ?? "").slice(width - 2)}`;
      } else {
        // The wide eye has room for the pupil to slide within it.
        const room = width - 4;
        const glyph = this.mood === "wrong" ? "xx" : this.mood === "happy" ? "^^" : this.mood === "thinking" ? ".." : "@@";
        const left = Math.round(((room - 2) / 2) * (offset + 1));
        eye[2] = `|${" ".repeat(left)}(${glyph})${" ".repeat(Math.max(0, room - 2 - left))}|`;
        pupilColumn = left + 2;
      }
      eye.forEach((line, row) => {
        grid.text(ox + x, oy + 4 + row, line, Tone.base, true);
      });
      if (pupilColumn >= 0) {
        const row = eye[2] ?? "";
        grid.text(ox + x + pupilColumn, oy + 6, row.slice(pupilColumn, pupilColumn + 2), Tone.accent, true);
      }
    });
    put(head.beak, 7, "V");
  }

  draw(grid: AsciiGrid, { time, dt, reduced }: AsciiFrame) {
    if (grid.cols !== this.cols || grid.rows !== this.rows) {
      this.cols = grid.cols;
      this.rows = grid.rows;
      this.layoutMarks();
    }

    const { mood } = this;
    let target = this.gaze * 2;
    if (mood === "looking-away") target = -2;
    if (mood === "peeking") target = -1;
    if (mood === "thinking") target = Math.sin(time * 3) * 2;
    if (this.shake > 0.02) target = Math.sin(time * 34) * 2 * this.shake;
    this.shake = reduced ? 0 : Math.max(0, this.shake - dt * 1.4);
    this.turn = approach(this.turn, target, 9, dt, reduced);

    const pupilTarget = mood === "thinking" ? Math.sin(time * 6) : this.gaze;
    this.pupil = approach(this.pupil, pupilTarget, 14, dt, reduced);

    const blink = reduced ? 0 : blinkAt(time);
    let lids: [number, number] = [blink, blink];
    if (mood === "looking-away") lids = [1, 1];
    // The eye nearest the form opens just a crack.
    if (mood === "peeking") lids = [0.4, 1];
    if (mood === "happy") lids = [0, 0];

    this.drawSky(grid, time);

    const groundRow = Math.max(OWL_HEIGHT + 1, grid.rows - GROUND_OFFSET);
    const ox = Math.max(1, Math.floor(grid.cols * 0.5 - OWL_COLS / 2));
    const oy = groundRow - OWL_HEIGHT;

    for (let x = 0; x < grid.cols; x++) {
      grid.set(x, groundRow, BRANCH[((x - ox) % BRANCH.length + BRANCH.length) % BRANCH.length] ?? "=");
      if (x % 3 !== 0) grid.set(x, groundRow + 1, UNDER[((x - ox) % UNDER.length + UNDER.length) % UNDER.length] ?? " ");
    }
    this.drawOwl(grid, ox, oy, Math.round(this.turn), lids, clamp(this.pupil, -1, 1));
  }
}
