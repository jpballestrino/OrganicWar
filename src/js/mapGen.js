// Static "North America" terrain generator.
//
// Terrain is one of: 0 = plains, 1 = highlands, 2 = mountains, 3 = water.
// It is written into the terrain bits (7-10) of the WASM packed cell buffer
// (one u16 per cell — see src/js/constants.js). The map is purely static — the
// same deterministic shape every game — so we generate it client-side straight
// into WASM memory at startup. The shape is expressed as a pure function of
// normalized coordinates (nx, ny) in [0,1] (nx: 0 = west .. 1 = east, ny: 0 =
// north .. 1 = south) so it is resolution independent and can be previewed as
// ASCII without running the renderer.

import { MAP_WIDTH, MAP_HEIGHT, CELL_TERRAIN_SHIFT, CELL_TERRAIN_MASK } from './constants.js';

// Size of the map being generated (the standard 1920×1080, or the Mega
// Battle map — MAP_SIZES in constants.js). Set by each public entry point
// before it runs; everything here is synchronous, so module state is safe.
let W = MAP_WIDTH;
let H = MAP_HEIGHT;
let N = W * H;
function useSize(width = MAP_WIDTH, height = MAP_HEIGHT) {
  W = width; H = height; N = W * H;
}

// Terrain codes (bits 7-10 of a cell; lib.rs and the renderer mirror them).
// 0-3 are the base terrain from each map's classifier (terrainAt); 4-7 are
// the features generateTerrain adds on top (see addFeatures):
//   FOREST  slows expansion (neutral ×3) and is costly to take (cost 4)
//   RIVER   a ford: slow to cross (neutral ×5, cost 5) — natural borders
//   GOLD    a deposit: +0.1 gold/s per owned cell (30× plains)
//   RUINS   a fortified neutral enclave (×10) that pays 8 gold per cell taken
export const TERRAIN = {
  PLAINS: 0, HIGHLANDS: 1, MOUNTAINS: 2, WATER: 3,
  FOREST: 4, RIVER: 5, GOLD: 6, RUINS: 7,
};

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



const NA_MASK = "fffffffffffffffffffffffffffffffff800fffffffffffffffffffffffffffffffffffffffffffff807fffffffffffffffffffffffffffffffffffffffffffff803fffffffffffffffffffffffffffffffffffffffffffff801fffffffffffffffffffffffffffffffffffffffffffffc01fffffffffffffffffffffffffffffffffffffffffffffc00fffffffffffffffffffffffffffffffffffffffffffffe00fffffffffffffffffffffffffffffffffffffffffffffe00ffffffffffff7fffffffffffffffffffffffffffffffff00ffffffffffff7fffffffffffffffffffffffffffffffff81ffffffffffff7fffffffffffffffffffffffffffffffffe1ffffffffffff7ffffffffffffffffffffffffffffffffff7ffffffffffff3fffffffffffffffffffffffffffffffffffffffffffffffe3fffffffffffffffffffffffffffffffffffffffffffffffefffffffffffffffffffffffffffffffffffffffffff0031f3fffffffffffffffffffffffffffffffffffffffffc0700f8fffffffffffffffffffffffffffffffffffffffff801e03f3fffffffffffffffffffffffffffffffffffffffc070101f8fffffffffffffffffffffffffffffffffffffff87fc00018fffffffffffffffffffffffffffffffffffffff1ff8000387fffffffffffffffffffffffffffffffffffffe7ff00001e7fffffffffffffffffffffffffffffffffffffdfff00001f7fffffffffffffffffffffffffffffffffffff3fff00000ffffffffffffffffffffffffffffffffffffffe7fff00000fffffffffffffffffffffffffffffffffffffffffffa0000fffffffffffffffffffffffffffffffffffffffffffb8000fffffffffffffffffffffffffffffffffffffffffffc6000fffffffffffffffffffffffffffffffffffffffffffff000fffffffffffffffffffffffffffffffffffffffffffff000fffffffffffffffffffffffffffffffffffffffffc0ff000fffffffffffffffffffffffffffffffffffffffff83f8000ffffffffffffffffffffffffffffffffffffffffe0fe0000ffffffffffffffffffffffffffffffffffffffff00f80000fffffffffffffffffffffffffffffffffffffff800e00001fffffffffffffffffffffffffffffffffffffff000000001ffffffffffffffffffffffffffffffffffffffe000000001ffffffffffffffffffffffffffffffffffffffe000000001ffffffffffffffffffffffffffffffffffffffe000000000ffffffffffffffffffffffffffffffffffffffe000000000fffffffffffffffffffffffffffffffffffffff800000000fffffffffffffffffffffffffffffffffffffe0000000001fffffffffffffffffffffffffffffffffffffe0000000001ffffffffffffffffffffffffffffffffffff800000000001ffffffffffffffffffffffffffffffffffffc00000000000ffffffffffffffffffffffffffffffffffff8000000000007fffffffffffffffffffffffffffffffffff8000000000007ffffffffffffffffffffffffffffffffffb0000000000007fffffffffffffffffffffffffffffffffdc0000000000003fffffffffffffffffffffffffffffffffdc0000000000001fffffffffffffffffffffffffffffffffec0000000000000fffffffffffffffffffffffffffffffffe80000000000000fffffffffffffffffffffffffffffffffe800000000000007ffffffffffffffffffffffffffffffffe000000000000003fffffffffffffffffffffffffffffffff000000000000003fffffffffffffffffffffffffffffffff000000000000001fffffffffffffffffffffffffffffffff000000000000000fffffffffffffffffffffffffffffffff0000000000000007ffffffffffffffffffffffffffffffff0000000000000003ffffffffffffffffffffffffffffffff0000000000000003fffffffffffffffffffffffffffffffc0000000000000001ffffffffffffffffffffffffffffffe000000000000000003fffffffffffffffffffffffffffffc000000000000000000fffffffffffffffffffffffffffff00000000000000000003fffffffffffffffffffffffffffe00000000000000000000fffffffffffffffffffffffffffc00000000000000000000fffffffffffffffffffffffffff000000000000000000000ffffffffffffffffffffffffffe0000000000000000000007fffffffffffffffffffffffffc0000000000000000000007effffffffffffffffffffffff80000000000000000000003e1fffffffffffffffffffffff00000000000000000000003e0fffffffffffffffffffffff00000000000000000000001e0fffffffffffffffffffffff00000000000000000000001e0fffffffffffffffffc73fff00000000000000000000000f07ffffffffffffffff800f7f00000000000000000000000787ffffffffffffe1ff80003f800000000000000000000003c3ffffffffffff800f80001f800000000000000000000000e3ffffffffffff000000000fc0000000000000000000000061fffffffffffc000000000fc0000000000000000000000070fffffffffff0000000000fe00000000000000000000000f83fffffffffe0000000000fe00000000000000000000001f81fffffffffc0000000000fe00000000000000000000000fc0fffffffffc00000000007f000000000000000000000003e07ffffffffc00000000007f0000000000000000000000000f03ffffffffc00000000003f000000000000000000000000781ffffffffc00000000001f000000000000000000000000381ffffffffc00000000001f0000000000000000000000001c1ffffffffc00000000000e0000000000000000000000001c07fffffff80000000000060000000000000000000000001e03fffffff80000000000000000000000000000000000000e01fffffff80000000000000000000000000000000000000780fffffff800000000000000000000000000000000000001803ffffff800000000000000000000000000000000000000c01ffffff800000000000000000000000000000000000000c01ffffff000000000000000000000000000000000000000000ffffff0000000000000000000000000000000000000000007fffff0000000000000000000000000000000000000000007fffff0000000000000000000000000000000000000000003fffff8000000000000000000000000000000000000000001fffffc000003f00000000000000000000000000000000001fffffc00001ff00000000000000000000000000000000003fffffc00003ff00000000000000000000000000000000007fffffe00003fe00000000000000000000000000000000003ffffff00003fc00000000000000000000000000000000001ffffff00007fc00000000000000000000000000000000001ffffff80007fc000000000000000000000000000000000007fffff8000ffc000000000000000000000000000000000001ffffff007ffc000000000000000000000000000000000000ffffffcfffe0000000000000000000";
const MASK_BITS = new Uint8Array(192 * 108);
for (let i = 0; i < NA_MASK.length; i++) {
  const v = parseInt(NA_MASK[i], 16);
  MASK_BITS[i*4]   = (v >> 3) & 1;
  MASK_BITS[i*4+1] = (v >> 2) & 1;
  MASK_BITS[i*4+2] = (v >> 1) & 1;
  MASK_BITS[i*4+3] = v & 1;
}

function isLandNA(nx, ny) {
  // Wobble the coastline by dithering the mask lookup
  const dx = (valueNoise(nx * 50, ny * 50) - 0.5) * 0.015;
  const dy = (valueNoise(nx * 50 + 10, ny * 50 + 10) - 0.5) * 0.015;

  let px = Math.floor((nx + dx) * 192);
  let py = Math.floor((ny + dy) * 108);

  px = Math.max(0, Math.min(191, px));
  py = Math.max(0, Math.min(107, py));

  return MASK_BITS[py * 192 + px] === 1;
}

// How far `v` lies outside [lo, hi], in units of `soft` (0 inside). Used to
// fade a latitude band out gradually instead of cutting it at a straight line.
function outside(v, lo, hi, soft = 0.06) {
  return Math.max(0, lo - v, v - hi) / soft;
}

