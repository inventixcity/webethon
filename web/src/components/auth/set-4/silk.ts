import type { ShaderScene } from "@/components/canvas/shader-canvas";

const RIPPLES = 6;

const FRAGMENT = `precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_paper, u_a, u_b, u_c;
uniform vec2 u_cursor;
uniform float u_open, u_energy, u_full;
uniform vec3 u_ripples[${RIPPLES}];

// The cloth's height. Long vertical folds, so it hangs like a drape.
float height(vec2 p) {
  float t = u_time;
  float v = sin(p.x * 9.0 + sin(p.y * 1.7 + t * 0.3) * 1.4 + t * 0.25) * 0.55;
  v += sin(p.x * 17.0 + p.y * 2.0 + sin(p.y * 2.3 - t * 0.2) * 2.0 + 1.7) * 0.22;
  v += sin(p.y * 3.1 + p.x * 2.0 + t * 0.18) * 0.25;
  v += sin(p.x * 31.0 + p.y * 5.0 - t * 0.4) * 0.05 * (1.0 + u_energy * 2.5);
  float near = distance(p, u_cursor);
  v += exp(-near * near * 14.0) * 0.32;
  for (int i = 0; i < ${RIPPLES}; i++) {
    vec3 r = u_ripples[i];
    if (r.z < 0.0) continue;
    float d = distance(p, r.xy);
    v += sin(d * 11.0 - r.z * 6.0) * exp(-d * 2.4) * exp(-r.z * 1.5) * 0.3;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = vec2(uv.x * u_res.x / u_res.y, uv.y);
  float e = 0.0025;
  float h = height(p);
  vec3 normal = normalize(vec3(height(p + vec2(e, 0.0)) - h, height(p + vec2(0.0, e)) - h, e * 2.6));
  vec3 light = normalize(vec3(-0.45, 0.6, 0.66));
  float diffuse = max(dot(normal, light), 0.0);
  float sheen = pow(max(reflect(-light, normal).z, 0.0), 26.0);
  vec3 colour = mix(u_b, u_a, smoothstep(0.1, 0.95, diffuse));
  colour = mix(colour, u_c, sheen * 0.75);

  // Two drapes, parted around the middle of the page.
  float gap = u_open + sin(uv.y * 7.0 + u_time * 0.5) * 0.006;
  float edge = abs(uv.x - 0.5);
  float cloth = u_full > 0.5 ? 1.0 : smoothstep(gap - 0.002, gap + 0.002, edge);
  colour *= mix(1.0, 0.8, smoothstep(0.07, 0.0, edge - gap) * (1.0 - u_full));
  gl_FragColor = vec4(mix(u_paper, colour, cloth), 1.0);
}`;

type Ripple = { x: number; y: number; born: number };

/** Silk that hangs in folds. Typing ripples it, and it can part or close like a pair of drapes. */
export class Silk implements ShaderScene {
  fragment = FRAGMENT;
  dirty = false;

  /** When true the cloth fills the canvas instead of parting. */
  full: boolean;
  private open: number;
  private openNow: number;
  private energy = 0;
  private ripples: Ripple[] = [];
  private time = 0;
  private aspect = 1;
  private cursor = [-9, -9];

  constructor({ full = false, open = 0.25 }: { full?: boolean; open?: number } = {}) {
    this.full = full;
    this.open = open;
    this.openNow = full ? open : 0.1;
  }

  /** Sets how far the drapes stand from the centre, as a fraction of the width. */
  part(open: number) {
    this.open = open;
    this.dirty = true;
  }

  /** Sends a ripple through the cloth, from a point given from 0 to 1 across it. */
  touch(x: number, y: number) {
    this.ripples.push({ x: x * this.aspect, y, born: this.time });
    if (this.ripples.length > RIPPLES) this.ripples.shift();
    this.energy = 1;
    this.dirty = true;
  }

  pointer(x: number, y: number) {
    this.cursor = [x * this.aspect, y];
  }

  update({ time, dt, reduced, aspect }: { time: number; dt: number; reduced: boolean; aspect: number }) {
    this.time = time;
    this.aspect = aspect;
    this.openNow = reduced ? this.open : this.openNow + (this.open - this.openNow) * (1 - Math.exp(-5 * dt));
    this.energy = Math.max(0, this.energy - dt * 1.4);

    const ripples: number[] = [];
    for (let i = 0; i < RIPPLES; i++) {
      const ripple = this.ripples[i];
      if (ripple) ripples.push(ripple.x, ripple.y, Math.max(0, time - ripple.born));
      else ripples.push(0, 0, -1);
    }
    return {
      u_ripples: ripples,
      u_cursor: this.cursor,
      u_open: this.openNow,
      u_energy: this.energy,
      u_full: this.full ? 1 : 0,
    };
  }
}
