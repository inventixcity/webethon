import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";

export type PondMood = "idle" | "watching" | "hiding" | "peeking" | "happy" | "startled";

const SEGMENTS = 11;

type Koi = { points: [number, number][]; angle: number; turn: number; size: number; gold: boolean; speed: number };
type Ripple = { x: number; y: number; age: number; strength: number };

/** Paints the water every other scene in this set shares: a soft wash and drifting caustic lines. */
export function paintWater(ctx: CanvasRenderingContext2D, { width, height, time, colors }: LiveFrame) {
  const wash = ctx.createLinearGradient(0, 0, width, height);
  wash.addColorStop(0, colors.sceneA);
  wash.addColorStop(1, colors.sceneB);
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = colors.sceneC;
  ctx.globalAlpha = 0.14;
  ctx.lineWidth = 1;
  for (let line = 0; line < 14; line++) {
    const y = ((line + 0.5) / 14) * height;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 24) {
      const wave = Math.sin(x * 0.006 + line * 1.7 + time * 0.25) * 12 + Math.sin(x * 0.013 - time * 0.18 + line) * 5;
      if (x === 0) ctx.moveTo(x, y + wave);
      else ctx.lineTo(x, y + wave);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function paintRipples(ctx: CanvasRenderingContext2D, ripples: Ripple[], colors: LiveFrame["colors"]) {
  ctx.strokeStyle = colors.sceneC;
  for (const ripple of ripples) {
    for (let ring = 0; ring < 3; ring++) {
      const age = ripple.age - ring * 0.22;
      if (age <= 0) continue;
      ctx.globalAlpha = Math.max(0, (1 - age / 2.4) * 0.6 * ripple.strength);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(ripple.x, ripple.y, age * 74, age * 46, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** A pond of koi. Fish follow the pointer or the form, and the pond goes quiet for a password. */
export class PondScene implements LiveScene {
  dirty = false;

  private koi: Koi[] = [];
  private ripples: Ripple[] = [];
  private mood: PondMood = "idle";
  private pointerX = -1;
  private pointerY = -1;
  private pointerAge = 99;
  private width = 0;
  private height = 0;
  private fade = 1;
  private gaze = 0.5;

  private spawn(width: number, height: number) {
    this.koi = Array.from({ length: 7 }, (_, index) => {
      const x = width * (0.1 + (index * 0.13) % 0.5);
      const y = height * (0.2 + ((index * 0.37) % 0.6));
      const size = 9 + (index % 3) * 2.5;
      return {
        // Laid out straight, so the fish doesn't start crumpled into a point.
        points: Array.from({ length: SEGMENTS }, (_, segment): [number, number] => [x - segment * size * 1.5, y]),
        angle: 0,
        turn: 0,
        size,
        gold: index % 3 !== 1,
        speed: 42 + index * 4,
      };
    });
  }

  setMood(mood: PondMood) {
    this.mood = mood;
    if (mood === "startled") this.addRipple(this.width * 0.34, this.height * 0.5, 1.4);
    this.dirty = true;
  }

  /** A keystroke: one drop on the water, somewhere along the form's edge. */
  typed(position: number) {
    this.gaze = position;
    this.addRipple(this.width * (0.2 + Math.random() * 0.42), this.height * (0.2 + Math.random() * 0.6), 1);
  }

  private addRipple(x: number, y: number, strength: number) {
    this.ripples.push({ x, y, age: 0, strength });
    if (this.ripples.length > 14) this.ripples.shift();
    this.dirty = true;
  }

  pointer(x: number, y: number) {
    this.pointerX = x;
    this.pointerY = y;
    this.pointerAge = 0;
  }

  private targetFor(index: number, time: number): [number, number] {
    const { width, height, mood } = this;
    // The form takes the right of the page, so fish stay in the open water to its left.
    const reach = width > 1024 ? 0.62 : 1;
    if (mood === "hiding") return [width * 0.12 + index * 14, height * 0.86];
    if (mood === "peeking") return index === 0 ? [width * 0.58 * reach, height * 0.5] : [width * 0.12, height * 0.86];
    if (mood === "watching") return [width * reach * (0.5 + this.gaze * 0.5), height * (0.3 + (index % 5) * 0.1)];
    if (mood === "happy") {
      const angle = time * 1.1 + (index / 7) * Math.PI * 2;
      return [width * reach * 0.5 + Math.cos(angle) * width * 0.16, height * 0.5 + Math.sin(angle) * height * 0.26];
    }
    if (this.pointerAge < 2.5 && this.pointerX >= 0 && this.pointerX < width * reach) {
      return [this.pointerX + Math.cos(index) * 40, this.pointerY + Math.sin(index) * 40];
    }
    const drift = time * 0.13 + index * 0.9;
    return [
      width * reach * (0.5 + Math.sin(drift) * 0.4),
      height * (0.5 + Math.sin(drift * 1.3 + index) * 0.36),
    ];
  }

  private drawKoi(ctx: CanvasRenderingContext2D, fish: Koi, frame: LiveFrame) {
    const { colors } = frame;
    const body = fish.gold ? colors.accent : colors.ink;
    const marks = fish.gold ? colors.ink : colors.accent;
    const left: [number, number][] = [];
    const right: [number, number][] = [];
    fish.points.forEach((point, index) => {
      const next = fish.points[Math.min(index + 1, SEGMENTS - 1)] ?? point;
      const previous = fish.points[Math.max(index - 1, 0)] ?? point;
      const angle = Math.atan2(previous[1] - next[1], previous[0] - next[0]);
      const t = index / (SEGMENTS - 1);
      // Widest at the shoulder, then a long taper into the tail.
      const half = fish.size * (t < 0.22 ? Math.sin((t / 0.22) * 1.57) : Math.cos(((t - 0.22) / 0.78) * 1.57) ** 1.1);
      left.push([point[0] + Math.cos(angle + 1.57) * half, point[1] + Math.sin(angle + 1.57) * half]);
      right.push([point[0] - Math.cos(angle + 1.57) * half, point[1] - Math.sin(angle + 1.57) * half]);
    });

    const head = fish.points[0] ?? [0, 0];
    const tail = fish.points[SEGMENTS - 1] ?? head;
    const beforeTail = fish.points[SEGMENTS - 3] ?? tail;
    const tailAngle = Math.atan2(tail[1] - beforeTail[1], tail[0] - beforeTail[0]);

    ctx.fillStyle = body;

    // A long, forked tail that trails behind the turn.
    for (const side of [-1, 1]) {
      const spread = tailAngle + side * 0.42;
      const tipX = tail[0] + Math.cos(spread) * fish.size * 2.3;
      const tipY = tail[1] + Math.sin(spread) * fish.size * 2.3;
      ctx.beginPath();
      ctx.moveTo(beforeTail[0], beforeTail[1]);
      ctx.quadraticCurveTo(tail[0] + Math.cos(tailAngle + side * 1.2) * fish.size, tail[1] + Math.sin(tailAngle + side * 1.2) * fish.size, tipX, tipY);
      ctx.quadraticCurveTo(tail[0], tail[1], beforeTail[0], beforeTail[1]);
      ctx.fill();
    }

    // Side fins, swept back from the shoulder.
    const shoulderL = left[2] ?? head;
    const shoulderR = right[2] ?? head;
    for (const [point, side] of [
      [shoulderL, 1],
      [shoulderR, -1],
    ] as const) {
      const angle = fish.angle + Math.PI - side * 0.8;
      ctx.beginPath();
      ctx.moveTo(point[0], point[1]);
      ctx.quadraticCurveTo(
        point[0] + Math.cos(angle + side * 1.3) * fish.size * 1.2,
        point[1] + Math.sin(angle + side * 1.3) * fish.size * 1.2,
        point[0] + Math.cos(angle) * fish.size * 1.5,
        point[1] + Math.sin(angle) * fish.size * 1.5,
      );
      ctx.closePath();
      ctx.fill();
    }

    // The body, smoothed through its outline points.
    const outline = [head, ...left, tail, ...[...right].reverse(), head];
    ctx.beginPath();
    ctx.moveTo(head[0], head[1]);
    for (let i = 1; i < outline.length - 1; i++) {
      const point = outline[i];
      const after = outline[i + 1];
      if (!point || !after) continue;
      ctx.quadraticCurveTo(point[0], point[1], (point[0] + after[0]) / 2, (point[1] + after[1]) / 2);
    }
    ctx.closePath();
    ctx.fill();

    // Markings along the back.
    ctx.fillStyle = marks;
    fish.points.slice(2, 8).forEach((point, index) => {
      if ((index + (fish.gold ? 0 : 1)) % 3 === 2) return;
      const spot = fish.size * (0.34 - index * 0.025);
      ctx.beginPath();
      ctx.ellipse(point[0], point[1], spot * 1.5, spot, fish.angle, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  draw(ctx: CanvasRenderingContext2D, frame: LiveFrame) {
    const { width, height, time, dt, reduced, colors } = frame;
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.spawn(width, height);
    }
    this.pointerAge += dt;

    paintWater(ctx, frame);

    const hidden = this.mood === "hiding";
    this.fade += ((hidden ? 0.28 : 1) - this.fade) * (reduced ? 1 : 1 - Math.exp(-3 * dt));
    const pace = this.mood === "startled" ? 3 : hidden ? 0.7 : this.mood === "watching" ? 1.6 : 1;

    ctx.globalAlpha = this.fade;
    this.koi.forEach((fish, index) => {
      const [targetX, targetY] = this.targetFor(index, time);
      const head = fish.points[0] ?? [0, 0];
      const desired = Math.atan2(targetY - head[1], targetX - head[0]);
      const wrapped = Math.atan2(Math.sin(desired - fish.angle), Math.cos(desired - fish.angle));
      // Reduced motion holds the koi still, so they keep their place in the water and don't swim after the pointer.
      const still = reduced ? 0 : 1;
      fish.turn += (wrapped - fish.turn) * Math.min(1, dt * 3) * still;
      fish.angle += (fish.turn * dt * 2.4 + Math.sin(time * 5 + index) * 0.012 * pace) * still;
      const distance = Math.hypot(targetX - head[0], targetY - head[1]);
      const speed = fish.speed * pace * Math.min(1, distance / 90 + 0.3) * still;
      head[0] += Math.cos(fish.angle) * speed * dt;
      head[1] += Math.sin(fish.angle) * speed * dt;

      const gap = fish.size * 1.5;
      for (let i = 1; i < SEGMENTS; i++) {
        const point = fish.points[i];
        const lead = fish.points[i - 1];
        if (!point || !lead) continue;
        const angle = Math.atan2(point[1] - lead[1], point[0] - lead[0]);
        point[0] = lead[0] + Math.cos(angle) * gap;
        point[1] = lead[1] + Math.sin(angle) * gap;
      }
      this.drawKoi(ctx, fish, frame);
    });
    ctx.globalAlpha = 1;

    for (const ripple of this.ripples) ripple.age += dt;
    this.ripples = this.ripples.filter((ripple) => ripple.age < 2.8);
    // Ripples are a short motion of their own, so reduced motion paints none.
    paintRipples(ctx, reduced ? [] : this.ripples, colors);

    // Lily pads float over the fish, so koi really do pass beneath them.
    ctx.fillStyle = colors.sceneC;
    ctx.globalAlpha = 0.72;
    const pads = [
      [0.14, 0.82, 62],
      [0.07, 0.62, 38],
      [0.24, 0.92, 46],
      [0.42, 0.16, 52],
      [0.54, 0.26, 30],
      [0.3, 0.1, 26],
    ] as const;
    pads.forEach(([u, v, size], index) => {
      const x = width * u + (reduced ? 0 : Math.sin(time * 0.3 + index) * 5);
      const y = height * v + (reduced ? 0 : Math.cos(time * 0.26 + index) * 4);
      const notch = index * 1.3 + time * 0.03;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.ellipse(x, y, size, size * 0.72, 0, notch + 0.22, notch + Math.PI * 2 - 0.22);
      ctx.closePath();
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }
}