// North America terrain classifier.
function terrainNA(nx, ny) {
  if (!isLandNA(nx, ny)) { return TERRAIN.WATER; }

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
  // The range tapers off at both ends instead of stopping at a straight line.
  if (distToApp < (0.03 + n * 0.02) * Math.max(0, 1 - outside(ny, 0.3, 0.8, 0.08))) {
    return TERRAIN.MOUNTAINS;
  }
  if (distToApp < (0.08 + n * 0.03) * Math.max(0, 1 - outside(ny, 0.25, 0.85, 0.10))) {
    return TERRAIN.HIGHLANDS;
  }

  // Canada/North
  if (n > 0.5 + 0.5 * outside(ny, 0, 0.15)) {
    return TERRAIN.HIGHLANDS;
  }

  return TERRAIN.PLAINS;
}

// --- Europe ---
// Built from REAL coastline data, not analytic shapes: the Natural Earth 50m land
// polygons, clipped to a Europe bounding box (lon −11..55, lat 34..71 — an exact
// 16:9 window that fills the frame with minimal open water) and rasterized once,
// offline, into the EU_MASK bitmap below — the same baked-bitmap scheme as North
// America's NA_MASK. The equirectangular projection is baked into the bitmap, so
// runtime is just a fast lookup (no per-pixel geometry). Substantial landmasses
// (Britain, Ireland, Sicily, Sardinia/Corsica, …) survive; tiny islets were
// dropped by an area filter during rasterization. The island-bridging pass links
// each landmass to its NEAREST neighbour with a narrow chokepoint causeway, so
// island chains (Ireland → Britain → mainland) connect sensibly.
const EU_MASK_W = 320, EU_MASK_H = 180;
const EU_MASK = "0000000000000000000000000000000000000000000e823e0000000000000000000000000000007f0000000000000000000000000000000000000000001f8c78f80000000000000000000000000000010000000000000000000000000000000000000000003f3cfdffc000000000000000000000000000000000000000000000000000000000000000000000b9fe7fffffe000000000000000000000000000000000000000000000000000000000000000000001fbffffffc0000000000000000000000000000000000000000000000000000000000000000000017efffffffff80040000000000000000000000000000000000000000000000000000000000000003f7fffffffffffffb800000000000000000000000000000000000000000000000000000000000000fefffffffffffffff800000000000000000038000000000000000000000000000000000000000007fffffffffffffffffefc8000000000000000ff80000000000000000000000000000000000000001ffffffffffffffffffffffc00000000000001fe00000000000000000000000000000000000000003fffffffffffffffffffffffc0000000000000f80001e00000000000000000000000000000000003fffffffffffffffffffffffff800000080000000001fc000000000000000000000000000000000003ffffffffffffffffffffffffe0000003ff0000001e7e0000000000000000000000000000000000fffffffffffffffffffffffffffe000000ffc00003ffffd00000000000000000000000000000000fffffffffffffffffffffffffffffe00000ffe0001ffffff00000000000000000000000000000007ffffffffffffffffffffffffffffff80001ff8003fffffff00000000000000000000000000000001fffffffffffffffffffffffffffffff0001f8003ffffffff0000000000000000000000000000000ffffffffffffffffffffffffffffffff8003e0007ffffffff00000000000000000000000000000003fffffffffffffffffffffffffffffffc003fc007ffffffff0000000000000000000000000000007fffffffffffffffffffffe7fffffffffc0007e00fffffffff000000000000000000000000000001fffffffffffffffffffffff1fffffffff80007ffffffffffff000000000000000000000000000007fffffffffffffffffffffffc0dffffffe00007ffffffffffff000000000000000000000000000007ffffffffffffffffffffffff003fffff807f0fffffffffffff000000000000000000000000000003fffffffffffffffffffffffff0001ff801ff1fffffffffffff00000000000000000000000000000ffffffffffffffffffffffffff80000001fffffffffffffffff00000000000000000000000000003fffffffffff8407fffffffffffc0000007fffffffffffffffff00000000000000000000000000007fffffffffff8000fffffffffff8000003ffffffffffffffffff0000000000000000000000000000fffffffffffc0000fffffffffff0000003ffffffffffffffffff0000000000000000000000000000bffffffffffc0000fffffffffffc00e001ffffffffffffffffff0000000000000000000000000007fffffffffff80000fffffffffffc03f8007fffffffffffffffff0000000000000000000000000007fffffffffff0000ffffffffffffe01ffc1ffffffffffffffffff000000000000000000000000003ffffffffffff8001ffffffffffffe007fffffffffffffffffffff00000000000000000000000000fffffffffffff8003fffffffffffffe007ffffffffffffffffffff00000000000000000000000003ffffffffffffe000fffffffffffffff803ffffffffffffffffffff00000000000000000000000007cfffffffffffc003ffffffffffffffff8fffffffffffffffffffff0000000000000000000000000f9fffffffffff000fffffffffffffffffffffffffffffffffffffff000000000000000000000003b87ffffffffff8003fffffffffffffffffffffffffffffffffffffff000000000000000000000003ffffffffffffc0007fffffffffffffffffffffffffffffffffffffff00000000000000000000003ffffffffffffe0003ffffffffffffffffffffffffffffffffffffffff0000000000000000000001fffffffffffffe0007ffffffffffffffffffffffffffffffffffffffff00000000000000000000003ffffffffffff0000fffffffffffffffffffffffffffffffffffffffff000000000000000000001fffffffffffffe0000fffffffffffffffffffffffffffffffffffffffff00000000000000000000ffffffffffffffc00007ffffffffffffffffffffffffffffffffffffffff00000000000000000003ffffffffffffffc00007ffffffffffffffffffffffffffffffffffffffff0000000000000000000793ffffffffffffc00007ffffffffffffffffffffffffffffffffffffffff00000000000000000003ffffffffffffff800003ffffffffffffffffffffffffffffffffffffffff00000000000000000003ffffffffffffff800003ffffffffffffffffffffffffffffffffffffffff00000000000000000003ffffffffffffff800003ffffffffffffffffffffffffffffffffffffffff00000000000000000003ffffffffffffff800007ffffffffffffffffffffffffffffffffffffffff00000000000000000003ffffffffffffff800007ffffffffffffffffffffffffffffffffffffffff00000000000000000003ffffffffffffffe00007fffffffeffffffffffffffffffffffffffffffff00000000000000000003f3fffffffffffff800007fffe800ffffffffffffffffffffffffffffffff00000000000000000001dffffffffffffffe00001ffe00003fffffffffffffffffffffffffffffff00000000000000000001bfffffffffffffff800003c0000001ffffffffffffffffffffffffffffff000000000000000000031fffffffffffffff800000000001ffffffffffffffffffffffffffffffff00000000000000000001ffffffffffffffff000000007007ffffffffffffffffffffffffffffffff00000000000000000003dfffff7ffffffff80000001fffffffffffffffffffffffffffffffffffff000000000000000000033ffffe3ffffffffc000001ffffffffffffffffffffffffffffffffffffff000000000000000000008ffff41ffffffff0000001ffffffffffffffffffffffffffffffffffffff00000000000000000000ffffe00fffffff80000000ffffffffffffffffffffffffffffffffffffff000000053c00000000007fff800ffffffe00000000ffffffffffffffffffffffffffffffffffffff00000007fc00000000001ffe0007fffffc000000006fffffffffffffffffffffffffffffffffffff0000001ff0000000000007f80007fffffc000000000fffffffffffffffffffffffffffffffffffff0000000fc0000000000000000003fffffc000000001fffffffffffffffffffffffffffffffffffff0000003fc0000000000000000003fffffc000000001fffffffffffffffffffffffffffffffffffff0000003ffff80000000000000701fffffc000001f00fffffffffffffffffffffffffffffffffffff0000003ffff00000000000000f00fffffc000007f80fffffffffffffffffffffffffffffffffffff0000003fffe0000000000000ff007ffff8000007fc1fffffffffffffffffffffffffffffffffffff0000007fffe0000000000003be003ffff800000fffffffffffffffffffffffffffffffffffffffff000000ffffc0000000000002fe001ffff800001fffffffffffffffffffffffffffffffffffffffff0000001fff00000000000007ffc00ffff000001fffffffffffffffffffffffffffffffffffffffff0000001fff00000000000007ffc01fffe000001fffffffffffffffffffffffffffffffffffffffff0000003ffc00000000000007fe00dff80000001fffffffffffffffffffffffffffffffffffffffff00000023ffe0000000000007fe05cfe00000001fffffffffffffffffffffffffffffffffffffffff00000023fff0000000000007f81fcfc00000000fffffffffffffffffffffffffffffffffffffffff00000021fffc000000000003f00f8fe00000001fffffffffffffffffffffffffffffffffffffffff00006003fffc000000000001f00f80000000000fffffffffffffffffffffffffffffffffffffffff00075f07fffc000000000001e00300000000004fffffffffffffffffffffffffffffffffffffffff0007ff8fe7fe000000000001f0030000000003ffffffffffffffffffffffffffffffffffffffffff001fffc00fff000000000000fc00000000fe03ffffffffffffffffffffffffffffffffffffffffff000fffc00fffc000000000007e00200007ff0fffffffffffffffffffffffffffffffffffffffffff07efffc007fff000000000007fe078003fffffffffffffffffffffffffffffffffffffffffffffff03fffe0001fff000000000007fc3ff07ffffffffffffffffffffffffffffffffffffffffffffffff01fffe0001fff800000000015fffff8fffffffffffffffffffffffffffffffffffffffffffffffff03fffe0001fff000000000f1ffffffffffffffffffffffffffffffffffffffffffffffffffffffff0fffff0001fffc00000004ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff003fff007ffffe000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ffff00fffffc000003ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff01ffff007ffffff8000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff007ffe003ffffffc000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff07fffe007ffffffc001fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1fffe400fffffff8001fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0fff0007fffffff0007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0bf8000fffffffc0007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff03c000005f7fffc0037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000001ffff9006ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000007ffffff03fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000001ffffffc3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000001fffc0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000003f0000007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000e30000007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000380000000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000000000003fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000000001ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000000e03ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000000007f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000000003ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000000003ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000005e03ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000003ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000001ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000001ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000003ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000003fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000001fffffffffffffffffffffffffffffffffffffffffffffffffdfffffffffffffffffff00000000001fffffffffffffffffffffffffffffffffffffffffffffffe00ffffffffffffff1ffff00000000001fffffffffffffffffffffffffffffffffffffffffffffff80ffffffffffffffc001ff00000000000ffffffffffffffffffffffffffffffffffffffffd7fffe003ffffffffffffff0001ff000000000003ffffffffffffffffffffffffffffffffffffffc0ffff8007fffffffffffff80001ff000000000000ffffffffffffffffffffffffffffffffffffffc07ffe0001ffffffffffffe00001ff000000000000ffffffffffffffff0fffffffffffffffffff80007ff000ffffffffffff0000007ff000000000000bfffffffffffffff81fffffffffffffffffff8001fff8c0fffffffffffe0000001ff000000000000ffffffffffffffff81cffffffffffffffffff80003fffdffffffffffffe00003ffff000000000001ffffffffffffffffc0c3fffffffffffffffff80000ff807fffffffffffc00007ffff000000000001ffffffffffffffff8003ffffffffffffffffa00000f8003fffffffffff800007ffff000000000001ffffffffffffffff8003ffffffffffffffff800000f00003ffffffffff000071ffff000000000001fffffffffffe7fff8001ffffffffffffffff800000000001ffffffffff80007fffff000000000001fffffffffffc0fffc001ffffffffffffffff0000000000003fffffffffc0000fffff000000000001fffffffffff801ffe000ffffffffffffffff0000000000001fffffffffe0000fffff000000000003ffffffffffc001fff8003fffffffffffffff00000000000007ffffffffe00007ffff0007ffe00003ffffff7ffe0001fffe001fffffffffffffff00000000000003fffffffff00003ffff000fffffffcffffffe03fc0000ffff0000fffffffffffffc00000000000000fffffffff00003ffff007ffffffffffffff800700000ffff00007ffffffffffff8000000000000003ffffffff00000ffff007ffffffffffffff0000000007fff80005ffffffffffff8000000000000000ffffffff000007fff003ffffffffffffff0000000003fff80000ffffffffffff00000000000000003fffffff800000fff001ffffffffffffff8000000001fffc00003ffffffffffe00000000000000001fffffffc000007ff001ffffffffffffff80000000007ffe00000fffffffffff00000000000000001fffffffe00000fff003ffffffffffffff80000000003fff800003ffffffffff80000000000000001fffffffe00000fbf001ffffffffffffff80000000000ffffe0001ffffffffff8000007ff00000000ffffffff00000c1f003fffffffffffffe000000000007fffe0000ffffffffff800003fff90000000ffffffffc000081f001fffffffffffff8000000000003fffc0000ffffffffffc0000fffff8000001ffffffffe000040f001fffffffffffff0000000000000ffff8000fffffffffff8003fffffd000007ffffffffe0000407001fffffffffffe0000000006000007fff000ffffffffffffffffffffff0083ffffffffff0000001001fffffffffff8000000001f000007fffc00fffffe47fc01ffffffffffffffffffffffff8000201001fffffffffff8000000007f800001ffff01fffff000f801ffffffffffffffffffffffffc0003df001fffffffffff0000000003f8000003ff780fffef8002083fffffffffffffffffffffffff8007ff003ffffffffffe0000000003f0000003fe0e1fffe30007fffffffffffffffffffffffffffc0007ff003ffffffffffc0000000003f0000000fc0607ffe04007fffffffffffffffffffffffffff80007ff003ffffffffff80000000001f0000000380003fff0000ffffffffffffffffffffffffffff800007f007ffffffffff00000000003f00000003c0001fff0000ffffffffffffffffffffffffffff800007f007ffffffffff00000000003f00000001f0001fffc0001fffffffffffffffffffffffffff80001ff00fffffffffff00000000003f00000001f00007ff00001fffffffffffffffffffffffffff000007f00fffffffffff00000000001800000001f80003ff80001fffffffffffffffffffffffffff000003f01bffffffffffc0000000000000000000c00003fe00000ffffffffffffffffffffffffffc000001f007ffffffffff80000000000000000003c00001ffc0005ffffffffffffffffffffffffffc000003f003fffffffffe00000000000000000003c00000fff00047fffffffffffffffffffffffffc000003f001fffffffffe0000000000000000001f00000018fc007ffffffffffffffffffffffffffc000003f003fffffffffc0000000000000003f7f60000007fec0007fffffffffffffffffffffffffe000003f001fffffffffc0000000000000003ffe0000000ffc40007fffffffffffffffffffffffffe000003f001fffffffffc0000000000000001ffe00000007fe00007ffffffffffffffffffffffffff000003f001ffffffff8000000000000000003fe00000003f400007fffffffffffffffffffffffffff80001f003fcffffff80000000000003e0000fe00000003f000001fffffffffffffffffffffffffff80001f000003fffff0000000000cc0fe20001e0000000378000003ffffffffffffffffffffffffffe0001f000003ffffa000000ffc7ffffee0000e000000012800001cffc3fffbe7fffffffffffffffff803ff000001fe00000001ffffffffffc0000000000000000000003fc0ffe00fffffffffffffffffffffff000001f00000007fffffffffff80000000000000000000001f807fc01fffffffffffffffffffffff00000060000001ffffffffffff000000000000000000000000001f001fffffffffffffffffffffff00000000000003ffffffffffff0000000000000000000000000000001fffffffffffffffffffffff0000006000003fffffffffffffc000000000000000000000000000001fffffffffffffffffffffff000000f00000ffffffffffffffe000000000000000000000000000001fffffffffffffffffffffff000000f80001ffffffffffffffe000000000000000000000000000001fffffffffffffffffffffff000001ffff07ffffffffffffffe000000000000000000000000000001fffffffffffffffffffffff000001ffffffffffffffffffffc000000000000000000000000000001fffffffffffffffffffffff000003ffffffffffffffffffff8000000000000000000000000000000fffffffffffffffffffffff000003ffffffffffffffffffff0000000000000000000000000000000fffffffffffffffffffffff000007fffffffffffffffffffe0000000000000000000000000000003fffffffffffffffffffffff00000ffffffffffffffffffffc0000000000000000000000000000003fffffffffffffffffffffff";
const EU_MASK_BITS = new Uint8Array(EU_MASK_W * EU_MASK_H);
for (let i = 0; i < EU_MASK.length; i++) {
  const v = parseInt(EU_MASK[i], 16);
  EU_MASK_BITS[i*4]   = (v >> 3) & 1;
  EU_MASK_BITS[i*4+1] = (v >> 2) & 1;
  EU_MASK_BITS[i*4+2] = (v >> 1) & 1;
  EU_MASK_BITS[i*4+3] = v & 1;
}

