// The finished terrain of each map, one byte per cell (mapGen.js
// terrainCodes), kept in SharedArrayBuffers and handed to every room's worker,
// so a room starts in milliseconds instead of generating its map (1–2 s on the
// standard map, ~2 s more for the Mega one) while its players wait.
//
// Filled two ways, both off the main thread: at boot a background worker
// (terrainWarmWorker.js) computes every map of the pool; and a room worker
// that had to generate its map itself (cache still cold) posts the result back.
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { MAP_POOL, isValidMapId, terrainAt, TERRAIN } from '../../src/js/mapGen.js';
import { MAP_SIZES } from '../../src/js/constants.js';
import { log } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map(); // `${mapId}@${size}` → SharedArrayBuffer

const keyOf = (mapId, size) => `${isValidMapId(mapId) ? mapId : 'north_america'}@${size === 'mega' ? 'mega' : 'standard'}`;

export function getTerrain(mapId, size) {
  return cache.get(keyOf(mapId, size)) || null;
}

export function storeTerrain(mapId, size, buffer) {
  if (buffer instanceof SharedArrayBuffer) cache.set(keyOf(mapId, size), buffer);
}

// Compute every map of the pool in one background thread, standard size first
// (Quick Battles), then the Mega size. Returns a promise for tests/scripts.
export function warmTerrainCache({ maps = MAP_POOL, sizes = ['standard', 'mega'] } = {}) {
  const jobs = [];
  for (const size of sizes) for (const mapId of maps) if (!getTerrain(mapId, size)) jobs.push({ mapId, size });
  if (!jobs.length) return Promise.resolve();
  const started = Date.now();
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'terrainWarmWorker.js'), { workerData: { jobs } });
    worker.on('message', (m) => storeTerrain(m.mapId, m.size, m.buffer));
    worker.on('error', (err) => { log('warn', `[Terrain] warm-up failed: ${err.message}`); resolve(); });
    worker.on('exit', () => {
      log('info', `[Terrain] ${cache.size} maps ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      resolve();
    });
  });
}

// Is this cell land? The exact terrain the sim uses (bridges, erased
// speckles) once the map is cached; until then the map's classifier, which
// differs on ~0.06% of cells (bridges and tiny islets).
export function isLandAt(mapId, size, row, col) {
  const { width, height } = MAP_SIZES[size === 'mega' ? 'mega' : 'standard'];
  const buf = getTerrain(mapId, size);
  if (buf) return new Uint8Array(buf)[row * width + col] !== TERRAIN.WATER;
  return terrainAt(col / width, row / height, mapId) !== TERRAIN.WATER;
}
