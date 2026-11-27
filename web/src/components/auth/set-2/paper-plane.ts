type Vec = [number, number, number];
type Facet = { points: Vec[]; lift: number };

// A sheet folded along real creases, nose at the top. Only the right half is modelled, and
// the left is its mirror image. Lengths are in half sheet widths, on an A-series sheet.
const HEIGHT = 2.83;
const FIRST_CREASE = HEIGHT - 1; // where the first fold meets the sheet's edge
const SECOND_CREASE = HEIGHT - 1 / Math.tan(Math.PI / 8); // and the second, halving that angle
const FLAP_TIP = HEIGHT - Math.SQRT2; // where the folded corner lands on the centre line
const WING_ROOT = 0.22; // how far along the tail the wing crease lands
const KEEL_ANGLE = 1.45;
const WING_ANGLE = 1.42;

const LIGHT: Vec = normalize([-0.42, 0.5, 0.76]);
const END_PITCH = -1.05;
const END_ROLL = -1.2;

/**
 * Typing alone gets this far, part way into the centre fold where the plane still reads
 * clearly. A valid address then finishes the fold and opens the wings.
 */
const FOLD_CHARS = 16;
const FOLDED = 0.6;

function normalize([x, y, z]: Vec): Vec {
  const size = Math.hypot(x, y, z) || 1;
  return [x / size, y / size, z / size];
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rotates a point about the line through `origin` in unit direction `axis`. */
function hinge(point: Vec, origin: Vec, axis: Vec, angle: number): Vec {
  const p = sub(point, origin);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const across = cross(axis, p);
  const along = dot(axis, p) * (1 - cos);
  return [
    origin[0] + p[0] * cos + across[0] * sin + axis[0] * along,
    origin[1] + p[1] * cos + across[1] * sin + axis[1] * along,
    origin[2] + p[2] * cos + across[2] * sin + axis[2] * along,
  ];
}

const NOSE: Vec = [0, HEIGHT, 0];
const CREASE_ONE = normalize([1, FIRST_CREASE - HEIGHT, 0]);
const CREASE_TWO = normalize([1, SECOND_CREASE - HEIGHT, 0]);
const CREASE_WING = normalize([WING_ROOT, -HEIGHT, 0]);

const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** The sheet at a fold progress from 0 (flat) to 1 (a finished plane). */
function foldedFacets(progress: number): Facet[] {
  const first = ease(progress / 0.25);
  const second = ease((progress - 0.25) / 0.25);
  const keel = ease((progress - 0.5) / 0.25);
  const wing = ease((progress - 0.75) / 0.25);

  const body = (point: Vec): Vec => {
    const angle = keel * KEEL_ANGLE;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [point[0] * cos - point[2] * sin, point[1], point[0] * sin + point[2] * cos];
  };
  const folded = (point: Vec) => hinge(point, NOSE, CREASE_TWO, Math.PI * second);
  const wingPoint = (point: Vec) => body(hinge(point, NOSE, CREASE_WING, -wing * WING_ANGLE));

  const facets: Facet[] = [];
  if (keel > 0) {
    // Once folded flat the layers sit exactly on the sheet, so one shape stands in for them.
    facets.push({
      points: ([[0, 0, 0], [WING_ROOT, 0, 0], NOSE] as Vec[]).map(body),
      lift: 0,
    });
    facets.push({
      points: ([[WING_ROOT, 0, 0], [1, 0, 0], [1, SECOND_CREASE, 0], NOSE] as Vec[]).map(wingPoint),
      lift: 0.01,
    });
    return facets;
  }

  facets.push({ points: [[0, 0, 0], [1, 0, 0], [1, SECOND_CREASE, 0], NOSE], lift: 0 });
  facets.push({
    points: ([NOSE, [1, SECOND_CREASE, 0], [1, FIRST_CREASE, 0]] as Vec[]).map(folded),
    lift: 0.02,
  });
  const corner = (point: Vec) => folded(hinge(point, NOSE, CREASE_ONE, Math.PI * first));
  facets.push({ points: ([NOSE, [1, FIRST_CREASE, 0], [1, HEIGHT, 0]] as Vec[]).map(corner), lift: 0.04 });
  return facets;
}

type Colours = { paper: string; shade: string; shadow: string; ink: string; trail: string };

type DrawOptions = { width: number; height: number; time: number; dt: number; reduced: boolean };

const LAUNCH_SECONDS = 1.5;
const TRAIL_LENGTH = 70;

/** The paper plane's state. The form calls these methods, and the canvas draws it. */
export class PaperPlane {
  dirty = true;

  private target = 0;
  private fold = 0;
  private velocity = 0;
  private kick = 0;
  private shake = 0;
  private launch = 0;
  private sent = false;
  private flight = 0;
  private trail: [number, number][] = [];
  private pointerX = 0;
  private pointerY = 0;

  /** Each character adds a crease. Only a valid address finishes the wings. */
  typed(length: number, valid: boolean) {
    this.target = valid ? 1 : Math.min(FOLDED, (length / FOLD_CHARS) * FOLDED);
    this.kick = 1;
    this.dirty = true;
  }

  setSent(sent: boolean) {
    this.sent = sent;
    if (sent) {
      this.flight = 0;
      this.trail = [];
    }
    this.dirty = true;
  }

  rejected() {
    this.shake = 1;
    this.dirty = true;
  }

  point(x: number, y: number) {
    this.pointerX = x;
    this.pointerY = y;
  }

  draw(ctx: CanvasRenderingContext2D, colours: Colours, { width, height, time, dt, reduced }: DrawOptions) {
    if (reduced) {
      this.fold = this.target;
      this.launch = this.sent ? 1 : 0;
      this.kick = 0;
      this.shake = 0;
    } else {
      // A spring, so a fold overshoots a little and settles the way paper does.
      this.velocity += (this.target - this.fold) * 60 * dt;
      this.velocity *= Math.exp(-11 * dt);
      this.fold = Math.min(1, Math.max(0, this.fold + this.velocity * dt));
      this.kick = Math.max(0, this.kick - dt * 3.5);
      this.shake = Math.max(0, this.shake - dt * 2.2);
      this.launch = Math.min(1, Math.max(0, this.launch + (this.sent ? dt : -dt * 2) / LAUNCH_SECONDS));
      if (this.sent) this.flight += dt;
    }

    const size = Math.min(width, height) / (HEIGHT * 1.14);
    const shaped = ease(this.fold / 0.9);
    const launched = ease(this.launch);

    let pitch = END_PITCH * shaped;
    let roll = END_ROLL * shaped;
    if (!reduced) {
      pitch += Math.sin(time * 0.7) * 0.05 + this.pointerY * 0.16;
      roll += Math.sin(time * 0.5) * 0.04 - this.pointerX * 0.16 + Math.sin(time * 30) * this.kick * 0.03;
    }

    let centreX = width / 2 + Math.sin(time * 26) * this.shake * 16;
    let centreY = height / 2 + (reduced ? 0 : Math.sin(time * 0.9) * height * 0.012);
    let scale = size * (1 + this.kick * 0.03);

    if (launched > 0) {
      // A figure of eight, with the nose along the path.
      const t = this.flight * 0.75 + 0.6;
      const pathX = width / 2 + Math.sin(t) * width * 0.34;
      const pathY = height / 2 + Math.sin(t * 2) * height * 0.24;
      const headingX = Math.cos(t);
      const headingY = Math.cos(t * 2) * 2 * (height * 0.24) / (width * 0.34);
      centreX += (pathX - centreX) * launched;
      centreY += (pathY - centreY) * launched;
      scale *= 1 - launched * 0.62;
      roll += (Math.atan2(-headingX, headingY) - roll) * launched;

      if (!reduced) {
        this.trail.push([centreX, centreY]);
        if (this.trail.length > TRAIL_LENGTH) this.trail.shift();
      }
    } else if (this.trail.length > 0) {
      this.trail = [];
    }

    ctx.fillStyle = colours.trail;
    this.trail.forEach(([x, y], index) => {
      if (index % 3 === 0) ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    });

    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const cosRoll = Math.cos(roll);
    const sinRoll = Math.sin(roll);

    const view = ([x, y, z]: Vec, mirror: boolean): Vec => {
      const px = mirror ? -x : x;
      const py = y - HEIGHT * 0.5;
      const ry = py * cosPitch - z * sinPitch;
      const rz = py * sinPitch + z * cosPitch;
      return [px * cosRoll - ry * sinRoll, px * sinRoll + ry * cosRoll, rz];
    };

    const shapes = foldedFacets(this.fold)
      .flatMap((facet) =>
        [false, true].map((mirror) => {
          const points = facet.points.map((point) => view(point, mirror));
          const depth = points.reduce((sum, point) => sum + point[2], 0) / points.length + facet.lift;
          return { points, depth };
        }),
      )
      .sort((a, b) => a.depth - b.depth);

    ctx.lineJoin = "miter";
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colours.ink;
    for (const { points } of shapes) {
      const [a, b, c] = points;
      if (!a || !b || !c) continue;
      const normal = normalize(cross(sub(b, a), sub(c, a)));
      const light = Math.abs(dot(normal, LIGHT));
      // Three flat tones, like a print, rather than a smooth gradient.
      ctx.fillStyle = light > 0.72 ? colours.paper : light > 0.42 ? colours.shade : colours.shadow;
      ctx.beginPath();
      points.forEach(([x, y], index) => {
        const sx = centreX + x * scale;
        const sy = centreY - y * scale;
        if (index === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // The crease of the flap, which stays visible once the layers are one shape.
    if (this.fold > 0.5) {
      const reach = FLAP_TIP / HEIGHT;
      for (const mirror of [false, true]) {
        const wingBend = ease((this.fold - 0.75) / 0.25);
        const body = (point: Vec): Vec => {
          const angle = ease((this.fold - 0.5) / 0.25) * KEEL_ANGLE;
          const hinged = hinge(point, NOSE, CREASE_WING, -wingBend * WING_ANGLE);
          return [
            hinged[0] * Math.cos(angle) - hinged[2] * Math.sin(angle),
            hinged[1],
            hinged[0] * Math.sin(angle) + hinged[2] * Math.cos(angle),
          ];
        };
        const from = view(body([1, SECOND_CREASE, 0]), mirror);
        const to = view(body([WING_ROOT * (1 - reach), FLAP_TIP, 0]), mirror);
        ctx.beginPath();
        ctx.moveTo(centreX + from[0] * scale, centreY - from[1] * scale);
        ctx.lineTo(centreX + to[0] * scale, centreY - to[1] * scale);
        ctx.stroke();
      }
    }
  }
}