// Normalized squared-ellipse value (<1 inside) — used by terrainEU to draw the
// mountain ranges over the real landmass.
function ell(nx, ny, cx, cy, rx, ry) {
  const a = (nx - cx) / rx, b = (ny - cy) / ry;
  return a * a + b * b;
}

function isLandEU(nx, ny) {
  // Wobble the coastline by dithering the mask lookup (mirrors isLandNA).
  const dx = (valueNoise(nx * 50, ny * 50) - 0.5) * 0.012;
  const dy = (valueNoise(nx * 50 + 10, ny * 50 + 10) - 0.5) * 0.012;
  let px = Math.floor((nx + dx) * EU_MASK_W);
  let py = Math.floor((ny + dy) * EU_MASK_H);
  px = Math.max(0, Math.min(EU_MASK_W - 1, px));
  py = Math.max(0, Math.min(EU_MASK_H - 1, py));
  return EU_MASK_BITS[py * EU_MASK_W + px] === 1;
}

// Europe terrain classifier — Alps, Pyrenees, Scandinavian range, Carpathians
// and Caucasus as elliptical mountain zones, with a highlands halo around each
// and a highlands fringe across the far north.
// Positions in the baked map's normalized coords (lon −11..55 → 0..1,
// lat 71..34 → 0..1). Real ranges placed by lon/lat.
const EU_RANGES = [
  [0.32, 0.66, 0.05, 0.03],   // Alps (~10E, 46.5N)
  [0.17, 0.77, 0.045, 0.02],  // Pyrenees (~0.5E, 42.7N)
  [0.30, 0.27, 0.035, 0.13],  // Scandinavian mountains (Norway spine)
  [0.53, 0.64, 0.05, 0.035],  // Carpathians (~24E, 47.5N)
  [0.82, 0.76, 0.05, 0.025],  // Caucasus (~43E, 43N)
  [0.37, 0.80, 0.02, 0.07],   // Apennines (Italy spine)
  [0.45, 0.74, 0.03, 0.05],   // Dinaric Alps (Balkans)
];
function terrainEU(nx, ny) {
  if (!isLandEU(nx, ny)) { return TERRAIN.WATER; }
  const n = valueNoise(nx * 25, ny * 25);
  let best = Infinity;
  for (const [cx, cy, rx, ry] of EU_RANGES) {
    const d = ell(nx, ny, cx, cy, rx, ry);
    if (d < best) best = d;
  }
  if (best < 1.0 + n * 0.4) return TERRAIN.MOUNTAINS;
  if (best < 2.6 + n * 0.8) return TERRAIN.HIGHLANDS;
  // Northern fringe (Scandinavia / northern Russia) trends to highlands.
  if (n > 0.5 + 0.5 * outside(ny, 0, 0.20)) return TERRAIN.HIGHLANDS;
  return TERRAIN.PLAINS;
}

