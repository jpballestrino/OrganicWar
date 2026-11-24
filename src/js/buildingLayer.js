// Buildings on the GPU. The overlay canvas used to draw every building with
// Canvas 2D paths, gradients and glows, every frame (~30 µs each on the main
// thread, plus the browser's rasterising: 7–9 ms per frame with the whole
// map in view). Now:
//   * each distinct icon (type × faction × state × size) is painted ONCE,
//     with the same art (buildingArt.js), into a sprite atlas texture;
//   * every frame, all visible icons go to the GPU in one instanced draw —
//     a few floats per building — and the spinning parts (a gold mine's
//     ring, an anti-air reticle) in a second, rotated by the vertex shader;
//   * the defense-zone rings and the synergy links (dashed rings and lines
//     with a glow) are drawn by a small distance-field shader, also instanced.
// What still changes per building (construction bar, silo cooldown, anti-air
// charge dots) stays on the overlay canvas: only a handful are on screen.
import { paintBuildingArt } from './buildingArt.js';

const SPRITE_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;      // -1..1, per vertex
layout(location = 1) in vec4 a_posHalfRot;  // centre x, y (px), half size (px), rotation
layout(location = 2) in vec4 a_uv;          // u0, v0, u1, v1
uniform vec2 u_screen;
out vec2 v_uv;
void main() {
  float c = cos(a_posHalfRot.w), s = sin(a_posHalfRot.w);
  vec2 o = a_corner * a_posHalfRot.z;
  vec2 p = a_posHalfRot.xy + vec2(o.x * c - o.y * s, o.x * s + o.y * c);
  gl_Position = vec4(p.x / u_screen.x * 2.0 - 1.0, 1.0 - p.y / u_screen.y * 2.0, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner * 0.5 + 0.5);
}`;

const SPRITE_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_atlas, v_uv); } // premultiplied
`;

