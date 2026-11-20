// Minimap (bottom-left in a match): the whole map at one pixel per 8×8 block —
// terrain, every empire from the coarse layer the server streams to everyone
// (`sim-coarse`, see fogCodec.js), the fog of war darkened, and the camera's
// view as a rectangle. Click or drag on it to move the camera there.
import { state } from './state.js';
import { fogLayers, fogVersion, fogEnabled, terrainVersion, cellView, mapWidth } from './simBridge.js';
import { factionRGB } from './constants.js';
import { BLOCK_SHIFT, BLOCK } from './fogCodec.js';

// Terrain colours by code (mapGen.js TERRAIN), muted to sit under the empires.
const TERRAIN_RGB = [
  [92, 128, 70], [128, 120, 84], [116, 108, 102], [26, 46, 78],
  [44, 88, 50], [64, 112, 160], [176, 150, 64], [124, 106, 116],
];

let canvas = null;
let ctx = null;
let image = null;      // the map layer, redrawn when the fog / coarse / terrain change
let imageCtx = null;
let drawnFog = -1;
let drawnTerrain = -1;
let terrainRgb = null; // per block, from each block's centre cell
let renderer = null;

export function initMinimap(r) {
  renderer = r;
  canvas = document.getElementById('minimap');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  image = document.createElement('canvas');
  imageCtx = image.getContext('2d');
  let dragging = false;
  const moveTo = (e) => {
    const rect = canvas.getBoundingClientRect();
    const { bw, bh } = fogLayers();
    const col = ((e.clientX - rect.left) / rect.width) * bw * BLOCK;
    const row = ((e.clientY - rect.top) / rect.height) * bh * BLOCK;
    const cam = renderer.camera;
    cam.x = col - renderer.canvas.width / cam.zoom / 2;
    cam.y = row - renderer.canvas.height / cam.zoom / 2;
  };
  canvas.addEventListener('mousedown', (e) => { if (e.button === 0) { dragging = true; moveTo(e); e.preventDefault(); } });
  window.addEventListener('mousemove', (e) => { if (dragging) moveTo(e); });
  window.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function rebuildTerrain(bw, bh) {
  const cells = cellView();
  terrainRgb = new Uint8Array(bw * bh * 3);
  if (!cells) return;
  const W = mapWidth();
  for (let b = 0; b < bw * bh; b++) {
    const r = Math.floor(b / bw) * BLOCK + (BLOCK >> 1);
    const c = (b % bw) * BLOCK + (BLOCK >> 1);
    const t = (cells[r * W + c] >> 7) & 0xF;
    const rgb = TERRAIN_RGB[t] || TERRAIN_RGB[0];
    terrainRgb.set(rgb, b * 3);
  }
}

function rebuildImage() {
  const { vis, coarse, bw, bh } = fogLayers();
  if (image.width !== bw || image.height !== bh) { image.width = bw; image.height = bh; }
  if (!terrainRgb || terrainRgb.length !== bw * bh * 3 || drawnTerrain !== terrainVersion()) {
    rebuildTerrain(bw, bh);
    drawnTerrain = terrainVersion();
  }
  const data = imageCtx.createImageData(bw, bh);
  const px = data.data;
  const me = parseInt(state.playerFaction);
  const fog = fogEnabled();
  for (let b = 0; b < bw * bh; b++) {
    let r = terrainRgb[b * 3];
    let g = terrainRgb[b * 3 + 1];
    let bl = terrainRgb[b * 3 + 2];
    const o = coarse[b];
    if (o) {
      const c = factionRGB[o] || [160, 160, 160];
      const a = o === me ? 0.9 : 0.7;
      r = r * (1 - a) + c[0] * a;
      g = g * (1 - a) + c[1] * a;
      bl = bl * (1 - a) + c[2] * a;
    }
    if (fog && !vis[b]) { r *= 0.5; g *= 0.5; bl *= 0.5; }
    px[b * 4] = r;
    px[b * 4 + 1] = g;
    px[b * 4 + 2] = bl;
    px[b * 4 + 3] = 255;
  }
  imageCtx.putImageData(data, 0, 0);
}

// Per frame: the cached map layer, then the camera's view on top.
export function drawMinimap() {
  if (!canvas || !renderer) return;
  const show = state.gameState === 'PLAYING';
  canvas.style.display = show ? 'block' : 'none';
  if (!show) return;
  const { bw, bh } = fogLayers();
  if (canvas.width !== bw * 2 || canvas.height !== bh * 2) {
    canvas.width = bw * 2;
    canvas.height = bh * 2;
    drawnFog = -1;
  }
  if (drawnFog !== fogVersion() || drawnTerrain !== terrainVersion()) {
    rebuildImage();
    drawnFog = fogVersion();
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  // The camera's view.
  const cam = renderer.camera;
  const k = canvas.width / (bw << BLOCK_SHIFT);
  const x = cam.x * k;
  const y = cam.y * k;
  const w = (renderer.canvas.width / cam.zoom) * k;
  const h = (renderer.canvas.height / cam.zoom) * k;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(Math.max(0, x), Math.max(0, y), Math.min(canvas.width, w), Math.min(canvas.height, h));
}