// --- Africa ---
// Land mask built at module load from a polygon trace of the real coastline
// (lon −20..55, lat 40..−38 equirectangular window) rasterized into a
// 300×312 Uint8Array. Same noise-wobble coastline lookup as NA and EU.
const AF_MASK_W = 300, AF_MASK_H = 312;
const AF_LON_MIN = -18, AF_LON_MAX = 52;
const AF_LAT_MAX = 38,  AF_LAT_MIN = -35;
const _afNx = lon => (lon - AF_LON_MIN) / (AF_LON_MAX - AF_LON_MIN);
const _afNy = lat => (AF_LAT_MAX - lat) / (AF_LAT_MAX - AF_LAT_MIN);

// Africa mainland coastline [lon, lat] — clockwise from Strait of Gibraltar
const AF_POLY = [
  [-5.9,35.9],[-2.0,35.0],[0.0,36.9],[3.5,37.1],[7.5,37.1],
  [9.0,37.5],[10.6,37.0],[11.5,33.5],[13.5,33.2],
  [15.0,32.9],[20.0,32.9],[25.2,31.0],[28.5,31.0],[32.3,30.5],
  [34.9,27.5],[36.5,22.0],[36.5,18.5],[38.0,15.6],
  [43.0,11.5],[44.9,8.2],[46.9,7.5],[50.2,11.5],[51.4,11.5],
  [50.5,10.4],[49.5,5.0],[44.5,-1.5],[40.5,-10.0],
  [40.0,-14.0],[37.5,-21.5],[35.5,-25.0],[33.0,-28.0],
  [30.5,-31.0],[28.0,-33.0],[25.0,-34.0],[20.0,-34.8],
  [18.5,-34.4],[17.9,-32.5],[16.5,-29.2],[15.0,-28.0],
  [13.0,-22.0],[12.0,-17.0],[12.5,-11.0],[11.5,-3.5],
  [9.5,0.5],[8.5,1.5],[5.0,-1.0],[3.5,2.0],
  [2.8,4.3],[1.6,6.2],[0.0,5.5],
  [-2.0,5.0],[-4.0,5.0],[-6.0,5.0],[-8.0,5.0],
  [-10.5,6.0],[-13.0,8.5],[-15.0,10.7],[-16.0,12.0],
  [-17.5,14.7],[-17.1,20.8],[-15.9,23.7],[-14.5,26.1],
  [-13.1,27.9],[-9.5,30.4],[-7.5,33.5],[-5.8,35.8],
];
// Madagascar — clockwise
const AF_POLY_MDG = [
  [44.0,-12.0],[50.5,-16.0],[50.5,-25.5],
  [46.5,-25.5],[43.5,-21.0],[43.0,-16.0],
];

// Precompute normalised polygon coords (avoid repeated arithmetic in the hot loop)
const AF_POLY_NORM     = AF_POLY.map(([lon, lat]) => [_afNx(lon), _afNy(lat)]);
const AF_POLY_MDG_NORM = AF_POLY_MDG.map(([lon, lat]) => [_afNx(lon), _afNy(lat)]);

