import type { AsciiFrame, AsciiScene } from "../ascii-canvas";
import { type AsciiGrid, approach, hash, Tone } from "../grid";

const COLS = 66;
const ROWS = 19;
const SLOTS = 12;
const SLOT_WIDTH = 4;
const BLADE_LEFT = 16;
const HOUSING = 1;
const BLADE_TOP = 13; // the row teeth stand on
const BLADE_ROWS = 3;
const REST = 3; // how far a pin hangs before it's been set
const METAL = " .:=#"; // the blade's fill, from weak password to strong

const BOW = [
  "    .-----.",
  "  .'       `.",
  " /   .---.   \\",
  "|   (     )   |",
  " \\   `---'   /",
  "  `.       .'",
  "    `-----'",
];
const SPIN = ["|", "/", "-", "\\"];

/** The tooth a character cuts, 0 to 3 rows tall. Depends on place as well, so it's no plain lookup. */
const toothFor = (code: number, slot: number) => 1 + Math.floor(hash(code + 1, slot + 5) * 3);

/**
 * A key and a pin lock. The password cuts the key's teeth, one per character, and the
 * retyped password sets the pins. Where they agree, a pin drops onto its tooth.
 */
export class KeyScene implements AsciiScene {
  size = { cols: COLS, rows: ROWS };
  fps = 30;
  dirty = false;

  private teeth = new Array<number>(SLOTS).fill(0);
  private teethNow = new Array<number>(SLOTS).fill(0);
  private pins = new Array<number>(SLOTS).fill(REST);
  private pinsNow = new Array<number>(SLOTS).fill(REST);
  private matched = new Array<boolean>(SLOTS).fill(false);
  private cut = 0;
  private strength = 0;
  private strengthNow = 0;
  private fits = false;
  private turn = 0;

  /** Call whenever either field changes. Strength is from 0 to 1. */
  update(password: string, confirm: string, strength: number) {
    this.cut = Math.min(password.length, SLOTS);
    this.strength = strength;
    for (let slot = 0; slot < SLOTS; slot++) {
      const code = password.charCodeAt(slot);
      const tooth = Number.isNaN(code) ? 0 : toothFor(code, slot);
      this.teeth[slot] = tooth;
      const typed = slot < confirm.length;
      const matches = typed && confirm[slot] === password[slot];
      this.matched[slot] = matches;
      const seat = BLADE_TOP - tooth - 1;
      // A wrong character jams its pin partway down, short of the tooth.
      this.pins[slot] = matches ? seat : typed ? seat - 2 : REST;
    }
    this.fits = password.length > 0 && password === confirm;
    this.dirty = true;
  }

  draw(grid: AsciiGrid, { dt, reduced }: AsciiFrame) {
    this.strengthNow = approach(this.strengthNow, this.strength, 5, dt, reduced);
    if (this.fits) this.turn += reduced ? 0 : dt * 9;

    grid.text(BLADE_LEFT - 2, HOUSING - 1, ".".padEnd(SLOTS * SLOT_WIDTH + 3, "-") + ".");
    grid.text(BLADE_LEFT - 2, HOUSING, `|${"=".repeat(SLOTS * SLOT_WIDTH + 2)}|`, this.fits ? Tone.accent : Tone.base);

    const fill = METAL[Math.min(METAL.length - 1, Math.round(this.strengthNow * (METAL.length - 1)))] ?? " ";
    const bladeRight = BLADE_LEFT + SLOTS * SLOT_WIDTH;

    for (let slot = 0; slot < SLOTS; slot++) {
      this.teethNow[slot] = approach(this.teethNow[slot] ?? 0, this.teeth[slot] ?? 0, 16, dt, reduced);
      this.pinsNow[slot] = approach(this.pinsNow[slot] ?? REST, this.pins[slot] ?? REST, 16, dt, reduced);
      const x = BLADE_LEFT + slot * SLOT_WIDTH;
      const matched = this.matched[slot] ?? false;
      const tooth = Math.round(this.teethNow[slot] ?? 0);
      const pin = Math.round(this.pinsNow[slot] ?? REST);

      // The pin hangs from the housing.
      for (let y = HOUSING + 1; y < pin; y++) grid.text(x, y, "||", matched ? Tone.base : Tone.muted);
      grid.text(x, pin, "\\/", matched ? Tone.accent : Tone.base);

      // The tooth stands on the blade: flat until a character has cut it.
      if (tooth > 0) {
        grid.text(x, BLADE_TOP - tooth, "/\\");
        for (let y = BLADE_TOP - tooth + 1; y < BLADE_TOP; y++) grid.text(x - 1, y, `/${fill}${fill}\\`);
      }
    }

    grid.text(BLADE_LEFT - 1, BLADE_TOP, "_".repeat(bladeRight - BLADE_LEFT + 1));
    for (let row = 1; row < BLADE_ROWS; row++) {
      grid.text(BLADE_LEFT - 1, BLADE_TOP + row, fill.repeat(bladeRight - BLADE_LEFT + 1));
    }
    grid.text(BLADE_LEFT - 1, BLADE_TOP + BLADE_ROWS, "-".repeat(bladeRight - BLADE_LEFT + 1));
    grid.text(bladeRight, BLADE_TOP, "\\", Tone.base);
    grid.text(bladeRight + 1, BLADE_TOP + 1, "\\", Tone.base);
    grid.text(bladeRight + 1, BLADE_TOP + 2, "/", Tone.base);
    grid.text(bladeRight, BLADE_TOP + 3, "/", Tone.base);

    BOW.forEach((line, row) => {
      grid.text(1, BLADE_TOP - 2 + row, line, Tone.base, true);
    });
    const spin = SPIN[Math.floor(this.turn) % SPIN.length] ?? "|";
    grid.text(7, BLADE_TOP + 1, ` ${this.fits ? spin : "o"} `, this.fits ? Tone.accent : Tone.base);

    const seated = this.matched.filter(Boolean).length;
    grid.text(BLADE_LEFT, ROWS - 1, `teeth cut ${this.cut}/${SLOTS}`, Tone.muted);
    const label = this.fits ? "key fits" : `pins set ${seated}/${Math.max(this.cut, 1)}`;
    grid.text(COLS - label.length - 3, ROWS - 1, label, this.fits ? Tone.accent : Tone.muted);

  }
}
