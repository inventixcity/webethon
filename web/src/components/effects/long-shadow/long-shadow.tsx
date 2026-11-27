"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { createMotionClock, observeTheme } from "../invert-lens/motion-clock";

export interface LongShadowProps {
  /** Short display text, fitted automatically to the canvas. */
  text?: string;
  /** Orbit duration in seconds. */
  period?: number;
  /** Maximum shadow length as a fraction of the component's smaller dimension. */
  length?: number;
  /** CSS tokens for the printed letter face and its flat shadow. */
  faceToken?: string;
  shadowToken?: string;
  className?: string;
}

const vertex = `attribute vec2 a_position;
varying vec2 v_uv;
void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`;
const fragment = `precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform sampler2D u_face;
uniform vec2 u_step;
uniform vec3 u_ink;
uniform vec3 u_shadow;
uniform float u_composite;
float sampleMask(vec2 uv){
  if(uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.)return 0.;
  return texture2D(u_source,uv).a;
}
// Repeated linear sampling softens the mask, so edges are snapped back to razor sharp.
float crisp(float a){return smoothstep(.46,.54,a);}
void main(){
  float mask=max(sampleMask(v_uv),sampleMask(v_uv-u_step));
  if(u_composite<.5){gl_FragColor=vec4(0.,0.,0.,mask);return;}
  float shadow=crisp(mask);
  float face=crisp(texture2D(u_face,v_uv).a);
  float alpha=face+shadow*(1.-face);
  vec3 rgb=(u_ink*face+u_shadow*shadow*(1.-face))/max(alpha,.001);
  gl_FragColor=vec4(rgb,alpha);
}`;

