// Static "North America" terrain generator.
//
// Terrain lives in the WASM `resource_yield` buffer (one u8 per cell):
//   0 = plains, 1 = highlands, 2 = mountains, 3 = water
// The map is purely static — the same deterministic shape every game — so we
// generate it client-side straight into WASM memory at startup. The shape is
// expressed as a pure function of normalized coordinates (nx, ny) in [0,1]
// (nx: 0 = west .. 1 = east, ny: 0 = north .. 1 = south) so it is resolution
// independent and can be previewed as ASCII without running the renderer.

import { MAP_WIDTH, MAP_HEIGHT, TOTAL_CELLS } from './constants.js';

export const TERRAIN = { PLAINS: 0, HIGHLANDS: 1, MOUNTAINS: 2, WATER: 3 };

// --- Deterministic value noise (no per-frame cost; map is static) ---
function hash2(ix, iy) {
  const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const NA_MASK = "fffffffffffffffffffffffffffffffff800fffffffffffffffffffffffffffffffffffffffffffff807fffffffffffffffffffffffffffffffffffffffffffff803fffffffffffffffffffffffffffffffffffffffffffff801fffffffffffffffffffffffffffffffffffffffffffffc01fffffffffffffffffffffffffffffffffffffffffffffc00fffffffffffffffffffffffffffffffffffffffffffffe00fffffffffffffffffffffffffffffffffffffffffffffe00ffffffffffff7fffffffffffffffffffffffffffffffff00ffffffffffff7fffffffffffffffffffffffffffffffff81ffffffffffff7fffffffffffffffffffffffffffffffffe1ffffffffffff7ffffffffffffffffffffffffffffffffff7ffffffffffff3fffffffffffffffffffffffffffffffffffffffffffffffe3fffffffffffffffffffffffffffffffffffffffffffffffefffffffffffffffffffffffffffffffffffffffffff0031f3fffffffffffffffffffffffffffffffffffffffffc0700f8fffffffffffffffffffffffffffffffffffffffff801e03f3fffffffffffffffffffffffffffffffffffffffc070101f8fffffffffffffffffffffffffffffffffffffff87fc00018fffffffffffffffffffffffffffffffffffffff1ff8000387fffffffffffffffffffffffffffffffffffffe7ff00001e7fffffffffffffffffffffffffffffffffffffdfff00001f7fffffffffffffffffffffffffffffffffffff3fff00000ffffffffffffffffffffffffffffffffffffffe7fff00000fffffffffffffffffffffffffffffffffffffffffffa0000fffffffffffffffffffffffffffffffffffffffffffb8000fffffffffffffffffffffffffffffffffffffffffffc6000fffffffffffffffffffffffffffffffffffffffffffff000fffffffffffffffffffffffffffffffffffffffffffff000fffffffffffffffffffffffffffffffffffffffffc0ff000fffffffffffffffffffffffffffffffffffffffff83f8000ffffffffffffffffffffffffffffffffffffffffe0fe0000ffffffffffffffffffffffffffffffffffffffff00f80000fffffffffffffffffffffffffffffffffffffff800e00001fffffffffffffffffffffffffffffffffffffff000000001ffffffffffffffffffffffffffffffffffffffe000000001ffffffffffffffffffffffffffffffffffffffe000000001ffffffffffffffffffffffffffffffffffffffe000000000ffffffffffffffffffffffffffffffffffffffe000000000fffffffffffffffffffffffffffffffffffffff800000000fffffffffffffffffffffffffffffffffffffe0000000001fffffffffffffffffffffffffffffffffffffe0000000001ffffffffffffffffffffffffffffffffffff800000000001ffffffffffffffffffffffffffffffffffffc00000000000ffffffffffffffffffffffffffffffffffff8000000000007fffffffffffffffffffffffffffffffffff8000000000007ffffffffffffffffffffffffffffffffffb0000000000007fffffffffffffffffffffffffffffffffdc0000000000003fffffffffffffffffffffffffffffffffdc0000000000001fffffffffffffffffffffffffffffffffec0000000000000fffffffffffffffffffffffffffffffffe80000000000000fffffffffffffffffffffffffffffffffe800000000000007ffffffffffffffffffffffffffffffffe000000000000003fffffffffffffffffffffffffffffffff000000000000003fffffffffffffffffffffffffffffffff000000000000001fffffffffffffffffffffffffffffffff000000000000000fffffffffffffffffffffffffffffffff0000000000000007ffffffffffffffffffffffffffffffff0000000000000003ffffffffffffffffffffffffffffffff0000000000000003fffffffffffffffffffffffffffffffc0000000000000001ffffffffffffffffffffffffffffffe000000000000000003fffffffffffffffffffffffffffffc000000000000000000fffffffffffffffffffffffffffff00000000000000000003fffffffffffffffffffffffffffe00000000000000000000fffffffffffffffffffffffffffc00000000000000000000fffffffffffffffffffffffffff000000000000000000000ffffffffffffffffffffffffffe0000000000000000000007fffffffffffffffffffffffffc0000000000000000000007effffffffffffffffffffffff80000000000000000000003e1fffffffffffffffffffffff00000000000000000000003e0fffffffffffffffffffffff00000000000000000000001e0fffffffffffffffffffffff00000000000000000000001e0fffffffffffffffffc73fff00000000000000000000000f07ffffffffffffffff800f7f00000000000000000000000787ffffffffffffe1ff80003f800000000000000000000003c3ffffffffffff800f80001f800000000000000000000000e3ffffffffffff000000000fc0000000000000000000000061fffffffffffc000000000fc0000000000000000000000070fffffffffff0000000000fe00000000000000000000000f83fffffffffe0000000000fe00000000000000000000001f81fffffffffc0000000000fe00000000000000000000000fc0fffffffffc00000000007f000000000000000000000003e07ffffffffc00000000007f0000000000000000000000000f03ffffffffc00000000003f000000000000000000000000781ffffffffc00000000001f000000000000000000000000381ffffffffc00000000001f0000000000000000000000001c1ffffffffc00000000000e0000000000000000000000001c07fffffff80000000000060000000000000000000000001e03fffffff80000000000000000000000000000000000000e01fffffff80000000000000000000000000000000000000780fffffff800000000000000000000000000000000000001803ffffff800000000000000000000000000000000000000c01ffffff800000000000000000000000000000000000000c01ffffff000000000000000000000000000000000000000000ffffff0000000000000000000000000000000000000000007fffff0000000000000000000000000000000000000000007fffff0000000000000000000000000000000000000000003fffff8000000000000000000000000000000000000000001fffffc000003f00000000000000000000000000000000001fffffc00001ff00000000000000000000000000000000003fffffc00003ff00000000000000000000000000000000007fffffe00003fe00000000000000000000000000000000003ffffff00003fc00000000000000000000000000000000001ffffff00007fc00000000000000000000000000000000001ffffff80007fc000000000000000000000000000000000007fffff8000ffc000000000000000000000000000000000001ffffff007ffc000000000000000000000000000000000000ffffffcfffe0000000000000000000";
const MASK_BITS = new Uint8Array(192 * 108);
for (let i = 0; i < NA_MASK.length; i++) {
  const v = parseInt(NA_MASK[i], 16);
  MASK_BITS[i*4]   = (v >> 3) & 1;
  MASK_BITS[i*4+1] = (v >> 2) & 1;
  MASK_BITS[i*4+2] = (v >> 1) & 1;
  MASK_BITS[i*4+3] = v & 1;
}

function isLand(nx, ny) {
  // Wobble the coastline by dithering the mask lookup
  const dx = (valueNoise(nx * 50, ny * 50) - 0.5) * 0.015;
  const dy = (valueNoise(nx * 50 + 10, ny * 50 + 10) - 0.5) * 0.015;
  
  let px = Math.floor((nx + dx) * 192);
  let py = Math.floor((ny + dy) * 108);
  
  px = Math.max(0, Math.min(191, px));
  py = Math.max(0, Math.min(107, py));
  
  return MASK_BITS[py * 192 + px] === 1;
}

// Pure terrain classifier. Returns a TERRAIN value for any point in [0,1]^2.
export function terrainAt(nx, ny) {
  if (!isLand(nx, ny)) { return TERRAIN.WATER; }

  const n = valueNoise(nx * 25, ny * 25);

  // Rockies (western spine)
  // They are roughly at nx = 0.2 to 0.35, going from NW to SE.
  const rockiesSpine = 0.12 + ny * 0.22; 
  const distToRockies = Math.abs(nx - rockiesSpine);
  
  if (distToRockies < 0.04 + n * 0.03) {
    return TERRAIN.MOUNTAINS;
  }
  if (distToRockies < 0.12 + n * 0.05) {
    return TERRAIN.HIGHLANDS;
  }

  // Appalachians (eastern spine)
  const appSpine = 0.81 - ny * 0.21;
  const distToApp = Math.abs(nx - appSpine);
  if (ny > 0.3 && ny < 0.8 && distToApp < 0.03 + n * 0.02) {
    return TERRAIN.MOUNTAINS;
  }
  if (ny > 0.25 && ny < 0.85 && distToApp < 0.08 + n * 0.03) {
    return TERRAIN.HIGHLANDS;
  }

  // Canada/North
  if (ny < 0.15 && n > 0.5) {
    return TERRAIN.HIGHLANDS;
  }

  return TERRAIN.PLAINS;
}

// Fill the WASM terrain buffer in place. `memory` is the WASM Memory, `ptr` the
// resource_yield pointer (TOTAL_CELLS bytes). Called once at startup.
export function generateTerrain(memory, ptr) {
  const terrain = new Uint8Array(memory.buffer, ptr, TOTAL_CELLS);
  let i = 0;
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const ny = y / MAP_HEIGHT;
    for (let x = 0; x < MAP_WIDTH; x++) {
      terrain[i++] = terrainAt(x / MAP_WIDTH, ny);
    }
  }
}
