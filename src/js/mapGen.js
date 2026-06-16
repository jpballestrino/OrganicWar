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

import { MAP_WIDTH, MAP_HEIGHT, TOTAL_CELLS, CELL_TERRAIN_SHIFT, CELL_TERRAIN_MASK } from './constants.js';

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
  if (ny < 0.20 && n > 0.5) return TERRAIN.HIGHLANDS;
  return TERRAIN.PLAINS;
}

// --- Map registry ---
// The set of playable maps. The map id IS the room's `preset` (single source of
// truth, decided server-side and echoed to the client via init-config).
export const MAP_POOL = ['north_america', 'europe'];
export const MAP_LABELS = { north_america: 'North America', europe: 'Europe' };
export function isValidMapId(id) { return MAP_POOL.includes(id); }
export function randomMapId() { return MAP_POOL[(Math.random() * MAP_POOL.length) | 0]; }

// Pure terrain classifier. Returns a TERRAIN value for any point in [0,1]^2.
// `mapId` selects the landmass; an unknown id falls back to North America so a
// bad preset can never crash terrain generation (which would kill the room).
export function terrainAt(nx, ny, mapId = 'north_america') {
  return mapId === 'europe' ? terrainEU(nx, ny) : terrainNA(nx, ny);
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

// Per-map cache of the { bridges, erase } cell-index lists. Each map is static,
// so this is computed once per map id per process.
const bridgeCache = new Map();

// 8-connected flood-fill labeling of the land grid. Returns { comp, sizes, nc }.
function labelComponents(land) {
  const comp = new Int32Array(TOTAL_CELLS).fill(-1);
  const stack = new Int32Array(TOTAL_CELLS);
  const sizes = [];
  let nc = 0;
  for (let s = 0; s < TOTAL_CELLS; s++) {
    if (!land[s] || comp[s] !== -1) continue;
    const id = nc++;
    let top = 0;
    let sz = 0;
    stack[top++] = s;
    comp[s] = id;
    while (top) {
      const c = stack[--top];
      sz++;
      const cx = c % MAP_WIDTH;
      const cy = (c / MAP_WIDTH) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const X = cx + dx, Y = cy + dy;
          if (X < 0 || Y < 0 || X >= MAP_WIDTH || Y >= MAP_HEIGHT) continue;
          const ni = Y * MAP_WIDTH + X;
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
function computeBridgeCarveIndices(mapId) {
  // Build the land/water grid straight from the terrain classifier (the same
  // function the base generation loop uses), so no packed-bit read-back is needed.
  const land = new Uint8Array(TOTAL_CELLS);
  let i = 0;
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const ny = y / MAP_HEIGHT;
    for (let x = 0; x < MAP_WIDTH; x++) {
      land[i++] = terrainAt(x / MAP_WIDTH, ny, mapId) === TERRAIN.WATER ? 0 : 1;
    }
  }

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
      for (let s = 0; s < TOTAL_CELLS; s++) {
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
  const parent = new Int32Array(TOTAL_CELLS);
  const queue = new Int32Array(TOTAL_CELLS);
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
      for (let s = 0; s < TOTAL_CELLS; s++) {
        if (comp[s] === cid) { parent[s] = s; queue[tail++] = s; }
      }
      // BFS through water until we touch land of a component in a different set.
      let contact = -1, target = -1;
      bfs: while (head < tail) {
        const c = queue[head++];
        const cx = c % MAP_WIDTH;
        const cy = (c / MAP_WIDTH) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const X = cx + dx, Y = cy + dy;
            if (X < 0 || Y < 0 || X >= MAP_WIDTH || Y >= MAP_HEIGHT) continue;
            const ni = Y * MAP_WIDTH + X;
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
        const cx = p % MAP_WIDTH;
        const cy = (p / MAP_WIDTH) | 0;
        for (let dy = -BRIDGE_HALF_WIDTH; dy <= BRIDGE_HALF_WIDTH; dy++) {
          for (let dx = -BRIDGE_HALF_WIDTH; dx <= BRIDGE_HALF_WIDTH; dx++) {
            const X = cx + dx, Y = cy + dy;
            if (X < 0 || Y < 0 || X >= MAP_WIDTH || Y >= MAP_HEIGHT) continue;
            const ni = Y * MAP_WIDTH + X;
            if (!land[ni]) { bridges.push(ni); land[ni] = 1; }
          }
        }
        p = parent[p];
      }
    }
  }

  return { bridges: Int32Array.from(bridges), erase: Int32Array.from(erase) };
}

// Write the static terrain into the packed cell buffer in place. `memory` is the
// WASM Memory, `ptr` the cell_data pointer (TOTAL_CELLS u16s). Only the terrain
// bits are touched; owner/defense/building bits are preserved. Called once at
// startup (cell_data starts all-zero, so this effectively seeds the map).
export function generateTerrain(memory, ptr, mapId = 'north_america') {
  const map = isValidMapId(mapId) ? mapId : 'north_america';
  const cells = new Uint16Array(memory.buffer, ptr, TOTAL_CELLS);
  let i = 0;
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const ny = y / MAP_HEIGHT;
    for (let x = 0; x < MAP_WIDTH; x++) {
      const t = (terrainAt(x / MAP_WIDTH, ny, map) << CELL_TERRAIN_SHIFT) & CELL_TERRAIN_MASK;
      cells[i] = (cells[i] & ~CELL_TERRAIN_MASK) | t;
      i++;
    }
  }

  // Erase noise speckles (→ water) then carve island bridges (→ plains) so no
  // land mass is sealed off by water. Cached per map after the first call.
  let carve = bridgeCache.get(map);
  if (!carve) { carve = computeBridgeCarveIndices(map); bridgeCache.set(map, carve); }
  const plains = (TERRAIN.PLAINS << CELL_TERRAIN_SHIFT) & CELL_TERRAIN_MASK;
  const water = (TERRAIN.WATER << CELL_TERRAIN_SHIFT) & CELL_TERRAIN_MASK;
  for (let k = 0; k < carve.erase.length; k++) {
    const idx = carve.erase[k];
    cells[idx] = (cells[idx] & ~CELL_TERRAIN_MASK) | water;
  }
  for (let k = 0; k < carve.bridges.length; k++) {
    const idx = carve.bridges[k];
    cells[idx] = (cells[idx] & ~CELL_TERRAIN_MASK) | plains;
  }
}

// Pre-compute the island bridging for all maps so it doesn't freeze the UI
// when a match starts. Should be called at idle time (e.g. app startup).
export function warmMapCache() {
  for (const mapId of MAP_POOL) {
    if (!bridgeCache.has(mapId)) {
      bridgeCache.set(mapId, computeBridgeCarveIndices(mapId));
    }
  }
}
