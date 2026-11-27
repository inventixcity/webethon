import type { ShaderScene } from "@/components/canvas/shader-canvas";

const PULSES = 5;

const FRAGMENT = `precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_paper, u_ink, u_a, u_b, u_c;
uniform float u_height, u_energy;
uniform vec3 u_pulses[${PULSES}];

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += noise(p) * a; p *= 2.03; a *= 0.5; }
  return v;
}

// One hanging curtain of light, with fine vertical rays through it.
float curtain(vec2 uv, float aspect, float seed, float floorLine) {
  float x = uv.x * aspect;
  float t = u_time;
  float wander = fbm(vec2(x * 0.8 + seed, t * 0.07 + seed)) - 0.5;
  float base = floorLine + wander * 0.34 + sin(x * 1.4 + seed * 3.0 + t * 0.09) * 0.05;
  float d = uv.y - base;
  if (d < 0.0) return smoothstep(-0.2, 0.0, d) * smoothstep(-0.2, 0.0, d) * 0.42;
  float rays = fbm(vec2(x * 16.0 + wander * 7.0, t * 0.22 + seed));
  float reach = 0.16 + u_height * 0.62;
  return exp(-d / reach * 2.6) * (0.3 + rays * 1.25);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  float dark = step(dot(u_paper, vec3(0.3, 0.6, 0.1)), 0.5);

  float boost = 1.0 + u_energy * 1.2;
  for (int i = 0; i < ${PULSES}; i++) {
    vec3 p = u_pulses[i];
    if (p.z < 0.0) continue;
    float front = uv.x - p.x;
    boost += exp(-front * front * 26.0) * exp(-p.z * 2.1) * 1.1;
  }
  boost = min(boost, 2.1);

  float a = curtain(uv, aspect, 1.3, 0.26) * boost;
  float b = curtain(uv, aspect, 4.1, 0.34) * boost;
  float c = curtain(uv, aspect, 7.7, 0.2) * boost;
  vec3 light = u_a * a + u_b * b * 0.8 + u_c * c * 0.55;

  vec3 sky = u_paper;
  if (dark > 0.5) {
    vec2 cell = floor(uv * vec2(aspect, 1.0) * 320.0);
    float star = step(0.9975, hash(cell)) * (0.45 + 0.55 * sin(u_time * 1.6 + hash(cell + 3.0) * 40.0));
    sky += vec3(star) * 0.75 * smoothstep(0.1, 0.5, uv.y);
    gl_FragColor = vec4(sky + light * 0.62, 1.0);
  } else {
    // On a pale sky, light can't add up, so the colour is laid in like a wash.
    float amount = clamp((a + b + c) * 0.4, 0.0, 0.9);
    vec3 wash = normalize(light + 0.001) * 0.88;
    gl_FragColor = vec4(mix(sky, wash, amount * 0.75), 1.0);
  }

  // The far ridge line, sitting on the horizon.
  float ridge = 0.05 + fbm(vec2(uv.x * aspect * 3.0, 2.0)) * 0.12;
  float land = smoothstep(ridge + 0.002, ridge - 0.002, uv.y);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(u_paper, u_ink, dark > 0.5 ? 0.1 : 0.72), land);
}`;

type Pulse = { x: number; born: number };

/** The northern lights. Keystrokes send pulses through them, and they can sink or climb the sky. */
export class Aurora implements ShaderScene {
  fragment = FRAGMENT;
  dirty = false;

  private target: number;
  private height: number;
  private energy = 0;
  private pulses: Pulse[] = [];
  private time = 0;

  constructor(height = 0.5) {
    this.target = height;
    this.height = height;
  }

  /** Sets how high the curtains climb, from 0 to 1. */
  rise(height: number) {
    this.target = height;
    this.dirty = true;
  }

  /** Sends a pulse of brightness through the sky, at a point from 0 to 1 across it. */
  pulse(x: number) {
    this.pulses.push({ x, born: this.time });
    if (this.pulses.length > PULSES) this.pulses.shift();
    this.energy = 1;
    this.dirty = true;
  }

  update({ time, dt, reduced }: { time: number; dt: number; reduced: boolean }) {
    this.time = time;
    this.height = reduced ? this.target : this.height + (this.target - this.height) * (1 - Math.exp(-3 * dt));
    this.energy = Math.max(0, this.energy - dt * 1.5);
    const pulses: number[] = [];
    for (let i = 0; i < PULSES; i++) {
      const pulse = this.pulses[i];
      if (pulse) pulses.push(pulse.x, 0, Math.max(0, time - pulse.born));
      else pulses.push(0, 0, -1);
    }
    return { u_height: this.height, u_energy: this.energy, u_pulses: pulses };
  }
}
