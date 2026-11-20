// Computes map terrain off the main thread (1–3 s per map): one byte per cell
// (mapGen.js terrainCodes), sent back as a transferred buffer.
import { terrainCodes } from './mapGen.js';

self.onmessage = (e) => {
  const { mapId, width, height } = e.data;
  const codes = terrainCodes(mapId, width, height).slice(); // a copy we can transfer
  self.postMessage({ mapId, width, height, codes }, [codes.buffer]);
};