// Dashed strokes by distance: kind 0 = segment p0→p1, kind 1 = ring
// (centre, radius). Arc length along the stroke drives the dash pattern.
const SHAPE_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_geom;   // seg: x0 y0 x1 y1 | ring: cx cy r 0
layout(location = 2) in vec4 a_color;  // straight rgba
layout(location = 3) in vec4 a_style;  // width, dash on, dash off, dash offset
layout(location = 4) in vec2 a_kindGlow;
uniform vec2 u_screen;
out vec2 v_p;
flat out vec4 v_geom;
flat out vec4 v_color;
flat out vec4 v_style;
flat out vec2 v_kindGlow;
void main() {
  float pad = a_style.x * 0.5 + a_kindGlow.y * 2.0 + 1.0;
  vec2 p;
  if (a_kindGlow.x < 0.5) {
    vec2 d = a_geom.zw - a_geom.xy;
    float len = max(length(d), 0.001);
    vec2 t = d / len, n = vec2(-t.y, t.x);
    vec2 mid = (a_geom.xy + a_geom.zw) * 0.5;
    p = mid + t * a_corner.x * (len * 0.5 + pad) + n * a_corner.y * pad;
  } else {
    p = a_geom.xy + a_corner * (a_geom.z + pad);
  }
  v_p = p; v_geom = a_geom; v_color = a_color; v_style = a_style; v_kindGlow = a_kindGlow;
  gl_Position = vec4(p.x / u_screen.x * 2.0 - 1.0, 1.0 - p.y / u_screen.y * 2.0, 0.0, 1.0);
}`;

const SHAPE_FS = `#version 300 es
precision highp float;
in vec2 v_p;
flat in vec4 v_geom;
flat in vec4 v_color;
flat in vec4 v_style;
flat in vec2 v_kindGlow;
out vec4 o;
void main() {
  float dist, along;
  if (v_kindGlow.x < 0.5) {
    vec2 d = v_geom.zw - v_geom.xy;
    float len = max(length(d), 0.001);
    vec2 t = d / len;
    along = clamp(dot(v_p - v_geom.xy, t), 0.0, len);
    dist = length(v_p - (v_geom.xy + t * along));
  } else {
    vec2 r = v_p - v_geom.xy;
    dist = abs(length(r) - v_geom.z);
    along = (atan(r.y, r.x) + 3.14159265) * v_geom.z;
  }
  float on = 1.0;
  float period = v_style.y + v_style.z;
  if (v_style.z > 0.0) {
    float m = mod(along + v_style.w, period);
    on = smoothstep(0.0, 0.8, m) * (1.0 - smoothstep(v_style.y - 0.8, v_style.y, m));
  }
  float core = clamp(v_style.x * 0.5 - dist + 0.5, 0.0, 1.0);
  float glow = v_kindGlow.y > 0.0 ? exp(-(dist * dist) / (v_kindGlow.y * v_kindGlow.y)) * 0.55 : 0.0;
  float a = max(core, glow) * on * v_color.a;
  o = vec4(v_color.rgb * a, a);
}`;

// A texture of icon sprites, CELL px square each, painted on demand and
// reused least-recently-used first when full.
class Atlas {
  constructor(gl, iconSize, cell, size = 2048) {
    this.gl = gl;
    this.iconSize = iconSize;
    this.cell = cell;
    this.size = size;
    this.per = Math.floor(size / cell);
    this.slots = new Map(); // key → { i, used }
    this.free = [];
    for (let i = this.per * this.per - 1; i >= 0; i--) this.free.push(i);
    this.scratch = document.createElement('canvas');
    this.scratch.width = this.scratch.height = cell;
    this.sctx = this.scratch.getContext('2d');
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.dirty = false;
    this.painted = 0;
  }

  // UV rect of the sprite for `key`, painting it first if needed; null when
  // the atlas is full of sprites used this very frame.
  uv(key, frame, paint) {
    let slot = this.slots.get(key);
    if (!slot) {
      let i = this.free.pop();
      if (i === undefined) {
        let oldKey = null;
        let oldest = Infinity;
        for (const [k, s] of this.slots) if (s.used < oldest && s.used < frame) { oldest = s.used; oldKey = k; }
        if (oldKey === null) return null;
        i = this.slots.get(oldKey).i;
        this.slots.delete(oldKey);
      }
      slot = { i, used: frame };
      this.slots.set(key, slot);
      const { sctx, cell, gl } = this;
      gl.activeTexture(gl.TEXTURE4);
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, cell, cell);
      sctx.translate(cell / 2, cell / 2);
      paint(sctx, this.iconSize);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, (i % this.per) * cell, Math.floor(i / this.per) * cell,
        gl.RGBA, gl.UNSIGNED_BYTE, this.scratch);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.dirty = true;
      this.painted++;
    }
    slot.used = frame;
    const x = (slot.i % this.per) * this.cell;
    const y = Math.floor(slot.i / this.per) * this.cell;
    return [x / this.size, y / this.size, (x + this.cell) / this.size, (y + this.cell) / this.size];
  }

  finish() {
    if (!this.dirty) return;
    this.gl.activeTexture(this.gl.TEXTURE4);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
    this.gl.generateMipmap(this.gl.TEXTURE_2D);
    this.dirty = false;
  }
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('building shader: ' + gl.getShaderInfoLog(sh));
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('building program: ' + gl.getProgramInfoLog(p));
  return p;
}

// Floats per instance.
const SPRITE_F = 8;
const SHAPE_F = 18;

export class BuildingLayer {
  constructor(gl) {
    this.gl = gl;
    this.sprite = program(gl, SPRITE_VS, SPRITE_FS);
    this.shape = program(gl, SHAPE_VS, SHAPE_FS);
    this.uSpriteScreen = gl.getUniformLocation(this.sprite, 'u_screen');
    this.uAtlas = gl.getUniformLocation(this.sprite, 'u_atlas');
    this.uShapeScreen = gl.getUniformLocation(this.shape, 'u_screen');
    // Icons up to ~30 px drawn from the small atlas, larger from the big one
    // (cells hold the icon plus its glow: ~7× the icon size).
    this.small = new Atlas(gl, 24, 168);
    this.large = new Atlas(gl, 64, 448);
    this.frame = 0;

    const corners = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const makeVao = (layout, floats) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const cb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, cb);
      gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, ib);
      let off = 0;
      layout.forEach((n, k) => {
        gl.enableVertexAttribArray(k + 1);
        gl.vertexAttribPointer(k + 1, n, gl.FLOAT, false, floats * 4, off * 4);
        gl.vertexAttribDivisor(k + 1, 1);
        off += n;
      });
      gl.bindVertexArray(null);
      return { vao, ib, data: new Float32Array(floats * 64), floats };
    };
    this.spriteVao = makeVao([4, 4], SPRITE_F);
    this.shapeVao = makeVao([4, 4, 4, 2], SHAPE_F);
  }

  // Instances: grow the CPU buffer as needed.
  _room(buf, n) {
    if (buf.data.length < n * buf.floats) {
      const bigger = new Float32Array(Math.max(n, buf.data.length / buf.floats * 2) * buf.floats);
      bigger.set(buf.data);
      buf.data = bigger;
    }
  }

  _draw(buf, prog, count, setup) {
    if (!count) return;
    const gl = this.gl;
    gl.useProgram(prog);
    setup();
    gl.bindVertexArray(buf.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.ib);
    gl.bufferData(gl.ARRAY_BUFFER, buf.data.subarray(0, count * buf.floats), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
  }

  begin(width, height) {
    const gl = this.gl;
    this.frame++;
    this.width = width;
    this.height = height;
    gl.viewport(0, 0, width, height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  end() {
    this.gl.disable(this.gl.BLEND);
  }

  // shapes: [{ kind: 0|1, geom: [4], color: [r,g,b,a 0..1], width, dash: [on, off], offset, glow }]
  drawShapes(shapes) {
    const buf = this.shapeVao;
    this._room(buf, shapes.length);
    const d = buf.data;
    shapes.forEach((s, i) => {
      const o = i * SHAPE_F;
      d.set(s.geom, o);
      d.set(s.color, o + 4);
      d[o + 8] = s.width; d[o + 9] = s.dash ? s.dash[0] : 1; d[o + 10] = s.dash ? s.dash[1] : 0; d[o + 11] = s.offset || 0;
      d[o + 12] = s.kind; d[o + 13] = s.glow || 0;
    });
    this._draw(buf, this.shape, shapes.length, () => this.gl.uniform2f(this.uShapeScreen, this.width, this.height));
  }

  // icons: [{ x, y, iconSize, pulse, rot, spec, layer }] — screen px.
  drawIcons(icons) {
    const gl = this.gl;
    const big = icons.length && icons[0].iconSize > 30;
    const atlas = big ? this.large : this.small;
    const buf = this.spriteVao;
    this._room(buf, icons.length);
    const d = buf.data;
    let n = 0;
    for (const it of icons) {
      const s = it.spec;
      const key = `${it.layer}|${s.type}|${s.factionId}|${s.constructing ? 1 : 0}|${s.charged ? 1 : 0}|${s.lowGraphics ? 1 : 0}`;
      const uv = atlas.uv(key, this.frame, (ctx, size) => paintBuildingArt(ctx, s, size, it.layer));
      if (!uv) continue;
      const o = n * SPRITE_F;
      d[o] = it.x; d[o + 1] = it.y;
      d[o + 2] = (atlas.cell / 2) * (it.iconSize / atlas.iconSize) * it.pulse;
      d[o + 3] = it.rot;
      d[o + 4] = uv[0]; d[o + 5] = uv[1]; d[o + 6] = uv[2]; d[o + 7] = uv[3];
      n++;
    }
    atlas.finish();
    this._draw(buf, this.sprite, n, () => {
      gl.uniform2f(this.uSpriteScreen, this.width, this.height);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, atlas.tex);
      gl.uniform1i(this.uAtlas, 4);
    });
    return n;
  }
}