function _afPolyContains(polyN, px, py) {
  let inside = false;
  for (let i = 0, j = polyN.length - 1; i < polyN.length; j = i++) {
    const [xi, yi] = polyN[i], [xj, yj] = polyN[j];
    if ((yi > py) !== (yj > py) &&
        px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const AF_MASK_BITS = new Uint8Array(AF_MASK_W * AF_MASK_H);
for (let r = 0; r < AF_MASK_H; r++) {
  const pny = (r + 0.5) / AF_MASK_H;
  for (let c = 0; c < AF_MASK_W; c++) {
    const pnx = (c + 0.5) / AF_MASK_W;
    AF_MASK_BITS[r * AF_MASK_W + c] =
      (_afPolyContains(AF_POLY_NORM, pnx, pny) ||
       _afPolyContains(AF_POLY_MDG_NORM, pnx, pny)) ? 1 : 0;
  }
}

function isLandAF(nx, ny) {
  const dx = (valueNoise(nx * 50, ny * 50) - 0.5) * 0.012;
  const dy = (valueNoise(nx * 50 + 10, ny * 50 + 10) - 0.5) * 0.012;
  let px = Math.floor((nx + dx) * AF_MASK_W);
  let py = Math.floor((ny + dy) * AF_MASK_H);
  px = Math.max(0, Math.min(AF_MASK_W - 1, px));
  py = Math.max(0, Math.min(AF_MASK_H - 1, py));
  return AF_MASK_BITS[py * AF_MASK_W + px] === 1;
}

// Africa mountain ranges — elliptical zones placed by real lon/lat.
// Coords in normalised AF map space (lon −20..55, lat 40..−38).
const AF_RANGES = [
  [_afNx(2),    _afNy(33),   0.093, 0.038],  // Atlas Mtns (Morocco/Algeria/Tunisia)
  [_afNx(17),   _afNy(22),   0.040, 0.038],  // Tibesti Massif (Chad)
  [_afNx(39),   _afNy(10),   0.053, 0.064],  // Ethiopian Highlands
  [_afNx(37),   _afNy(1.5),  0.040, 0.051],  // E African Rift / Kenya Highlands
  [_afNx(29.5), _afNy(-0.5), 0.027, 0.026],  // Ruwenzori / Congo Highlands
  [_afNx(29),   _afNy(-30),  0.040, 0.038],  // Drakensberg (South Africa)
  [_afNx(10),   _afNy(5),    0.040, 0.038],  // Cameroon Highlands
];

function terrainAF(nx, ny) {
  if (!isLandAF(nx, ny)) return TERRAIN.WATER;
  const n = valueNoise(nx * 25, ny * 25);
  let best = Infinity;
  for (const [cx, cy, rx, ry] of AF_RANGES) {
    const a = (nx - cx) / rx, b = (ny - cy) / ry;
    const d = a * a + b * b;
    if (d < best) best = d;
  }
  if (best < 1.0 + n * 0.4) return TERRAIN.MOUNTAINS;
  if (best < 2.6 + n * 0.8) return TERRAIN.HIGHLANDS;
  // Sahel fringe: scattered highlands just south of the Sahara
  if (n > 0.65 + 0.35 * outside(ny, 0.10, 0.32)) return TERRAIN.HIGHLANDS;
  return TERRAIN.PLAINS;
}

// --- Maps traced from real coastlines ---
// polygonMap() turns [lon, lat] coastline polygons into a terrain classifier:
// the polygons are filled (even-odd across all of them, so a polygon inside
// land — the Caspian — is a lake) into a land mask the first time the map is
// used, then read with the same noise-wobbled lookup as the other maps.
// `ranges` are mountain chains, `plateaus` high ground: ellipses
// [lon, lat, radius lon°, radius lat°].
function polygonMap({ lon: [lonMin, lonMax], lat: [latMax, latMin], maskW, maskH, polys, ranges = [], plateaus = [] }) {
  const toX = (lon) => (lon - lonMin) / (lonMax - lonMin);
  const toY = (lat) => (latMax - lat) / (latMax - latMin);
  const ell = (list) => list.map(([lo, la, rx, ry]) => [toX(lo), toY(la), rx / (lonMax - lonMin), ry / (latMax - latMin)]);
  const R = ell(ranges);
  const P = ell(plateaus);
  let mask = null;
  const rasterize = () => {
    // Scanline fill: per row, toggle at every edge crossing, then sweep.
    mask = new Uint8Array(maskW * maskH);
    const toggles = new Uint8Array(maskW + 1);
    const pts = polys.map((poly) => poly.map(([lo, la]) => [toX(lo) * maskW, toY(la) * maskH]));
    for (let r = 0; r < maskH; r++) {
      const y = r + 0.5;
      toggles.fill(0);
      for (const poly of pts) {
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i];
          const [xj, yj] = poly[j];
          if ((yi > y) === (yj > y)) continue;
          const x = xi + (y - yi) * (xj - xi) / (yj - yi);
          const c = Math.min(maskW, Math.max(0, Math.ceil(x - 0.5)));
          toggles[c] ^= 1;
        }
      }
      let inside = 0;
      for (let c = 0; c < maskW; c++) { inside ^= toggles[c]; mask[r * maskW + c] = inside; }
    }
  };
  const nearest = (list, nx, ny) => {
    let best = Infinity;
    for (const [cx, cy, rx, ry] of list) {
      const a = (nx - cx) / rx;
      const b = (ny - cy) / ry;
      if (a * a + b * b < best) best = a * a + b * b;
    }
    return best;
  };
  return (nx, ny) => {
    if (!mask) rasterize();
    const dx = (valueNoise(nx * 50, ny * 50) - 0.5) * 0.010;
    const dy = (valueNoise(nx * 50 + 10, ny * 50 + 10) - 0.5) * 0.010;
    const px = Math.max(0, Math.min(maskW - 1, Math.floor((nx + dx) * maskW)));
    const py = Math.max(0, Math.min(maskH - 1, Math.floor((ny + dy) * maskH)));
    if (!mask[py * maskW + px]) return TERRAIN.WATER;
    const n = valueNoise(nx * 25, ny * 25);
    const m = nearest(R, nx, ny);
    if (m < 1.0 + n * 0.4) return TERRAIN.MOUNTAINS;
    if (m < 2.6 + n * 0.8 || nearest(P, nx, ny) < 0.9 + n * 0.5) return TERRAIN.HIGHLANDS;
    return TERRAIN.PLAINS;
  };
}

// South America (lon −95..−25, lat 14..−57).
const terrainSA = polygonMap({
  lon: [-88, -30], lat: [14, -57], maskW: 360, maskH: 426,
  polys: [
    [[-77.9, 7.2], [-77.3, 8.7], [-75.5, 10.5], [-74.2, 11.2], [-71.9, 12.4], [-71.3, 11.4], [-70.2, 11.6],
      [-68.0, 10.5], [-66.0, 10.6], [-63.5, 10.7], [-61.9, 10.7], [-61.0, 8.6], [-59.0, 8.0], [-57.2, 6.0],
      [-55.0, 5.9], [-52.0, 4.9], [-51.0, 4.0], [-50.0, 1.8], [-50.0, 0.0], [-48.5, -1.0], [-44.5, -2.5],
      [-41.5, -2.9], [-38.5, -3.7], [-35.5, -5.2], [-34.8, -7.5], [-35.2, -9.5], [-37.0, -11.0], [-38.5, -13.0],
      [-39.0, -17.5], [-40.0, -20.0], [-41.0, -22.0], [-43.2, -23.0], [-45.0, -23.7], [-48.5, -26.0],
      [-48.6, -28.5], [-50.2, -30.5], [-52.1, -32.2], [-53.5, -33.8], [-54.9, -34.9], [-56.2, -34.9],
      [-58.4, -34.6], [-57.3, -36.0], [-57.5, -38.0], [-62.0, -39.0], [-62.3, -40.6], [-65.0, -41.0],
      [-64.0, -42.5], [-65.0, -45.0], [-67.5, -46.5], [-65.8, -47.8], [-68.0, -50.0], [-69.0, -51.6],
      [-68.4, -52.4], [-68.3, -53.0], [-65.2, -54.7], [-67.0, -55.3], [-70.0, -55.0], [-74.0, -52.5],
      [-75.5, -50.0], [-75.0, -47.0], [-74.0, -44.0], [-73.8, -41.8], [-73.5, -39.0], [-73.2, -37.0],
      [-72.0, -34.0], [-71.5, -32.0], [-71.6, -29.0], [-70.6, -26.0], [-70.4, -23.6], [-70.2, -20.2],
      [-70.3, -18.4], [-71.5, -17.3], [-75.0, -15.4], [-76.3, -13.5], [-77.1, -12.0], [-78.5, -9.5],
      [-79.9, -7.0], [-81.2, -5.9], [-81.3, -4.3], [-80.0, -3.0], [-80.9, -2.2], [-80.1, 0.0], [-79.0, 1.5],
      [-78.6, 2.5], [-77.5, 3.8], [-77.4, 6.5]],
    // Panama and Costa Rica
    [[-77.9, 7.2], [-79.5, 9.6], [-81.5, 9.0], [-83.6, 10.9], [-85.7, 11.1], [-85.9, 10.0], [-84.0, 9.0],
      [-82.9, 8.0], [-80.4, 7.3], [-79.0, 8.4], [-77.4, 6.5]],
    [[-61.3, -51.0], [-57.8, -51.3], [-58.3, -52.3], [-61.0, -52.0]], // Falklands
    [[-61.9, 10.8], [-60.9, 10.8], [-61.0, 10.0], [-61.9, 10.1]],     // Trinidad
  ],
  ranges: [
    [-73.5, 6, 2.0, 4.5], [-78.3, -1.5, 1.6, 3.0], [-76.0, -9.5, 1.8, 4.5], [-71.5, -15.5, 2.2, 2.5],
    [-68.5, -24.0, 1.6, 4.5], [-70.0, -32.5, 1.2, 4.0], [-71.4, -40.0, 1.0, 4.0], [-72.8, -47.5, 1.0, 4.0],
  ],
  plateaus: [
    [-67.5, -19.0, 3.0, 4.0], [-45.0, -18.0, 7.0, 6.0], [-62.0, 5.0, 5.0, 2.5], [-69.0, -46.0, 3.0, 4.0],
  ],
});

// Australia, New Guinea and the Indonesian islands (lon 108..158, lat 2..−45).
// New Zealand and the Pacific islands are left out: every landmass must be
// bridged to another, and theirs would be causeways across 1,500 km of sea.
const AU_NEW_GUINEA = [[131.0, -1.4], [134.1, -0.9], [135.3, -3.3], [137.9, -1.5], [141.0, -2.6], [144.5, -3.8],
  [146.0, -5.5], [147.8, -6.3], [147.2, -7.5], [148.3, -8.6], [150.2, -10.2], [149.0, -10.4], [147.2, -9.5],
  [146.0, -8.2], [144.5, -7.7], [143.0, -9.0], [141.0, -9.1], [139.0, -8.1], [138.0, -8.4], [137.8, -5.0],
  [136.0, -4.6], [134.2, -3.9], [132.8, -4.0], [132.0, -2.9]];
const terrainOC = polygonMap({
  lon: [108, 158], lat: [2, -45], maskW: 400, maskH: 376,
  polys: [
    [[142.5, -10.7], [143.5, -14.0], [145.3, -15.0], [145.8, -17.0], [146.3, -19.0], [148.8, -20.3],
      [150.8, -22.5], [153.0, -25.0], [153.6, -28.2], [153.0, -31.0], [151.3, -33.9], [150.0, -37.5],
      [147.5, -38.3], [146.3, -39.1], [144.9, -37.9], [143.5, -38.8], [140.8, -38.0], [139.5, -36.5],
      [138.5, -35.6], [137.8, -33.0], [135.9, -34.8], [134.2, -32.8], [131.0, -31.5], [126.0, -32.3],
      [123.6, -33.9], [119.9, -34.0], [117.9, -35.1], [115.0, -34.3], [115.7, -32.0], [114.9, -29.0],
      [113.4, -26.0], [113.7, -24.0], [114.1, -21.8], [116.7, -20.6], [118.6, -20.3], [121.0, -19.5],
      [122.2, -18.0], [123.6, -16.4], [125.0, -15.0], [126.5, -14.0], [128.1, -15.0], [129.5, -14.9],
      [130.3, -12.6], [132.5, -11.5], [135.0, -12.2], [136.7, -12.2], [136.0, -13.8], [135.5, -15.0],
      [137.5, -16.2], [139.5, -17.5], [140.8, -17.4], [141.5, -15.0], [141.6, -12.6]],
    [[144.6, -40.7], [148.3, -40.9], [148.3, -42.2], [147.0, -43.6], [145.9, -43.5], [145.2, -42.2]], // Tasmania
    [[136.6, -35.7], [138.1, -35.7], [137.6, -36.1], [136.6, -36.0]], // Kangaroo Island
    AU_NEW_GUINEA,
    [[109.0, 1.0], [109.6, -1.0], [110.3, -2.9], [111.7, -3.0], [113.0, -3.2], [114.6, -4.0], [116.0, -3.5],
      [116.5, -1.5], [117.5, 0.0], [118.0, 1.0]], // Borneo (south)
    [[109.0, -6.8], [110.4, -6.9], [111.5, -6.6], [112.7, -6.9], [114.4, -7.7], [114.6, -8.7], [113.0, -8.3],
      [111.0, -8.2], [109.0, -7.7]], // Java
    [[114.5, -8.1], [115.7, -8.4], [115.2, -8.85], [114.5, -8.6]], // Bali
    [[116.9, -8.5], [119.0, -8.1], [118.9, -8.8], [117.0, -9.0]], // Sumbawa
    [[119.8, -8.5], [123.0, -8.2], [122.8, -8.7], [120.0, -8.8]], // Flores
    [[123.5, -10.3], [124.5, -9.2], [127.3, -8.4], [126.0, -9.2], [124.5, -10.0]], // Timor
    [[119.4, -5.5], [119.4, -3.5], [118.8, -2.6], [119.8, 0.0], [120.0, 0.8], [121.0, 1.3], [123.0, 1.0],
      [125.0, 1.6], [124.3, 0.4], [121.5, 0.5], [120.5, -1.0], [121.5, -1.9], [123.3, -0.9], [122.0, -3.0],
      [122.5, -5.4], [121.0, -4.6], [120.4, -5.6]], // Sulawesi
    [[148.3, -5.5], [150.5, -5.4], [152.2, -4.2], [152.0, -5.6], [150.0, -6.3], [148.5, -6.0]], // New Britain
  ],
  ranges: [
    [148.3, -36.5, 1.8, 1.2], [139.0, -4.2, 3.5, 0.8], [144.0, -5.8, 2.5, 0.9], [146.4, -42.0, 0.9, 0.7],
    [115.5, -0.8, 1.3, 1.3], [121.0, -2.0, 1.0, 1.5],
  ],
  plateaus: [
    [146.0, -18.5, 1.5, 4.0], [149.0, -26.5, 1.5, 4.0], [150.5, -32.0, 1.2, 3.0], [133.5, -23.7, 3.0, 0.8],
    [118.0, -22.5, 2.2, 1.0], [126.0, -17.0, 1.8, 1.4], [130.5, -26.0, 3.0, 1.0],
  ],
});

// Asia, from the Caucasus and Arabia to Japan and New Guinea (lon 38..150, lat 70..−10).
const terrainAS = polygonMap({
  lon: [38, 150], lat: [70, -10], maskW: 560, maskH: 400,
  polys: [
    // Mainland, from the west edge along the Arctic, down the Pacific coast, around
    // South and Southeast Asia, Arabia and back by the Black Sea.
    [[20, 72], [40.5, 67.8], [44, 68.5], [48, 67.7], [53, 68.6], [57, 68.6], [60, 69.8], [66.5, 70.5], [68, 73],
      [72, 73], [72.5, 68.5], [74.5, 72.2], [76, 71], [78, 72.5], [80, 73.5], [100, 77], [113, 75], [114, 73.5],
      [120, 73], [127, 73.5], [129, 72], [132, 71.6], [140, 72.5], [150, 71.5], [160, 70.5], [170, 70], [180, 66],
      [165, 62], [156, 61.5], [151, 59.6], [143, 59.4], [140.5, 57], [137.5, 54.6], [140.5, 53.5], [141.4, 52],
      [140.5, 48.5], [138.5, 46.5], [135.5, 43.6], [133, 42.8], [131.5, 43], [130.6, 42.4], [129.7, 40.8],
      [128.5, 39.9], [127.5, 39.2], [128.3, 38.6], [129.4, 36.4], [129.3, 35.2], [127.5, 34.6], [126.3, 34.5],
      [126.5, 36], [126.6, 37.4], [125.2, 37.7], [125.3, 39.5], [124.3, 39.9], [122.2, 39.4], [121.2, 38.8],
      [122.2, 40.4], [121, 40.9], [119, 39.3], [117.7, 38.9], [118.8, 37.5], [119.5, 37.1], [120.7, 37.8],
      [122.6, 37.4], [120.3, 36], [119.2, 34.6], [120.8, 32.5], [121.9, 31.0], [121.9, 29.9], [121.4, 28.2],
      [120.2, 26.6], [119.5, 25.4], [117.2, 23.6], [114.2, 22.3], [111.7, 21.6], [110.5, 20.3], [109.7, 21.5],
      [108.5, 21.6], [106.7, 20.7], [105.8, 19.0], [106.5, 17.5], [108.2, 16.0], [109.2, 13.8], [109.2, 11.6],
      [107.0, 10.4], [104.9, 8.6], [104.5, 10.4], [103.0, 11.5], [102.3, 12.2], [100.9, 12.7], [100.0, 13.4],
      [99.9, 12.0], [99.3, 10.3], [100.3, 8.4], [101.3, 6.8], [102.3, 6.1], [103.4, 4.6], [103.4, 2.9],
      [104.2, 1.4], [103.4, 1.3], [101.3, 2.8], [100.4, 4.5], [100.3, 6.5], [99.7, 6.9], [98.4, 8.3],
      [98.6, 10.0], [98.6, 12.5], [97.6, 16.5], [96.5, 16.6], [95.0, 15.8], [94.3, 16.2], [94.6, 18.8],
      [93.4, 19.9], [92.3, 20.7], [91.8, 22.4], [90.5, 22.0], [89.0, 21.6], [87.0, 21.5], [86.9, 20.3],
      [85.0, 19.2], [82.3, 16.6], [80.3, 15.5], [80.3, 13.1], [79.8, 10.3], [77.5, 8.1], [76.5, 9.5],
      [75.4, 11.9], [74.4, 14.6], [73.0, 18.0], [72.8, 19.0], [72.6, 21.3], [72.0, 21.7], [70.0, 20.8],
      [68.9, 22.3], [70.2, 22.6], [68.6, 23.6], [67.2, 24.8], [64.5, 25.2], [61.6, 25.2], [58.8, 25.5],
      [57.3, 27.1], [56.3, 27.1], [54.0, 26.7], [51.5, 27.8], [50.2, 29.8], [48.5, 30.0], [47.9, 29.0],
      [48.6, 28.0], [50.1, 26.5], [50.8, 25.5], [51.2, 26.1], [51.6, 25.0], [52.5, 24.2], [54.4, 24.4],
      [55.3, 25.3], [56.4, 26.4], [56.3, 24.5], [58.6, 23.6], [59.8, 22.4], [58.6, 20.5], [57.7, 18.9],
      [55.0, 17.0], [52.2, 15.6], [48.7, 14.0], [45.0, 12.8], [43.5, 12.7], [42.8, 15.0], [42.7, 16.4],
      [41.6, 18.0], [39.2, 21.5], [38.1, 24.0], [36.5, 26.0], [34.9, 29.5], [34.2, 31.3], [35.0, 33.0],
      [35.9, 36.0], [36.2, 36.6], [33.5, 36.2], [30, 36.3], [26, 40.3], [29, 41.2], [31.5, 41.2], [35, 42],
      [38, 41], [41.5, 41.5], [41.6, 42.5], [40.0, 43.4], [37.5, 44.8], [36.0, 45.5], [30.0, 46.5], [20, 46]],
    // Lakes (inside the mainland, so the even-odd fill makes them water)
    [[46.7, 44.5], [47.5, 45.6], [49.2, 46.4], [51.2, 47.0], [53.0, 46.8], [53.2, 45.3], [51.3, 44.5],
      [52.7, 42.0], [54.0, 40.8], [53.9, 38.9], [53.9, 37.2], [51.5, 36.8], [49.0, 37.6], [48.9, 38.5],
      [49.5, 40.2], [48.6, 41.8], [47.5, 43.0]], // Caspian Sea
    [[103.8, 51.6], [105.0, 51.8], [107.0, 52.5], [108.5, 53.5], [109.8, 55.6], [109.2, 55.9], [107.0, 53.6],
      [105.5, 52.6], [104.0, 52.0]], // Lake Baikal
    // Africa's horn, at the west edge
    [[38.0, 15.6], [43.0, 11.5], [44.9, 8.2], [46.9, 7.5], [50.2, 11.5], [51.4, 11.5], [50.5, 10.4], [49.5, 5.0],
      [44.5, -1.5], [40.5, -10.0], [40, -14], [20, -14], [20, 20], [36.5, 22.0], [36.5, 18.5]],
    // Islands
    [[130.9, 34.0], [132.5, 34.3], [135.0, 34.6], [135.3, 33.8], [136.8, 34.3], [138.8, 34.6], [139.8, 35.0],
      [140.8, 35.7], [140.9, 37.5], [141.5, 38.3], [141.9, 39.8], [141.4, 41.4], [140.0, 40.6], [140.0, 39.5],
      [139.7, 38.2], [138.5, 37.4], [137.3, 36.8], [136.0, 36.2], [135.5, 35.6], [133.0, 35.5], [131.5, 34.7]], // Honshu
    [[129.8, 33.7], [131.0, 33.9], [131.8, 32.0], [131.0, 31.2], [130.2, 31.3], [129.7, 32.7]], // Kyushu
    [[132.0, 33.9], [134.6, 34.2], [134.7, 33.8], [133.0, 32.8]], // Shikoku
    [[140.0, 41.4], [141.2, 41.8], [143.3, 42.0], [145.5, 43.3], [145.2, 44.3], [141.9, 45.5], [141.4, 43.4],
      [140.4, 43.3], [140.0, 42.3]], // Hokkaido
    [[142.0, 46.0], [143.4, 46.8], [143.2, 49.3], [143.0, 51.7], [143.2, 54.2], [142.6, 54.3], [142.2, 51.5],
      [141.8, 48.5]], // Sakhalin
    [[120.1, 23.0], [121.0, 25.2], [121.9, 25.0], [121.6, 23.4], [120.9, 22.0], [120.3, 22.5]], // Taiwan
    [[108.6, 19.2], [110.0, 20.1], [111.0, 19.6], [110.0, 18.3], [108.7, 18.5]], // Hainan
    [[79.9, 9.8], [80.3, 9.8], [81.9, 7.5], [81.4, 6.2], [80.1, 6.0], [79.8, 7.0]], // Sri Lanka
    [[119.8, 16.3], [120.6, 18.5], [122.3, 18.4], [121.9, 16.0], [121.6, 14.2], [124.0, 13.0], [123.9, 12.4],
      [122.6, 13.5], [120.6, 13.8], [120.0, 14.8]], // Luzon
    [[124.3, 12.5], [125.8, 11.2], [125.2, 10.0], [124.4, 10.7]], // Samar-Leyte
    [[122.0, 11.8], [123.2, 11.0], [123.2, 9.2], [122.5, 9.6], [122.0, 10.5]], // Panay-Negros
    [[122.0, 7.0], [123.6, 7.8], [123.8, 8.6], [125.5, 9.8], [126.6, 7.3], [126.2, 6.3], [125.3, 5.6],
      [124.0, 6.3]], // Mindanao
    [[95.3, 5.6], [97.5, 5.2], [98.7, 3.8], [100.6, 2.0], [103.8, -1.0], [104.8, -2.5], [106.0, -3.2],
      [105.8, -5.8], [104.5, -5.9], [102.3, -4.0], [100.4, -1.0], [98.8, 1.7], [96.0, 4.4]], // Sumatra
    [[105.2, -6.8], [106.0, -5.9], [108.3, -6.3], [110.4, -6.9], [112.7, -6.9], [114.4, -7.7], [114.6, -8.7],
      [111, -8.2], [108, -7.8], [106.4, -7.4]], // Java
    [[109.0, 1.5], [109.6, -1.0], [110.3, -2.9], [111.7, -3.0], [113.0, -3.2], [114.6, -4.0], [116.0, -3.5],
      [116.5, -1.5], [117.5, 0.0], [118.0, 1.0], [119.0, 1.0], [118.4, 4.5], [119.3, 5.3], [117.5, 6.9],
      [116.5, 6.8], [115.3, 5.3], [113.9, 4.6], [111.5, 2.6], [109.7, 1.9]], // Borneo
    [[119.4, -5.5], [119.4, -3.5], [118.8, -2.6], [119.8, 0.0], [120.0, 0.8], [121.0, 1.3], [123.0, 1.0],
      [125.0, 1.6], [124.3, 0.4], [121.5, 0.5], [120.5, -1.0], [121.5, -1.9], [123.3, -0.9], [122.0, -3.0],
      [122.5, -5.4], [121.0, -4.6], [120.4, -5.6]], // Sulawesi
    [[123.5, -10.3], [124.5, -9.2], [127.3, -8.4], [126.0, -9.2], [124.5, -10.0]], // Timor
    [[127.5, 1.9], [128.6, 2.1], [128.0, 0.7], [128.9, 0.2], [128.2, -0.8], [127.6, 0.2]], // Halmahera
    AU_NEW_GUINEA,
    [[142.5, -10.7], [143.5, -14.0], [141.6, -12.6]], // Cape York tip
  ],
  ranges: [
    [76.5, 35.5, 4.0, 1.5], [81.0, 30.8, 3.0, 1.1], [86.0, 28.2, 4.0, 1.0], [92.5, 28.0, 3.0, 1.0],
    [80.0, 42.0, 7.0, 1.5], [89.0, 49.0, 4.0, 2.0], [51.0, 31.5, 3.0, 1.5], [56.0, 28.5, 2.0, 1.0],
    [70.0, 35.5, 3.0, 1.2], [44.5, 42.8, 3.0, 0.8], [59.5, 60.0, 1.2, 8.0], [99.0, 28.0, 2.0, 3.0],
    [74.5, 15.0, 0.7, 4.0], [130.0, 66.0, 3.0, 4.0], [125.0, 56.0, 8.0, 1.2], [137.5, 36.0, 1.0, 1.2],
    [121.0, 23.6, 0.4, 1.0], [101.0, -1.5, 1.0, 3.0], [116.0, 4.0, 1.5, 1.5], [139.0, -4.2, 3.5, 0.8],
    [44.0, 15.0, 1.5, 2.0],
  ],
  plateaus: [
    [88.0, 33.0, 11.0, 3.5], [55.0, 32.0, 7.0, 3.5], [103.0, 46.0, 9.0, 3.5], [77.0, 18.0, 4.0, 4.0],
    [102.0, 64.0, 8.0, 4.0], [128.0, 38.5, 0.9, 2.0], [40.0, 9.0, 2.5, 4.0], [100.0, 20.0, 4.0, 3.0],
  ],
});

// --- Pangaea: a procedural supercontinent ---
// Seeded fractal noise (fixed per map id, so client and server agree): one big
// continent with inland seas, gulfs and offshore islands, ridged-noise
// mountain chains and hill country around them.
function fbm(x, y, octaves) {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) { v += valueNoise(x * f + o * 17.3, y * f + o * 31.7) * amp; f *= 2; amp *= 0.5; }
  return v / (1 - Math.pow(0.5, octaves));
}
function terrainPangaea(nx, ny) {
  // Land falls off toward the map edge (an ellipse filling the frame).
  const ex = (nx - 0.5) / 0.47;
  const ey = (ny - 0.5) / 0.45;
  const edge = Math.sqrt(ex * ex + ey * ey);
  const h = fbm(nx * 5 + 3.1, ny * 3 + 7.7, 5) - 0.75 * Math.max(0, edge - 0.55) - 0.12 * edge;
  if (h < 0.16) return TERRAIN.WATER;
  const ridge = 1 - Math.abs(fbm(nx * 4 + 11.0, ny * 2.6 + 2.0, 4) * 2 - 1);
  if (ridge > 0.9 && h > 0.2) return TERRAIN.MOUNTAINS;
  if (ridge > 0.8 || h > 0.42) return TERRAIN.HIGHLANDS;
  return TERRAIN.PLAINS;
}

