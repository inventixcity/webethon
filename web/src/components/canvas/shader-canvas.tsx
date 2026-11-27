"use client";

import { useEffect, useRef } from "react";
import { subscribeTheme } from "@/components/theme/theme";
import { cn } from "@/lib/utils";

export type ShaderValue = number | number[];

export type ShaderScene = {
  fragment: string;
  /** Set this when input changes the picture, so it redraws under reduced motion. */
  dirty?: boolean;
  /** Returns this frame's uniforms. Arrays of 2 or 3 numbers are vectors, and longer ones are vec3 lists. */
  update(frame: { time: number; dt: number; reduced: boolean; aspect: number }): Record<string, ShaderValue>;
  /** The pointer, from 0 to 1 across the canvas, with y running up. */
  pointer?(x: number, y: number): void;
};

const VERTEX = `attribute vec2 a_position;
void main(){gl_Position=vec4(a_position,0.,1.);}`;

function parseColor(value: string): number[] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [0, 0, 0];
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return Array.from(context.getImageData(0, 0, 1, 1).data)
    .slice(0, 3)
    .map((channel) => channel / 255);
}

/**
 * Runs a full-canvas fragment shader. It's given u_res, u_time and five palette colours: u_paper,
 * u_ink, u_a, u_b and u_c. Renders below full resolution, because these scenes are soft and it saves
 * the GPU. If WebGL isn't available the panel simply stays the page colour.
 */
export function ShaderCanvas({ scene, className }: { scene: ShaderScene; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!canvas || !gl) return;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl.FRAGMENT_SHADER, scene.fragment);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const locations = new Map<string, WebGLUniformLocation | null>();
    const locate = (name: string) => {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
      return locations.get(name) ?? null;
    };
    const setUniform = (name: string, value: ShaderValue) => {
      const location = locate(name);
      if (!location) return;
      if (typeof value === "number") gl.uniform1f(location, value);
      else if (value.length === 2) gl.uniform2fv(location, value);
      else gl.uniform3fv(location, value);
    };

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let visible = true;
    let time = 0;
    let last = performance.now();
    let width = 1;
    let height = 1;
    let forced = true;

    function readTheme() {
      if (!canvas) return;
      const style = getComputedStyle(canvas);
      const token = (name: string) => parseColor(style.getPropertyValue(name).trim());
      gl?.useProgram(program);
      setUniform("u_paper", token("--paper"));
      setUniform("u_ink", token("--ink"));
      setUniform("u_a", token("--scene-a"));
      setUniform("u_b", token("--scene-b"));
      setUniform("u_c", token("--scene-c"));
      forced = true;
    }

    function layout() {
      if (!canvas) return;
      const box = canvas.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return;
      const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.66;
      width = Math.round(box.width * scale);
      height = Math.round(box.height * scale);
      canvas.width = width;
      canvas.height = height;
      gl?.viewport(0, 0, width, height);
      forced = true;
    }

    function render(now: number) {
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      const reduced = motion.matches;
      if (!reduced) time += dt;
      if (gl && (!reduced || forced || scene.dirty)) {
        forced = false;
        scene.dirty = false;
        setUniform("u_res", [width, height]);
        setUniform("u_time", time);
        const uniforms = scene.update({ time, dt: reduced ? 0 : dt, reduced, aspect: width / height });
        for (const [name, value] of Object.entries(uniforms)) setUniform(name, value);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      raf = requestAnimationFrame(render);
    }

    function schedule() {
      cancelAnimationFrame(raf);
      if (!visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(render);
    }

    function onPointerMove(event: PointerEvent) {
      if (!canvas) return;
      const box = canvas.getBoundingClientRect();
      scene.pointer?.((event.clientX - box.left) / box.width, 1 - (event.clientY - box.top) / box.height);
    }

    const stopThemeWatch = subscribeTheme(readTheme);
    const resizeObserver = new ResizeObserver(layout);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      schedule();
    });

    readTheme();
    layout();
    resizeObserver.observe(canvas);
    intersectionObserver.observe(canvas);
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    schedule();

    return () => {
      cancelAnimationFrame(raf);
      stopThemeWatch();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("pointermove", onPointerMove);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteBuffer(buffer);
    };
  }, [scene]);

  return <canvas ref={canvasRef} aria-hidden="true" className={cn("block size-full", className)} />;
}
