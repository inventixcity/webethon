/** Colours a cell can take. `base` follows the surrounding text colour. */
export const Tone = { base: 0, muted: 1, accent: 2 } as const;
export type Tone = (typeof Tone)[keyof typeof Tone];

/** A character grid that scenes draw into. Every frame starts blank. */
export class AsciiGrid {
  cols = 0;
  rows = 0;
  chars: string[] = [];
  tones = new Uint8Array(0);

  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.chars = new Array(cols * rows).fill(" ");
    this.tones = new Uint8Array(cols * rows);
  }

  clear() {
    this.chars.fill(" ");
    this.tones.fill(Tone.base);
  }

  has(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  get(x: number, y: number) {
    return this.has(x, y) ? (this.chars[y * this.cols + x] ?? " ") : " ";
  }

  set(x: number, y: number, char: string, tone: Tone = Tone.base) {
    if (!this.has(x, y)) return;
    const index = y * this.cols + x;
    this.chars[index] = char;
    this.tones[index] = tone;
  }

  /** Writes a string. Spaces leave what's underneath, unless `opaque` is set. */
  text(x: number, y: number, value: string, tone: Tone = Tone.base, opaque = false) {
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char && (char !== " " || opaque)) this.set(x + i, y, char, tone);
    }
  }

  /** Copies a multi-line picture, keeping the sky out of anything enclosed by its outline. */
  blit(picture: string, x: number, y: number, tone: Tone = Tone.base) {
    picture.split("\n").forEach((line, row) => {
      const start = line.search(/\S/);
      if (start < 0) return;
      const end = line.trimEnd().length;
      this.text(x + start, y + row, line.slice(start, end), tone, true);
    });
  }
}

/** Moves a value toward its target at a steady rate. Snaps when motion is reduced. */
export function approach(value: number, target: number, rate: number, dt: number, reduced: boolean) {
  if (reduced) return target;
  return value + (target - value) * (1 - Math.exp(-rate * dt));
}

export function hash(x: number, y: number) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