// --- Map registry ---
// The set of playable maps. The map id IS the room's `preset` (single source of
// truth, decided server-side and echoed to the client via init-config).
export const MAP_POOL = ['north_america', 'europe', 'africa', 'south_america', 'asia', 'oceania', 'pangaea'];
export const MAP_LABELS = {
  north_america: 'North America', europe: 'Europe', africa: 'Africa', south_america: 'South America',
  asia: 'Asia', oceania: 'Oceania', pangaea: 'Pangaea',
};
export function isValidMapId(id) { return MAP_POOL.includes(id); }
// Mega Battles draw from the land-richest maps (about half the map or more is
// land; South America and Oceania are ~35%): 64 empires need the room.
export const MEGA_MAP_POOL = ['north_america', 'europe', 'africa', 'asia', 'pangaea'];
export function randomMapId(size = 'standard') {
  const pool = size === 'mega' ? MEGA_MAP_POOL : MAP_POOL;
  return pool[(Math.random() * pool.length) | 0];
}

// Pure terrain classifier. Returns a TERRAIN value for any point in [0,1]^2.
// `mapId` selects the landmass; an unknown id falls back to North America so a
// bad preset can never crash terrain generation (which would kill the room).
export function terrainAt(nx, ny, mapId = 'north_america') {
  if (mapId === 'europe') return terrainEU(nx, ny);
  if (mapId === 'africa') return terrainAF(nx, ny);
  if (mapId === 'south_america') return terrainSA(nx, ny);
  if (mapId === 'asia') return terrainAS(nx, ny);
  if (mapId === 'oceania') return terrainOC(nx, ny);
  if (mapId === 'pangaea') return terrainPangaea(nx, ny);
  return terrainNA(nx, ny);
}

