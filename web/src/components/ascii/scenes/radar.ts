/*
 * The scope is adapted from the radar piece in ascii.rest by bas3line (MIT, see
 * src/vendor/ascii-rest/LICENSE). Its contacts used to drift on a timeline. Here each
 * digit you type becomes one, and the sweep answers the code as it's entered.
 */
import type { AsciiFrame, AsciiScene } from "../ascii-canvas";
import { type AsciiGrid, approach, hash, Tone } from "../grid";

const COLS = 53;
const ROWS = 25;
const R = 19; // scope radius, in cells wide and half-cells tall
const CX = 26;
const CY = 24.5;
const TRAIL = 0.9; // radians of afterglow behind the beam
const TAU = Math.PI * 2;
const HALF = [" ", "▀", "▄", "█"];
const SHADE = " ░▒▓█";
const CODE_LENGTH = 6;

const bearing = (x: number, y: number) => (Math.atan2(x - CX, CY - y) + TAU) % TAU;

/** The bezel, range rings and compass marks, which never change. */
function buildScope() {
  const back: string[] = new Array(COLS * ROWS).fill(" ");
  const ring = new Uint8Array(COLS * ROWS * 2);
  const four = (x: number, y: number, plot: (c: number, p: number) => void) => {
    const c = Math.round(x);
    const p = Math.round(y - 0.01);
    for (const [cc, pp] of [
      [c, p],
      [2 * CX - c, p],
      [c, 2 * CY - p],
      [2 * CX - c, 2 * CY - p],
    ] as const) {
      plot(cc, pp);
    }
  };
  const plot = (c: number, p: number) => {
    if (c >= 0 && c < COLS && p >= 0 && p < ROWS * 2) ring[c + p * COLS] = 1;
  };
  const outer = R + 1.5;
  for (let dx = 0; dx <= outer; dx++) four(CX + dx, CY - Math.sqrt(outer * outer - dx * dx), plot);
  for (let dy = 0.5; dy <= outer; dy++) four(CX + Math.sqrt(outer * outer - dy * dy), CY - dy, plot);
  for (let i = 0; i < COLS * ROWS; i++) {
    const c = i % COLS;
    const p = 2 * Math.floor(i / COLS);
    const k = (ring[c + p * COLS] ?? 0) | ((ring[c + (p + 1) * COLS] ?? 0) << 1);
    if (k) back[i] = HALF[k] ?? " ";
  }
  for (const radius of [R / 3, (2 * R) / 3]) {
    for (let i = 0; i <= 90; i++) {
      const a = (i / 90) * TAU;
      const c = Math.round(CX + radius * Math.sin(a));
      const r = Math.round(CY - radius * Math.cos(a) - 0.01) >> 1;
      if (i % 3 === 0) back[c + r * COLS] = "·";
    }
  }
  back[CX + (Math.round(CY - 0.01) >> 1) * COLS] = "+";
  const put = (text: string, c: number, r: number) => {
    for (let i = 0; i < text.length; i++) back[c + i + r * COLS] = text[i] ?? " ";
  };
  put("000", CX - 1, 1);
  put("180", CX - 1, ROWS - 2);
  put("270", 1, 12);
  put("090", COLS - 4, 12);

  const inside: [index: number, bearing: number][] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const y = 2 * r + 0.5;
      if (Math.hypot(c - CX, y - CY) < R - 0.3) inside.push([c + r * COLS, bearing(c, y)]);
    }
  }
  return { back, inside };
}

export type RadarStatus = "listening" | "checking" | "wrong" | "locked";

type Contact = { x: number; y: number; digit: string; born: number };

/** A radar that fills with contacts as a code is typed. */
export class RadarScene implements AsciiScene {
  size = { cols: COLS, rows: ROWS };
  fps = 30;
  dirty = false;

  private readonly scope = buildScope();
  private contacts: (Contact | undefined)[] = new Array(CODE_LENGTH).fill(undefined);
  private status: RadarStatus = "listening";
  private sweep = 0;
  private speed = TAU / 5;
  private clock = 0;
  private burst = 0;
  private lock = 0;