export function LongShadow({ text = "NOW.", period = 24, length = 0.31, faceToken = "--ink", shadowToken = "--vermilion", className }: LongShadowProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fallback = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = host.current, surface = canvas.current;
    if (!element || !surface) return;
    const gl = surface.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) return;
    let disposed = false, ready = false, width = 1, height = 1, ratio = 1;
    let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null;
    let textures: WebGLTexture[] = [], targets: WebGLFramebuffer[] = [], shaders: WebGLShader[] = [];
    let ink = [0, 0, 0], shadow = [0, 0, 0];
    const mask = document.createElement("canvas");
    const pen = mask.getContext("2d", { willReadFrequently: true });
    if (!pen) return;
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    const release = () => {
      textures.forEach((texture) => gl.deleteTexture(texture)); targets.forEach((target) => gl.deleteFramebuffer(target));
      shaders.forEach((shader) => gl.deleteShader(shader));
      gl.deleteBuffer(buffer); gl.deleteProgram(program);
      textures = []; targets = []; shaders = []; ready = false;
    };
    const initialize = () => {
      program = gl.createProgram();
      if (!program) return;
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type);
        if (!shader) return;
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { release(); return; }
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { release(); return; }
      gl.useProgram(program);
      buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const attribute = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
      for (const name of ["source", "face", "step", "ink", "shadow", "composite"]) uniforms[name] = gl.getUniformLocation(program, `u_${name}`);
      gl.uniform1i(uniforms.source, 0); gl.uniform1i(uniforms.face, 1);
      for (let i = 0; i < 3; i++) {
        const texture = gl.createTexture(); if (!texture) { release(); return; }
        textures.push(texture); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (i) { const target = gl.createFramebuffer(); if (target) targets.push(target); }
      }
      ready = targets.length === 2;
    };
    const theme = () => {
      const style = getComputedStyle(element);
      const rgb = (token: string) => {
        pen.clearRect(0, 0, 1, 1); pen.fillStyle = style.getPropertyValue(token).trim(); pen.fillRect(0, 0, 1, 1);
        const pixel = pen.getImageData(0, 0, 1, 1).data;
        return [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255];
      };
      ink = rgb(faceToken); shadow = rgb(shadowToken);
    };
    const measure = () => {
      if (!ready || gl.isContextLost()) return;
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.round(element.clientWidth * ratio)); height = Math.max(1, Math.round(element.clientHeight * ratio));
      surface.width = width; surface.height = height; mask.width = width; mask.height = height;
      const family = getComputedStyle(element).getPropertyValue("--font-display").trim() || "sans-serif";
      pen.font = `700 100px ${family}`;
      const measured = pen.measureText(text).width;
      const size = Math.min(height * 0.5, width * 0.82 / Math.max(1, measured) * 100);
      pen.font = `700 ${size}px ${family}`; pen.textAlign = "center"; pen.textBaseline = "alphabetic";
      pen.fillStyle = getComputedStyle(element).getPropertyValue(faceToken).trim();
      // Only alpha is uploaded, so every displayed color still comes from a theme token.
      pen.fillText(text, width / 2, height * 0.48 + size * 0.32);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textures[0]); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      for (let i = 1; i < 3; i++) {
        gl.bindTexture(gl.TEXTURE_2D, textures[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets[i - 1]); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textures[i], 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) ready = false;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
    initialize(); theme(); measure();
    const clock = createMotionClock(element, ({ time }) => {
      if (!ready || gl.isContextLost()) return;
      const angle = time * Math.PI * 2 / Math.max(6, period) + 0.65;
      const distance = Math.max(0, Math.min(0.6, length)) * Math.min(width, height) * (0.65 + Math.sin(angle * 2) * 0.3);
      const dx = Math.cos(angle) / width, dy = -Math.sin(angle) / height;
      gl.useProgram(program); gl.viewport(0, 0, width, height);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, textures[0]);
      gl.activeTexture(gl.TEXTURE0); gl.uniform1f(uniforms.composite, 0);
      let input = 0, output = 1, accumulated = 0, step = 1;
      // Binary directional dilation: a continuous hard extrusion in log2(length)
      // full-screen passes, rather than hundreds of text draws or a long ray march.
      while (accumulated < distance) {
        const amount = Math.min(step, distance - accumulated);
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets[output - 1]); gl.bindTexture(gl.TEXTURE_2D, textures[input]);
        gl.uniform2f(uniforms.step, dx * amount, dy * amount); gl.drawArrays(gl.TRIANGLES, 0, 6);
        input = output; output = output === 1 ? 2 : 1; accumulated += amount; step *= 2;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindTexture(gl.TEXTURE_2D, textures[input]);
      gl.uniform2f(uniforms.step, 0, 0); gl.uniform1f(uniforms.composite, 1);
      gl.uniform3f(uniforms.ink, ink[0], ink[1], ink[2]); gl.uniform3f(uniforms.shadow, shadow[0], shadow[1], shadow[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      surface.style.opacity = "1";
      if (fallback.current) fallback.current.style.opacity = "0";
    });
    const resize = new ResizeObserver(() => { theme(); measure(); clock.redraw(); });
    resize.observe(element);
    const stopTheme = observeTheme(element, () => { theme(); measure(); clock.redraw(); });
    const lost = (event: Event) => { event.preventDefault(); ready = false; surface.style.opacity = "0"; if (fallback.current) fallback.current.style.opacity = "1"; };
    const restored = () => { release(); initialize(); theme(); measure(); clock.redraw(); };
    surface.addEventListener("webglcontextlost", lost); surface.addEventListener("webglcontextrestored", restored);
    void document.fonts.ready.then(() => { if (!disposed) { theme(); measure(); clock.redraw(); } });
    return () => {
      disposed = true; clock.dispose(); resize.disconnect(); stopTheme();
      surface.removeEventListener("webglcontextlost", lost); surface.removeEventListener("webglcontextrestored", restored);
      release(); mask.width = 0; mask.height = 0;
    };
  }, [text, period, length, faceToken, shadowToken]);

  return (
    <div ref={host} className={cn("relative h-[clamp(400px,46vw,680px)] w-full overflow-hidden bg-paper text-ink", className)}>
      <h2 className="absolute inset-0 flex items-center justify-center" aria-label={text}><span ref={fallback} aria-hidden="true" className="max-w-full break-words text-center text-[clamp(5rem,20vw,18rem)] font-bold leading-none tracking-[-0.03em]">{text}</span></h2>
      <canvas ref={canvas} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full opacity-0" />
    </div>
  );
}