// --- Island bridging ---
// Any land mass fully enclosed by water is unreachable by ground troops — a
// player who spawns there could only be hit by missiles, making them nearly
// invincible. To prevent that, we carve a tiny neutral-plains land bridge across
// the shortest water gap from each island to its nearest neighbour, turning each
// island into an attackable (but defensible, chokepoint) peninsula and linking
// every landmass into one. The map is fully static, so the exact set of cells to
// carve is identical every game — we compute it once (lazily) and cache it.
const BRIDGE_HALF_WIDTH = 2; // brush half-width → (2*HW+1)=5-cell-wide bridges
// Land components smaller than this are coastline-noise speckles, not real
// islands — they are erased (set to water) rather than bridged. Kept below the
// smallest real island on any map (North America's ~745-cell island) so genuine
// islands are always bridged, never deleted.
const MIN_ISLAND_SIZE = 300;

// 8-connected flood-fill labeling of the land grid. Returns { comp, sizes, nc }.
function labelComponents(land) {
  const comp = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  const sizes = [];
  let nc = 0;
  for (let s = 0; s < N; s++) {
    if (!land[s] || comp[s] !== -1) continue;
    const id = nc++;
    let top = 0;
    let sz = 0;
    stack[top++] = s;
    comp[s] = id;
    while (top) {
      const c = stack[--top];
      sz++;
      const cx = c % W;
      const cy = (c / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const X = cx + dx, Y = cy + dy;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const ni = Y * W + X;
          if (land[ni] && comp[ni] === -1) { comp[ni] = id; stack[top++] = ni; }
        }
      }
    }
    sizes.push(sz);
  }
  return { comp, sizes, nc };
}

// Compute (once, per map) the cell-index lists so no land mass is sealed off by
// water: `bridges` (water cells to turn to plains) and `erase` (tiny noise-speckle
// land cells to turn to water). Each landmass is connected to its NEAREST other
// landmass (not just the biggest), so island chains — e.g. Ireland → Britain →
// mainland — link with short, sensible causeways instead of one long crossing.
// Deterministic — identical on browser and Node V8, so client and server carve
// the exact same map.
function computeBridgeCarveIndices(land) {
  // `land` (1 = land, 0 = water) is updated in place: speckles erased,
  // bridges carved.

  // Pass 1: erase sub-threshold speckles (→ water) so they neither bridge nor
  // obstruct later BFS. Sub-threshold blobs are coastline noise, not real islands.
  const erase = [];
  {
    const { comp, sizes, nc } = labelComponents(land);
    if (nc <= 1) return { bridges: new Int32Array(0), erase: new Int32Array(0) };
    let mainId = 0;
    for (let c = 1; c < nc; c++) if (sizes[c] > sizes[mainId]) mainId = c;
    const eraseComp = new Uint8Array(nc);
    let any = false;
    for (let c = 0; c < nc; c++) if (c !== mainId && sizes[c] < MIN_ISLAND_SIZE) { eraseComp[c] = 1; any = true; }
    if (any) {
      for (let s = 0; s < N; s++) {
        const c = comp[s];
        if (c >= 0 && eraseComp[c]) { erase.push(s); land[s] = 0; }
      }
    }
  }

  // Pass 2: connect each component to its nearest neighbour. Every round, each
  // not-yet-connected component runs a water-only BFS to the closest land cell of
  // a component in a *different* union-find set and carves that gap; the carved
  // cells are written back into `land`, so the next round's relabel sees merged
  // components. Chains collapse in a few rounds; iterate until one component.
  const bridges = [];
  const parent = new Int32Array(N);
  const queue = new Int32Array(N);
  for (let pass = 0; pass < 16; pass++) {
    const { comp, sizes, nc } = labelComponents(land);
    if (nc <= 1) break;
    const uf = new Int32Array(nc);
    for (let k = 0; k < nc; k++) uf[k] = k;
    const find = (x) => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
    let mainId = 0;
    for (let c = 1; c < nc; c++) if (sizes[c] > sizes[mainId]) mainId = c;
    // Connect smaller components first (shorter, tidier causeways).
    const order = [];
    for (let c = 0; c < nc; c++) if (c !== mainId) order.push(c);
    order.sort((a, b) => sizes[a] - sizes[b]);

    for (const cid of order) {
      if (find(cid) === find(mainId)) continue;
      parent.fill(-1);
      let head = 0, tail = 0;
      for (let s = 0; s < N; s++) {
        if (comp[s] === cid) { parent[s] = s; queue[tail++] = s; }
      }
      // BFS through water until we touch land of a component in a different set.
      let contact = -1, target = -1;
      bfs: while (head < tail) {
        const c = queue[head++];
        const cx = c % W;
        const cy = (c / W) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const X = cx + dx, Y = cy + dy;
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            const ni = Y * W + X;
            if (land[ni]) {
              const oc = comp[ni];
              if (oc !== cid && find(oc) !== find(cid)) { contact = c; target = oc; break bfs; }
              continue; // same set / own coast — obstacle
            }
            if (parent[ni] === -1) { parent[ni] = c; queue[tail++] = ni; }
          }
        }
      }
      if (contact === -1) continue; // unreachable (shouldn't happen)
      uf[find(cid)] = find(target);

      // Trace the gap back to the island and carve a widened bridge into `land`.
      let p = contact;
      while (p !== parent[p]) {
        const cx = p % W;
        const cy = (p / W) | 0;
        for (let dy = -BRIDGE_HALF_WIDTH; dy <= BRIDGE_HALF_WIDTH; dy++) {
          for (let dx = -BRIDGE_HALF_WIDTH; dx <= BRIDGE_HALF_WIDTH; dx++) {
            const X = cx + dx, Y = cy + dy;
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            const ni = Y * W + X;
            if (!land[ni]) { bridges.push(ni); land[ni] = 1; }
          }
        }
        p = parent[p];
      }
    }
  }

  return { bridges: Int32Array.from(bridges), erase: Int32Array.from(erase) };
}

