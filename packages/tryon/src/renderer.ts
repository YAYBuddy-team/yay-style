/**
 * WebGL2 compositor: user photo → garment meshes (bottom-up) → occluder (hair, face,
 * hands) on top. Garment textures are drawn with premultiplied alpha, so the soft cutout
 * edges from the backend blend cleanly.
 */

import { fitGarment, type GarmentMesh } from "./fit";
import type { PersonAnalysis, TryOnLayer } from "./types";

const VERT = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform vec2 u_res;
out vec2 v_uv;
void main() {
  vec2 clip = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_brightness;
uniform float u_shadow; // >0: draw a soft dark silhouette instead of the texture
out vec4 outColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_shadow > 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, c.a * u_shadow);
  } else {
    outColor = vec4(c.rgb * u_brightness, c.a);
  }
}`;

type Source = TexImageSource;

export interface RenderResult {
  meshes: (GarmentMesh | null)[];
  errors: (string | null)[];
}

export class TryOnRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private textures = new WeakMap<object, WebGLTexture>();
  private buffers: { pos: WebGLBuffer; uv: WebGLBuffer; idx: WebGLBuffer };
  private loc: {
    pos: number;
    uv: number;
    res: WebGLUniformLocation;
    brightness: WebGLUniformLocation;
    shadow: WebGLUniformLocation;
  };

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 недоступен в этом браузере");
    this.gl = gl;
    this.program = link(gl, VERT, FRAG);
    this.buffers = { pos: gl.createBuffer()!, uv: gl.createBuffer()!, idx: gl.createBuffer()! };
    this.loc = {
      pos: gl.getAttribLocation(this.program, "a_pos"),
      uv: gl.getAttribLocation(this.program, "a_uv"),
      res: gl.getUniformLocation(this.program, "u_res")!,
      brightness: gl.getUniformLocation(this.program, "u_brightness")!,
      shadow: gl.getUniformLocation(this.program, "u_shadow")!,
    };
  }

  render(person: PersonAnalysis, layers: TryOnLayer[], opts: { shadow?: boolean } = {}): RenderResult {
    const { gl, canvas } = this;
    canvas.width = person.width;
    canvas.height = person.height;
    gl.viewport(0, 0, person.width, person.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.loc.res, person.width, person.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.drawQuad(person.image, person.width, person.height);

    const meshes: (GarmentMesh | null)[] = [];
    const errors: (string | null)[] = [];
    for (const layer of layers) {
      if (!layer.visible) {
        meshes.push(null);
        errors.push(null);
        continue;
      }
      let mesh: GarmentMesh;
      try {
        mesh = fitGarment(layer.asset, person, layer.adjust);
      } catch (e) {
        meshes.push(null);
        errors.push(e instanceof Error ? e.message : String(e));
        continue;
      }
      if (opts.shadow !== false) {
        // A slightly offset, faint silhouette reads as the garment's shadow on the body.
        const shift = Math.max(2, person.width * 0.004);
        this.drawMesh(layer.image, offset(mesh, shift, shift * 1.5), 1, 0.18);
      }
      this.drawMesh(layer.image, mesh, layer.adjust.brightness, 0);
      meshes.push(mesh);
      errors.push(null);
    }

    this.drawQuad(person.occluder, person.width, person.height);
    return { meshes, errors };
  }

  private drawQuad(src: Source, w: number, h: number): void {
    const mesh: GarmentMesh = {
      positions: new Float32Array([0, 0, w, 0, 0, h, w, h]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
      landed: [],
    };
    this.drawMesh(src, mesh, 1, 0);
  }

  private drawMesh(src: Source, mesh: GarmentMesh, brightness: number, shadow: number): void {
    const { gl, buffers, loc } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture(src));
    gl.uniform1f(loc.brightness, brightness);
    gl.uniform1f(loc.shadow, shadow);

    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.pos);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uv);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.uv);
    gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);
  }

  private texture(src: Source): WebGLTexture {
    const key = src as unknown as object;
    let tex = this.textures.get(key);
    // Canvases (photo, occluder) are re-uploaded each time: their pixels may change.
    if (tex && !(src instanceof HTMLCanvasElement)) return tex;
    const { gl } = this;
    if (!tex) {
      tex = gl.createTexture()!;
      this.textures.set(key, tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
}

function offset(mesh: GarmentMesh, dx: number, dy: number): GarmentMesh {
  const positions = new Float32Array(mesh.positions);
  for (let i = 0; i < positions.length; i += 2) {
    positions[i]! += dx;
    positions[i + 1]! += dy;
  }
  return { ...mesh, positions };
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  return p;
}
