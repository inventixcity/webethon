"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { animateSurface, fitType } from "./runtime";

export interface InkTideProps {
  /** Headline. Explicit newlines define the poster's line breaks. */
  headline?: string;
  /** Slow field speed multiplier; clamped to 0.1–3. */
  speed?: number;
  /** Section sizing and layout overrides. */
  className?: string;
}

const vertex = `attribute vec2 position; varying vec2 uv; void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
const fragment = `precision highp float;
varying vec2 uv;
uniform vec2 resolution;
uniform float time;
uniform vec3 paper, ink;
uniform sampler2D typeMask;
void main(){
  vec2 p=vec2(uv.x*resolution.x/resolution.y,1.-uv.y);
  float aspect=resolution.x/resolution.y;
  p+=.022*vec2(sin(p.y*8.+time*.19),sin(p.x*6.-time*.16));
  float field=0.;
  for(int i=0;i<7;i++){
    float n=float(i);
    vec2 center=vec2(aspect*(.5+.49*sin(time*.21+n*2.399)),.5+.56*cos(time*.17+n*1.73));
    float radius=(.165+.038*sin(time*.23+n*1.9))*sqrt(aspect);
    vec2 delta=p-center;
    field+=radius*radius/max(dot(delta,delta),.0001);
  }
  float edge=EDGE_WIDTH;
  float liquid=smoothstep(1.-edge,1.+edge,field);
  float letter=texture2D(typeMask,vec2(uv.x,1.-uv.y)).a;
  float dark=mix(liquid,1.-liquid,letter);
  gl_FragColor=vec4(mix(paper,ink,dark),1.);
}`;

/** An analytic GPU metaball surface and type mask share the exact same boundary. */
export function InkTide({ headline = "Nothing\nstays still.", speed = 1, className }: InkTideProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [contextVersion, setContextVersion] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    return animateSurface(ref.current, s => {
      const gl = s.canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
      if (!gl) return null;
      const derivatives = gl.getExtension("OES_standard_derivatives");
      const shaders: WebGLShader[] = [];
      const compile = (kind: number, source: string) => {
        const shader = gl.createShader(kind)!;
        gl.shaderSource(shader, source); gl.compileShader(shader); shaders.push(shader);
        return shader;
      };
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
      const fragmentSource = (derivatives ? "#extension GL_OES_standard_derivatives : enable\n" : "") + fragment.replace("EDGE_WIDTH", derivatives ? "max(.00001,.6*fwidth(field))" : "max(.001,1./resolution.y)");
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        shaders.forEach(shader => gl.deleteShader(shader)); gl.deleteProgram(program); return null;
      }
      gl.useProgram(program);
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const uniforms = Object.fromEntries(["resolution", "time", "paper", "ink", "typeMask"].map(key => [key, gl.getUniformLocation(program, key)]));
      gl.uniform1i(uniforms.typeMask, 0);
      const mask = document.createElement("canvas");
      const ctx = mask.getContext("2d")!;
      const swatch = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      const color = (value: string) => {
        swatch.clearRect(0, 0, 1, 1); swatch.fillStyle = value; swatch.fillRect(0, 0, 1, 1);
        return new Float32Array(Array.from(swatch.getImageData(0, 0, 1, 1).data).slice(0, 3).map(v => v / 255));
      };
      const lost = (event: Event) => { event.preventDefault(); s.canvas.style.opacity = "0"; };
      const restored = () => { setContextVersion(version => version + 1); };
      s.canvas.addEventListener("webglcontextlost", lost);
      s.canvas.addEventListener("webglcontextrestored", restored);
      return {
        resize() {
          gl.viewport(0, 0, s.canvas.width, s.canvas.height);
          mask.width = s.canvas.width; mask.height = s.canvas.height;
          ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
          const pad = Math.max(24, s.width * .055);
          const type = fitType(ctx, headline, s.width - pad * 2, s.height * .78, s.font, s.width * .18);
          ctx.textBaseline = "top"; ctx.fillStyle = s.colors.ink;
          const top = (s.height - type.lines.length * type.lineHeight) / 2;
          type.lines.forEach((line, i) => ctx.fillText(line, pad, top + i * type.lineHeight));
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
          gl.uniform2f(uniforms.resolution, s.canvas.width, s.canvas.height);
          gl.uniform3fv(uniforms.paper, color(s.colors.paper)); gl.uniform3fv(uniforms.ink, color(s.colors.ink));
        },
        draw() {
          if (gl.isContextLost()) return;
          gl.uniform1f(uniforms.time, 14 + (s.still ? 0 : s.time * Math.min(3, Math.max(.1, speed))));
          gl.drawArrays(gl.TRIANGLES, 0, 6); s.canvas.style.opacity = "1";
        },
        dispose() {
          s.canvas.removeEventListener("webglcontextlost", lost); s.canvas.removeEventListener("webglcontextrestored", restored);
          gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteProgram(program); shaders.forEach(shader => gl.deleteShader(shader));
        },
      };
    });
  }, [headline, speed, contextVersion]);
  return <section className={cn("relative isolate min-h-[520px] overflow-hidden bg-paper font-sans text-ink md:min-h-[680px]", className)}>
    <h2 className="absolute inset-0 flex items-center whitespace-pre-line px-[5.5%] text-[clamp(48px,13vw,220px)] leading-[.94] font-semibold tracking-[-0.03em]">{headline}</h2>
    <canvas ref={ref} aria-hidden="true" className="absolute inset-0 h-full w-full opacity-0" />
  </section>;
}
