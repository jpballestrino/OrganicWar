// Background thread: computes the terrain of each { mapId, size } job and
// posts it to terrainCache.js as a SharedArrayBuffer (one byte per cell).
import { parentPort, workerData } from 'worker_threads';
import { terrainCodes } from '../../src/js/mapGen.js';
import { MAP_SIZES } from '../../src/js/constants.js';

for (const { mapId, size } of workerData.jobs) {
  const { width, height } = MAP_SIZES[size] || MAP_SIZES.standard;
  const codes = terrainCodes(mapId, width, height);
  const buffer = new SharedArrayBuffer(codes.length);
  new Uint8Array(buffer).set(codes);
  parentPort.postMessage({ mapId, size, buffer });
}
