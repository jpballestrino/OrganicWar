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

// Squared normalized distance to an ellipse centre; <= 1 means inside.
function ellipse(nx, ny, cx, cy, rx, ry) {
  const dx = (nx - cx) / rx;
  const dy = (ny - cy) / ry;
  return dx * dx + dy * dy;
}

// Landmass = union of these blobs (rough continental masses).
const LAND_BLOBS = [
  { cx: 0.47, cy: 0.28, rx: 0.40, ry: 0.19 }, // Canada (broad north)
  { cx: 0.45, cy: 0.49, rx: 0.35, ry: 0.13 }, // United States
  { cx: 0.13, cy: 0.21, rx: 0.09, ry: 0.075 }, // Alaska
  { cx: 0.39, cy: 0.64, rx: 0.15, ry: 0.10 }, // Mexico
  { cx: 0.30, cy: 0.66, rx: 0.035, ry: 0.085 }, // Baja California
  { cx: 0.60, cy: 0.60, rx: 0.035, ry: 0.07 }, // Florida
  { cx: 0.52, cy: 0.79, rx: 0.11, ry: 0.06 }, // Central America (isthmus)
  { cx: 0.85, cy: 0.13, rx: 0.09, ry: 0.11 }, // Greenland
];

// Inland seas carved back out of the landmass.
const WATER_CARVES = [
  { cx: 0.50, cy: 0.25, rx: 0.09, ry: 0.07 }, // Hudson Bay
  { cx: 0.50, cy: 0.59, rx: 0.11, ry: 0.055 }, // Gulf of Mexico
];

// West coast x-position as a function of latitude — the cordillera follows it.
function westCoastX(ny) {
  return 0.10 + 0.20 * clamp01((ny - 0.18) / (0.66 - 0.18));
}

function isLand(nx, ny) {
  // Wobble the coastline a little so it isn't a clean ellipse.
  const coast = (valueNoise(nx * 14, ny * 14) - 0.5) * 0.28;
  let land = false;
  for (const b of LAND_BLOBS) {
    if (ellipse(nx, ny, b.cx, b.cy, b.rx, b.ry) <= 1 + coast) { land = true; break; }
  }
  if (!land) { return false; }
  for (const w of WATER_CARVES) {
    if (ellipse(nx, ny, w.cx, w.cy, w.rx, w.ry) <= 1 + coast * 0.5) { return false; }
  }
  return true;
}

// Pure terrain classifier. Returns a TERRAIN value for any point in [0,1]^2.
export function terrainAt(nx, ny) {
  if (!isLand(nx, ny)) { return TERRAIN.WATER; }

  const n = valueNoise(nx * 22, ny * 22); // fine texture for band edges

  // Greenland: icy plateau — mostly highlands with a few peaks.
  if (ny < 0.20 && nx > 0.76) { return n > 0.7 ? TERRAIN.MOUNTAINS : TERRAIN.HIGHLANDS; }
  // Alaska: rugged, mixed mountains and highlands.
  if (ellipse(nx, ny, 0.13, 0.21, 0.09, 0.075) <= 1) { return n > 0.5 ? TERRAIN.MOUNTAINS : TERRAIN.HIGHLANDS; }

  // Western cordillera (Rockies / Sierra Madre): a narrow band just inland of
  // the coast, with foothills feathering eastward into the plains.
  const coast = westCoastX(ny);
  const fromCoast = nx - coast;
  if (fromCoast > 0.012 && fromCoast < 0.06 + n * 0.03) {
    return TERRAIN.MOUNTAINS;
  }
  if (fromCoast >= 0.06 && fromCoast < 0.11 && n > 0.5) {
    return TERRAIN.HIGHLANDS;
  }

  // Appalachians: eastern highland strip.
  if (nx > 0.58 && nx < 0.70 && ny > 0.40 && ny < 0.62 && n > 0.35) {
    return TERRAIN.HIGHLANDS;
  }

  // Canadian Shield: scattered highlands across the north-centre.
  if (ny < 0.32 && nx > 0.42 && nx < 0.70 && n > 0.62) {
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
