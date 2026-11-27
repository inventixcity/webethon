import type { Surface } from "../ink-tide/runtime";

const vertex = `precision highp float;
attribute vec3 dot;
uniform vec2 resolution;
uniform float time, cell, dpr;
uniform vec3 rings[6];
varying float edge;
void main(){
  float radial=length((dot.xy-resolution*vec2(.6,.4))*vec2(.8,1.));
  float wave=.5+.5*sin(dot.x*.009+dot.y*.012-time*.48+sin(radial*.013-time*.31)*1.8);
  float ripple=0.;
  for(int i=0;i<6;i++){
    float age=rings[i].z;
    float envelope=(length(dot.xy-rings[i].xy)-age*150.)/38.;
    ripple+=exp(-envelope*envelope)*exp(-age*.9)*.36;
  }
  float coverage=min(.96,.012+wave*.09+dot.z*(.53+wave*.31)+ripple);
  edge=sqrt(coverage)*.5;
  gl_PointSize=cell*dpr;
  gl_Position=vec4(dot.x/resolution.x*2.-1.,1.-dot.y/resolution.y*2.,0.,1.);
}`;
const fragment = `precision highp float;
uniform vec3 ink;
uniform float cell,dpr;
varying float edge;
void main(){
  float distance=max(abs(gl_PointCoord.x-.5),abs(gl_PointCoord.y-.5));
  float aa=.5/(cell*dpr);
  float alpha=1.-smoothstep(edge-aa,edge+aa,distance);
  gl_FragColor=vec4(ink,alpha);
}`;

/** One GPU point per print dot. Wave and ripple calculations run in the vertex shader. */
export function createDotRenderer(s: Surface) {
  const gl = s.canvas.getContext("webgl", { alpha: false, antialias: false, depth: false });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source); gl.compileShader(shader); shaders.push(shader); return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    shaders.forEach(shader => gl.deleteShader(shader)); gl.deleteProgram(program); return null;
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const attribute = gl.getAttribLocation(program, "dot");
  gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const uniforms = Object.fromEntries(["resolution", "time", "cell", "dpr", "rings[0]", "ink"].map(key => [key, gl.getUniformLocation(program, key)]));
  const swatch = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const rgb = (value: string) => {
    swatch.fillStyle = value; swatch.fillRect(0, 0, 1, 1);
    return Array.from(swatch.getImageData(0, 0, 1, 1).data).slice(0, 3).map(v => v / 255);
  };
  const rings = new Float32Array(18);
  let count = 0;
  return {
    upload(values: Float32Array, cols: number, cell: number) {
      count = values.length;
      const dots = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        dots[i * 3] = (i % cols + .5) * cell;
        dots[i * 3 + 1] = (Math.floor(i / cols) + .5) * cell;
        dots[i * 3 + 2] = values[i];
      }
      gl.bufferData(gl.ARRAY_BUFFER, dots, gl.STATIC_DRAW);
      gl.viewport(0, 0, s.canvas.width, s.canvas.height);
      gl.uniform2f(uniforms.resolution, s.width, s.height);
      gl.uniform1f(uniforms.cell, cell); gl.uniform1f(uniforms.dpr, s.dpr);
      gl.uniform3fv(uniforms.ink, rgb(s.colors.ink));
      const paper = rgb(s.colors.paper); gl.clearColor(paper[0], paper[1], paper[2], 1);
    },
    draw(ripples: { x: number; y: number; time: number }[]) {
      if (gl.isContextLost()) return;
      for (let i = 0; i < 6; i++) {
        const ripple = s.still ? undefined : ripples[i];
        rings[i * 3] = ripple?.x ?? -10000; rings[i * 3 + 1] = ripple?.y ?? -10000;
        rings[i * 3 + 2] = ripple ? s.time - ripple.time : 100;
      }
      gl.uniform3fv(uniforms["rings[0]"], rings);
      gl.uniform1f(uniforms.time, s.still ? 8 : s.time + 8);
      gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, count);
    },
    dispose() { gl.deleteBuffer(buffer); gl.deleteProgram(program); shaders.forEach(shader => gl.deleteShader(shader)); },
  };
}