  /** Mirrors the code field. New digits appear as contacts, and deleted ones vanish. */
  setCode(code: string) {
    for (let i = 0; i < CODE_LENGTH; i++) {
      const digit = code[i];
      const existing = this.contacts[i];
      if (!digit) {
        this.contacts[i] = undefined;
      } else if (existing?.digit !== digit) {
        // The digit sets how far out the contact sits, and its place in the code sets the bearing.
        const angle = (i / CODE_LENGTH) * TAU + 0.45;
        const radius = R * (0.42 + 0.045 * Number(digit));
        this.contacts[i] = {
          x: Math.round(CX + radius * Math.sin(angle)),
          y: CY - radius * Math.cos(angle),
          digit,
          born: this.clock,
        };
      }
    }
    this.dirty = true;
  }

  setStatus(status: RadarStatus) {
    if (status === "wrong") this.burst = 1;
    this.status = status;
    this.dirty = true;
  }

  draw(grid: AsciiGrid, { time, dt, reduced }: AsciiFrame) {
    this.clock = time;
    const { back, inside } = this.scope;
    const count = this.contacts.filter(Boolean).length;
    const { status } = this;

    let targetSpeed = TAU / 5 + count * 0.5;
    if (status === "checking") targetSpeed = TAU * 1.6;
    if (status === "locked") targetSpeed = 0;
    this.speed = approach(this.speed, targetSpeed, status === "locked" ? 3 : 6, dt, reduced);
    this.sweep = (this.sweep + this.speed * dt) % TAU;
    this.burst = reduced ? 0 : Math.max(0, this.burst - dt * 1.3);
    this.lock = approach(this.lock, status === "locked" ? 1 : 0, 4, dt, reduced);

    for (let i = 0; i < back.length; i++) {
      const char = back[i];
      if (char && char !== " ") grid.set(i % COLS, Math.floor(i / COLS), char, char === "·" ? Tone.muted : Tone.base);
    }

    const since = (b: number) => (((this.sweep - b) % TAU) + TAU) % TAU;

    for (const [index, b] of inside) {
      const x = index % COLS;
      const y = Math.floor(index / COLS);
      // A wrong code tears the picture into static that clears from the middle outward.
      if (this.burst > 0 && hash(x + Math.floor(time * 24), y) < this.burst * 0.55) {
        grid.set(x, y, SHADE[1 + Math.floor(hash(y, x + Math.floor(time * 24)) * 3)] ?? "░", Tone.muted);
        continue;
      }
      const a = since(b);
      if (a < TRAIL && this.lock < 0.5) {
        grid.set(x, y, SHADE[a < 0.1 ? 3 : a < 0.35 ? 2 : 1] ?? "░", a < 0.1 ? Tone.base : Tone.muted);
      }
    }

    this.contacts.forEach((contact) => {
      if (!contact) return;
      const row = Math.round(contact.y - 0.01) >> 1;
      const age = reduced ? 9 : time - contact.born;

      // A ring opens from each new contact, so the digit lands with a ping.
      if (age < 0.8) {
        const radius = age * 9;
        for (let i = 0; i < 32; i++) {
          const a = (i / 32) * TAU;
          grid.set(
            Math.round(contact.x + radius * Math.sin(a)),
            Math.round(contact.y - radius * Math.cos(a) * 1) >> 1,
            "·",
            Tone.accent,
          );
        }
      }
      const lit = since(bearing(contact.x, contact.y)) < 1.1 || age < 0.8 || status === "locked";
      grid.set(contact.x - 1, row, "[", Tone.muted);
      grid.set(contact.x, row, contact.digit, lit ? Tone.accent : Tone.base);
      grid.set(contact.x + 1, row, "]", Tone.muted);
    });

    if (this.lock > 0.5) {
      const row = Math.round(CY - 0.01) >> 1;
      grid.text(CX - 5, row, " [ LOCKED ] ", Tone.accent, true);
    }

    const degrees = String(Math.round((this.sweep * 180) / Math.PI) % 360).padStart(3, "0");
    const state = status === "checking" ? "checking" : status === "wrong" ? "no match" : status === "locked" ? "locked" : "listening";
    grid.text(1, 1, `brg ${degrees}°`, Tone.muted);
    grid.text(COLS - 12, 1, "code channel", Tone.muted);
    grid.text(1, ROWS - 2, `contacts ${count}/${CODE_LENGTH}`, count === CODE_LENGTH ? Tone.accent : Tone.muted);
    grid.text(COLS - state.length - 1, ROWS - 2, state, status === "listening" ? Tone.muted : Tone.accent);
  }
}
