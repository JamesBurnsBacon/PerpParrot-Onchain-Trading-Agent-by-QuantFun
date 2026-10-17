import type { ParrotMorph } from "./parrot-morph";
export type PointFrame = {
  phase: number;
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
  camera: number;
};
export type PointRenderer = {
  kind: "WebGL" | "Canvas";
  draw: (engine: ParrotMorph, frame: PointFrame) => void;
  dispose: () => void;
};
export function createPointRenderer(
  canvas: HTMLCanvasElement,
  fallback: HTMLCanvasElement,
): PointRenderer {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    powerPreference: "low-power",
  });
  if (gl) {
    const shaders: WebGLShader[] = [];
    const compile = (type: number, code: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("No shader");
      shaders.push(shader);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Shader compilation failed");
      return shader;
    };
    let program: WebGLProgram | null = null,
      position: WebGLBuffer | null = null,
      color: WebGLBuffer | null = null;
    try {
      program = gl.createProgram();
      if (!program) throw new Error("No program");
      gl.attachShader(
        program,
        compile(
          gl.VERTEX_SHADER,
          `attribute vec3 a_position;attribute vec3 a_color;uniform vec4 u_scene;uniform vec3 u_pointer;varying vec3 v_color;void main(){float a=sin(u_scene.x*.12)*.18+u_pointer.x*.17+(u_scene.w-.5)*.35;float c=cos(a),s=sin(a);vec3 p=vec3(a_position.x*c+a_position.z*s,a_position.y,-a_position.x*s+a_position.z*c);p.y+=sin(u_scene.x*1.5+a_position.x*1.1)*.025;float tilt=u_pointer.y*.1;p.y=p.y*cos(tilt)-p.z*sin(tilt);float depth=1.0/(1.0+p.z*.18);float scale=min(1.0,u_scene.y)*(.62+u_scene.w*.16);gl_Position=vec4(p.x/u_scene.y*scale*depth,p.y*scale*depth,0.0,1.0);gl_PointSize=(3.2+depth*1.5)*u_scene.z;v_color=a_color;}`,
        ),
      );
      gl.attachShader(
        program,
        compile(
          gl.FRAGMENT_SHADER,
          `precision mediump float;varying vec3 v_color;void main(){vec2 p=gl_PointCoord*2.0-1.0;float r=dot(p,p);if(r>1.0)discard;gl_FragColor=vec4(v_color,exp(-r*2.3)*.92);}`,
        ),
      );
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error("Program link failed");
      position = gl.createBuffer();
      color = gl.createBuffer();
      if (!position || !color) throw new Error("No buffer");
      const posAttr = gl.getAttribLocation(program, "a_position"),
        colorAttr = gl.getAttribLocation(program, "a_color"),
        scene = gl.getUniformLocation(program, "u_scene"),
        pointer = gl.getUniformLocation(program, "u_pointer");
      let colorVersion = -1,
        allocated = 0;
      canvas.hidden = false;
      fallback.hidden = true;
      return {
        kind: "WebGL",
        draw(engine, frame) {
          gl.viewport(0, 0, frame.width, frame.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.useProgram(program);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
          gl.bindBuffer(gl.ARRAY_BUFFER, position);
          if (allocated !== engine.positions.length) {
            gl.bufferData(gl.ARRAY_BUFFER, engine.positions, gl.DYNAMIC_DRAW);
            allocated = engine.positions.length;
          } else gl.bufferSubData(gl.ARRAY_BUFFER, 0, engine.positions);
          gl.enableVertexAttribArray(posAttr);
          gl.vertexAttribPointer(posAttr, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, color);
          if (colorVersion !== engine.colorVersion) {
            gl.bufferData(gl.ARRAY_BUFFER, engine.colors, gl.STATIC_DRAW);
            colorVersion = engine.colorVersion;
          }
          gl.enableVertexAttribArray(colorAttr);
          gl.vertexAttribPointer(colorAttr, 3, gl.FLOAT, false, 0, 0);
          gl.uniform4f(
            scene,
            frame.phase,
            frame.width / frame.height,
            frame.dpr,
            frame.camera,
          );
          gl.uniform3f(pointer, frame.x, frame.y, 0);
          gl.drawArrays(gl.POINTS, 0, engine.count);
        },
        dispose() {
          gl.deleteBuffer(position);
          gl.deleteBuffer(color);
          gl.deleteProgram(program);
          shaders.forEach((s) => gl.deleteShader(s));
        },
      };
    } catch {
      if (position) gl.deleteBuffer(position);
      if (color) gl.deleteBuffer(color);
      if (program) gl.deleteProgram(program);
      shaders.forEach((s) => gl.deleteShader(s));
    }
  }
  return createCanvasPointRenderer(canvas, fallback);
}
export function createCanvasPointRenderer(
  canvas: HTMLCanvasElement,
  fallback: HTMLCanvasElement,
): PointRenderer {
  canvas.hidden = true;
  fallback.hidden = false;
  const ctx = fallback.getContext("2d");
  return {
    kind: "Canvas",
    draw(engine, f) {
      if (!ctx) return;
      ctx.clearRect(0, 0, f.width, f.height);
      const a =
          Math.sin(f.phase * 0.12) * 0.18 +
          f.x * 0.17 +
          (f.camera - 0.5) * 0.35,
        c = Math.cos(a),
        s = Math.sin(a),
        scale = Math.min(f.width, f.height) * (0.31 + f.camera * 0.08);
      for (let i = 0; i < engine.count; i++) {
        const k = i * 3,
          p = engine.positions,
          x = p[k] * c + p[k + 2] * s,
          z = -p[k] * s + p[k + 2] * c,
          depth = 1 / (1 + z * 0.18),
          y =
            (p[k + 1] + Math.sin(f.phase * 1.5 + p[k] * 1.1) * 0.025) *
              Math.cos(f.y * 0.1) -
            z * Math.sin(f.y * 0.1);
        ctx.fillStyle = `rgba(${Math.round(engine.colors[k] * 255)},${Math.round(engine.colors[k + 1] * 255)},${Math.round(engine.colors[k + 2] * 255)},.8)`;
        ctx.beginPath();
        ctx.arc(
          f.width / 2 + x * scale * depth,
          f.height / 2 - y * scale * depth,
          2.1 * f.dpr,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    },
    dispose() {
      ctx?.clearRect(0, 0, fallback.width, fallback.height);
    },
  };
}