// The finished terrain of a map at a size, one code per cell (TERRAIN):
// base terrain from the map's classifier, noise speckles erased, island
// bridges carved, then forests, rivers, gold deposits and ruins. Deterministic
// (same bytes in the browser and in Node). Takes ~1–3 s, so callers keep the
// result: a small cache here, and the server/browser run it off the main
// thread (server/game/terrainCache.js, src/js/terrainWorker.js).
const codesCache = new Map();
const CODES_CACHE_MAX = 3;

export function terrainCodes(mapId = 'north_america', width = MAP_WIDTH, height = MAP_HEIGHT) {
  useSize(width, height);
  const map = isValidMapId(mapId) ? mapId : 'north_america';
  const key = `${map}@${W}x${H}`;
  const hit = codesCache.get(key);
  if (hit) { codesCache.delete(key); codesCache.set(key, hit); return hit; }

  const codes = new Uint8Array(N);
  const land = new Uint8Array(N);
  let i = 0;
  for (let y = 0; y < H; y++) {
    const ny = y / H;
    for (let x = 0; x < W; x++) {
      const t = terrainAt(x / W, ny, map);
      codes[i] = t;
      land[i++] = t === TERRAIN.WATER ? 0 : 1;
    }
  }
  // Erase noise speckles (→ water), carve island bridges (→ plains) so no
  // land mass is sealed off by water.
  const carve = computeBridgeCarveIndices(land);
  for (const idx of carve.erase) codes[idx] = TERRAIN.WATER;
  for (const idx of carve.bridges) codes[idx] = TERRAIN.PLAINS;
  addFeatures(codes, key);

  codesCache.set(key, codes);
  while (codesCache.size > CODES_CACHE_MAX) codesCache.delete(codesCache.keys().next().value);
  return codes;
}

// Write terrain codes into the terrain bits of a packed cell array (u16 per
// cell), keeping the owner/defense/building bits.
export function writeTerrainBits(cells, codes) {
  for (let i = 0; i < codes.length; i++) {
    cells[i] = (cells[i] & ~CELL_TERRAIN_MASK) | ((codes[i] << CELL_TERRAIN_SHIFT) & CELL_TERRAIN_MASK);
  }
}

// Write the static terrain into the packed cell buffer in place. `memory` is
// the WASM Memory (or any { buffer }), `ptr` the cell_data byte offset.
export function generateTerrain(memory, ptr, mapId = 'north_america', width = MAP_WIDTH, height = MAP_HEIGHT) {
  const codes = terrainCodes(mapId, width, height);
  writeTerrainBits(new Uint16Array(memory.buffer, ptr, codes.length), codes);
}

// ── Terrain features ────────────────────────────────────────────────────────
// Deterministic from the map id and size (seeded PRNG + value noise), so the
// browser and the server add exactly the same features. Sized to the land:
// about one river per 160k land cells, a gold deposit per 110k, ruins per 250k.
function seededRandom(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { // mulberry32
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// codes: the base terrain (after bridging); features are written into it.
function addFeatures(codes, key) {
  const rand = seededRandom(key);
  const terr = codes.slice();
  let land = 0;
  for (let i = 0; i < N; i++) if (terr[i] !== TERRAIN.WATER) land++;
  const out = new Uint8Array(N); // 0 = no feature, else the feature's code
  const ox = rand() * 1000;
  const oy = rand() * 1000;

  // Forests: noise blobs over plains and highlands (~12% of that land).
  const fs = 1 / 45;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (terr[i] !== TERRAIN.PLAINS && terr[i] !== TERRAIN.HIGHLANDS) continue;
      const n = valueNoise(x * fs + ox, y * fs + oy) * 0.7 + valueNoise(x * fs * 3 + oy, y * fs * 3 + ox) * 0.3;
      if (n > 0.68) out[i] = TERRAIN.FOREST;
    }
  }

  // Distance to the sea over land (8-connected BFS) — rivers run down it.
  const dist = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < N; i++) if (terr[i] === TERRAIN.WATER) { dist[i] = 0; queue[qt++] = i; }
  while (qh < qt) {
    const c = queue[qh++];
    const cx = c % W;
    const cy = (c / W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const X = cx + dx;
        const Y = cy + dy;
        if ((!dx && !dy) || X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const ni = Y * W + X;
        if (dist[ni] === -1) { dist[ni] = dist[c] + 1; queue[qt++] = ni; }
      }
    }
  }

  // Spots spread over the land: best-candidate sampling, `minDist` from the
  // coast, on land that `ok` accepts, away from the spots already taken.
  const taken = [];
  const spreadSpots = (count, minDist, ok) => {
    const spots = [];
    for (let n = 0; n < count; n++) {
      let best = null;
      let bestD = -1;
      for (let k = 0; k < 60; k++) {
        const i = Math.floor(rand() * N);
        if (dist[i] < minDist || !ok(i)) continue;
        const x = i % W;
        const y = (i / W) | 0;
        let d = Infinity;
        for (const p of taken) d = Math.min(d, (p.x - x) ** 2 + (p.y - y) ** 2);
        if (d > bestD) { bestD = d; best = { x, y, i }; }
      }
      if (best) { taken.push(best); spots.push(best); }
    }
    return spots;
  };
  // A rough blob of `radius` around a spot.
  const blob = (spot, radius, code, ok) => {
    const r2 = radius * radius;
    for (let dy = -radius - 3; dy <= radius + 3; dy++) {
      for (let dx = -radius - 3; dx <= radius + 3; dx++) {
        const X = spot.x + dx;
        const Y = spot.y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const i = Y * W + X;
        const wobble = 1 + 0.35 * (valueNoise(X * 0.15 + ox, Y * 0.15 + oy) - 0.5) * 2;
        if (dx * dx + dy * dy <= r2 * wobble && ok(i)) out[i] = code;
      }
    }
  };
  const flat = (i) => terr[i] === TERRAIN.PLAINS || terr[i] === TERRAIN.HIGHLANDS;

  // Rivers: from inland (preferably high ground) down the distance field to
  // the sea, meandering; two cells wide.
  const rivers = Math.max(3, Math.round(land / 160000));
  const sources = spreadSpots(rivers, 70, (i) => terr[i] !== TERRAIN.WATER);
  const onPath = new Uint8Array(N); // cells a river already ran through (no loops)
  for (const src of sources) {
    let c = src.i;
    let dirX = 0;
    let dirY = 0;
    for (let step = 0; step < 4000 && dist[c] > 0; step++) {
      onPath[c] = 1;
      const cx = c % W;
      const cy = (c / W) | 0;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const X = cx + dx;
          const Y = cy + dy;
          if (X < W && Y < H && terr[Y * W + X] !== TERRAIN.WATER) out[Y * W + X] = TERRAIN.RIVER;
        }
      }
      // Next cell: downhill (or level), keeping some of the previous
      // direction plus noise, so the course meanders instead of zig-zagging.
      const angle = valueNoise(cx * 0.02 + ox, cy * 0.02 + oy) * Math.PI * 4;
      const flowX = Math.cos(angle);
      const flowY = Math.sin(angle);
      let best = -1;
      let bestScore = -Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const X = cx + dx;
          const Y = cy + dy;
          if ((!dx && !dy) || X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const ni = Y * W + X;
          const drop = dist[c] - dist[ni];
          if (drop < 0 || onPath[ni]) continue;
          // A smooth flow field (a direction per spot, from noise) the river
          // leans along: coherent bends instead of the straight diagonals of a
          // pure distance descent. Never uphill, so it still reaches the sea.
          const score = drop * 0.25 + (dx * flowX + dy * flowY) * 1.0 + (dx * dirX + dy * dirY) * 0.3 + rand() * 0.35;
          if (score > bestScore) { bestScore = score; best = ni; }
        }
      }
      if (best < 0) break;
      dirX = (best % W) - cx;
      dirY = ((best / W) | 0) - cy;
      c = best;
    }
  }

  // Gold deposits and ruins, spread over flat land away from the coast.
  const scale = W / 1920;
  for (const spot of spreadSpots(Math.max(4, Math.round(land / 110000)), 25, flat)) {
    blob(spot, Math.round(9 * scale), TERRAIN.GOLD, (i) => flat(i) && out[i] !== TERRAIN.RIVER);
  }
  for (const spot of spreadSpots(Math.max(2, Math.round(land / 250000)), 25, flat)) {
    blob(spot, Math.round(7 * scale), TERRAIN.RUINS, (i) => flat(i) && out[i] !== TERRAIN.RIVER);
  }

  for (let i = 0; i < N; i++) if (out[i]) codes[i] = out[i];
}

// Compute every map of the pool at a size ahead of time (blocks; meant for a
// background thread — src/js/terrainWorker.js, server/game/terrainWarmWorker.js).
export function warmMapCache(width = MAP_WIDTH, height = MAP_HEIGHT) {
  for (const mapId of MAP_POOL) terrainCodes(mapId, width, height);
}
