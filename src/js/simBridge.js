// Bridge between the network layer and the client-side WASM render cache.
// main.js registers the simulation handles here once WASM is loaded;
// network.js feeds it the sim-delta / sim-full / sim-stats messages.

import { TOTAL_CELLS, CELL_OWNER_MASK, COLS, ROWS } from './constants.js';
import { terrainCodes, writeTerrainBits, MAP_POOL, TERRAIN, isValidMapId } from './mapGen.js';
import { decodeDelta } from './deltaCodec.js';
import { decodeVision, BLOCK_SHIFT, BLOCK } from './fogCodec.js';

const DEFENSE_SHIFT = 11;
const DEFENSE_MASK = 0x7800;
const BUILDING_MASK_JS = 0x8000;

let wasmMemory = null;
let cellDataPtr = null;
let paintedMapId = null;

// The room's map size (standard, or the bigger Mega Battle map — init-config
// mapWidth / mapHeight). The map lives in a plain ArrayBuffer of W×H u16s:
// the client only stores and draws it (the server runs the simulation).
let W = COLS;
let H = ROWS;
let N = TOTAL_CELLS;
let sizeVer = 0;
export const mapWidth = () => W;
export const mapHeight = () => H;
export const mapSizeVersion = () => sizeVer;
// A view of the whole map (one u16 per cell), for the renderer.
export function cellView() {
  return wasmMemory ? new Uint16Array(wasmMemory.buffer, cellDataPtr, N) : null;
}

// Allocate an empty map of this size (no-op when it already is). The terrain
// is painted by repaintTerrain() and the owners arrive from the server.
export function setMapSize(width, height) {
  if (wasmMemory && width === W && height === H) return false;
  W = width; H = height; N = W * H;
  wasmMemory = { buffer: new ArrayBuffer(N * 2) };
  cellDataPtr = 0;
  dirtyRows = new Uint8Array(H);
  paintedMapId = null;
  resetFog();
  // Open sea until the terrain is painted (it can take a moment to compute).
  new Uint16Array(wasmMemory.buffer).fill(TERRAIN.WATER << 7);
  sizeVer++;
  markAllDirty();
  terrainVer++;
  return true;
}

// ── Which map rows changed since the renderer last uploaded them ────────────
// The renderer used to upload the whole 4 MB cell texture every frame; now it
// asks for the changed rows (takeDirtyRowSpans) and uploads only those, and
// nothing at all when nothing changed. Every write into cell_data below marks
// its rows.
let dirtyRows = new Uint8Array(H);
let anyDirty = false;
const markRow = (r) => { dirtyRows[r] = 1; anyDirty = true; };
function markRows(r0, r1) {
  for (let r = Math.max(0, r0); r <= Math.min(H - 1, r1); r++) dirtyRows[r] = 1;
  anyDirty = true;
}
export function markAllDirty() { dirtyRows.fill(1); anyDirty = true; }

// Bumped whenever the terrain bits are (re)written, so the renderer re-paints
// its baked terrain texture (once per map, not per frame).
let terrainVer = 0;
export const terrainVersion = () => terrainVer;

// Spans [firstRow, lastRow] to upload, merging spans less than `maxGap` rows
// apart (fewer, larger uploads). Clears the marks. [] when nothing changed.
export function takeDirtyRowSpans(maxGap = 16) {
  if (!anyDirty) return [];
  const spans = [];
  let start = -1;
  let last = -1;
  for (let r = 0; r < H; r++) {
    if (!dirtyRows[r]) continue;
    if (start >= 0 && r - last <= maxGap) { last = r; continue; }
    if (start >= 0) spans.push([start, last]);
    start = last = r;
  }
  if (start >= 0) spans.push([start, last]);
  dirtyRows.fill(0);
  anyDirty = false;
  return spans;
}

export function registerSim({ memory, cellDataPtr: ptr }) {
  wasmMemory = memory;
  cellDataPtr = ptr;
  markAllDirty();
  terrainVer++;
}

// Repaint the static terrain for the server-chosen map. The client paints a
// default map at startup (before it knows which map the room uses), so this is
// called once the map id arrives (spawn-selection-start / init-config) to make
// the local render cache match the authoritative terrain. Only terrain bits are
// touched; owner/defense/building bits are preserved.
//
// Terrain takes 1–3 s to compute, so it's computed in a Web Worker
// (terrainWorker.js) and kept per map; a map not computed yet is painted when
// it arrives (the map shows open sea meanwhile). The standard-size maps are
// computed in the background at startup (prefetchTerrain).
const terrainStore = new Map(); // `${mapId}@${w}x${h}` → Uint8Array
const terrainWaiting = new Map(); // key → [resolve]
const terrainQueue = []; // { key, mapId, w, h } not yet sent to the worker
let terrainBusy = false; // the worker is computing one map
let terrainWorker;
let wantedTerrain = null; // { mapId, key } the map should show

const terrainKey = (mapId, w, h) => `${isValidMapId(mapId) ? mapId : 'north_america'}@${w}x${h}`;

// One map at a time, so a map the player needs now (urgent: front of the
// queue) never waits behind the background prefetch of the others.
function pumpTerrain() {
  if (terrainBusy || !terrainQueue.length) return;
  const job = terrainQueue.shift();
  terrainBusy = true;
  terrainWorker.postMessage({ mapId: job.mapId, width: job.w, height: job.h });
}

function computeTerrain(mapId, w, h, urgent = false) {
  const key = terrainKey(mapId, w, h);
  if (terrainStore.has(key)) return Promise.resolve(terrainStore.get(key));
  if (terrainWorker === undefined) {
    try {
      terrainWorker = new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' });
      terrainWorker.onmessage = (e) => {
        const k = terrainKey(e.data.mapId, e.data.width, e.data.height);
        terrainStore.set(k, e.data.codes);
        for (const resolve of terrainWaiting.get(k) || []) resolve(e.data.codes);
        terrainWaiting.delete(k);
        terrainBusy = false;
        pumpTerrain();
      };
    } catch {
      terrainWorker = null; // no workers (tests): compute here
    }
  }
  if (!terrainWorker) {
    const codes = terrainCodes(mapId, w, h);
    terrainStore.set(key, codes);
    return Promise.resolve(codes);
  }
  return new Promise((resolve) => {
    const queued = terrainWaiting.get(key);
    if (queued) {
      queued.push(resolve);
      // Already waiting in the queue: move it to the front if now urgent.
      const at = terrainQueue.findIndex((j) => j.key === key);
      if (urgent && at > 0) terrainQueue.unshift(...terrainQueue.splice(at, 1));
      return;
    }
    terrainWaiting.set(key, [resolve]);
    const job = { key, mapId, w, h };
    if (urgent) terrainQueue.unshift(job); else terrainQueue.push(job);
    pumpTerrain();
  });
}

function paintTerrain(mapId, codes) {
  writeTerrainBits(new Uint16Array(wasmMemory.buffer, cellDataPtr, N), codes);
  paintedMapId = mapId;
  markAllDirty();
  terrainVer++;
}

export function repaintTerrain(mapId) {
  if (!wasmMemory || cellDataPtr === null || !mapId) return Promise.resolve();
  if (mapId === paintedMapId) return Promise.resolve();
  const key = terrainKey(mapId, W, H);
  wantedTerrain = { mapId, key };
  const cached = terrainStore.get(key);
  if (cached) { paintTerrain(mapId, cached); return Promise.resolve(); }
  return computeTerrain(mapId, W, H, true).then((codes) => {
    // Still the map (and size) we want? The room may have changed meanwhile.
    if (wantedTerrain && wantedTerrain.key === key && terrainKey(mapId, W, H) === key) paintTerrain(mapId, codes);
  });
}

// Compute the standard maps in the background, one after the other.
export async function prefetchTerrain(width = COLS, height = ROWS) {
  for (const mapId of MAP_POOL) await computeTerrain(mapId, width, height);
}

// Owner faction id (0 = nature) of a cell in the local render cache. Used for the
// client-side missile target pre-check (can't aim at own/nature land).
// Terrain code (mapGen.js TERRAIN) of a cell; -1 out of the map.
export function getCellTerrain(cellId) {
  if (!wasmMemory || cellDataPtr === null || cellId < 0 || cellId >= N) return -1;
  return (new Uint16Array(wasmMemory.buffer, cellDataPtr, N)[cellId] >> 7) & 0xF;
}

export function getCellOwner(cellId) {
  if (!wasmMemory || cellDataPtr === null || cellId < 0 || cellId >= N) return -1;
  const cellView = new Uint16Array(wasmMemory.buffer, cellDataPtr, N);
  return cellView[cellId] & CELL_OWNER_MASK;
}

// ── Wire format (encoded by the sim + server/game/simulationWorker.js) ───────
// sim-delta : changed cells, varint cell-id gaps + owner bytes (deltaCodec.js).
// sim-full  : { owners: ArrayBuffer of u32 runs `length (24 bits) | owner << 24`
//               covering every cell in row-major order, buildings: [...],
//               stats: <sim-stats buffer> } — sent to a (re)joining client.
// sim-stats : see decodeStats below.
// Only OWNER bits are merged into the local cell_data; terrain, defense tier
// and building bits are set locally (mapGen + building events).

const toU32 = (buf) => (buf instanceof ArrayBuffer
  ? new Uint32Array(buf)
  // A typed-array / Buffer view: copy so the u32 view is aligned.
  : new Uint32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));

// Apply a sim-delta. Returns the ids of the cells whose owner really changed
// (a reused buffer, valid until the next call) for resyncZonesForCells.
let changedBuf = new Uint32Array(4096);
export function applyOwnerDelta(buf) {
  if (!wasmMemory || cellDataPtr === null || !buf) return changedBuf.subarray(0, 0);
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, N);
  let n = 0;
  decodeDelta(buf, (id, owner) => {
    if (id >= N) return;
    const v = cells[id];
    const next = (v & ~CELL_OWNER_MASK) | (owner & CELL_OWNER_MASK);
    if (next === v) return;
    cells[id] = next;
    markRow((id / W) | 0);
    if (n === changedBuf.length) {
      const bigger = new Uint32Array(changedBuf.length * 2);
      bigger.set(changedBuf);
      changedBuf = bigger;
    }
    changedBuf[n++] = id;
  });
  return changedBuf.subarray(0, n);
}

// After owner changes: the fortification tier of the cells that changed hands
// follows the same rule as resyncBuildingZones — inside a completed tower's
// zone, tier 10 if the cell belongs to that tower's owner, else 0; cells
// outside every zone are left alone. Only the changed cells are visited
// (resyncBuildingZones redid every zone on the map 20 times a second).
export function resyncZonesForCells(changed, buildings) {
  if (!changed.length || !buildings || !buildings.length) return;
  const zones = buildings.filter((b) => b.type === 'defense' && !b.constructing);
  if (!zones.length) return;
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, N);
  for (let i = 0; i < changed.length; i++) {
    const id = changed[i];
    const r = (id / W) | 0;
    const c = id - r * W;
    const owner = cells[id] & CELL_OWNER_MASK;
    let inZone = false;
    let tierBits = -1;
    for (const b of zones) {
      const dr = r - b.row;
      const dc = c - b.col;
      if (dr * dr + dc * dc > b.radius * b.radius) continue;
      inZone = true;
      if (b.factionId === owner) { tierBits = (b.defTier & 0xF) << DEFENSE_SHIFT; break; }
    }
    if (!inZone) continue;
    const next = (cells[id] & ~DEFENSE_MASK) | (tierBits >= 0 ? tierBits : 0);
    if (next !== cells[id]) { cells[id] = next; markRow(r); }
  }
}

// Rebuild every cell's owner from run-length runs (full-state sync).
export function applyOwnerRuns(buf) {
  if (!wasmMemory || cellDataPtr === null || !buf) return;
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, N);
  const runs = toU32(buf);
  let i = 0;
  for (let r = 0; r < runs.length && i < N; r++) {
    const owner = (runs[r] >>> 24) & CELL_OWNER_MASK;
    const end = Math.min(N, i + (runs[r] & 0xFFFFFF));
    for (; i < end; i++) cells[i] = (cells[i] & ~CELL_OWNER_MASK) | owner;
  }
  markAllDirty();
}

// ── Fog of war ───────────────────────────────────────────────────────────────
// Per 8×8 block: whether this player sees it (`vis`, 255/0 — live owners from
// the server) and the minimap layer (`coarse`, one owner per block, for the
// whole map). Under fog the renderer draws the coarse layer, dimmed; the exact
// owners stored there are whatever was last seen. Off (all visible) before the
// match and while spectating. Wire format: fogCodec.js.
let BW = W >> BLOCK_SHIFT;
let BH = H >> BLOCK_SHIFT;
let vis = new Uint8Array(BW * BH).fill(255);
let coarse = new Uint8Array(BW * BH);
let fogOn = false;
let fogVer = 0;
export const fogEnabled = () => fogOn;
export const fogVersion = () => fogVer;
export const fogLayers = () => ({ vis, coarse, bw: BW, bh: BH });

export function resetFog() {
  BW = W >> BLOCK_SHIFT;
  BH = H >> BLOCK_SHIFT;
  vis = new Uint8Array(BW * BH).fill(255);
  coarse = new Uint8Array(BW * BH);
  fogOn = false;
  fogVer++;
}

// Spectating / no fog: everything is live.
export function setFogOff() {
  fogOn = false;
  vis.fill(255);
  fogVer++;
}

// Can this player see the cell right now? (Missile aiming, labels, icons.)
export function isCellVisible(cellId) {
  if (!fogOn) return true;
  const r = (cellId / W) | 0;
  return vis[(r >> BLOCK_SHIFT) * BW + ((cellId - r * W) >> BLOCK_SHIFT)] !== 0;
}

// sim-vision: blocks that came into view (with their owners) or left it.
// Returns the cells whose owner changed (for resyncZonesForCells).
export function applyVision(buf) {
  if (!wasmMemory || cellDataPtr === null || !buf) return changedBuf.subarray(0, 0);
  const { shown, hidden, owners } = decodeVision(buf);
  // The first update of a match lists what is in view: everything else is fog.
  if (!fogOn) vis.fill(0);
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, N);
  let n = 0;
  let k = 0;
  if (changedBuf.length < shown.length * BLOCK * BLOCK) changedBuf = new Uint32Array(shown.length * BLOCK * BLOCK);
  for (const b of shown) {
    vis[b] = 255;
    const r0 = Math.floor(b / BW) * BLOCK;
    const c0 = (b % BW) * BLOCK;
    for (let r = r0; r < r0 + BLOCK; r++) {
      for (let c = c0; c < c0 + BLOCK; c++) {
        const id = r * W + c;
        const next = (cells[id] & ~CELL_OWNER_MASK) | (owners[k++] & CELL_OWNER_MASK);
        if (next !== cells[id]) { cells[id] = next; changedBuf[n++] = id; }
      }
      markRow(r);
    }
  }
  for (const b of hidden) vis[b] = 0;
  fogOn = true;
  fogVer++;
  return changedBuf.subarray(0, n);
}

// sim-coarse: changed minimap blocks (sim-delta format, block ids).
export function applyCoarse(buf) {
  decodeDelta(buf, (b, owner) => { if (b < coarse.length) coarse[b] = owner; });
  fogVer++;
}

// sim-full: the whole minimap layer, one byte per block.
export function setCoarse(buf) {
  if (!buf) return;
  const src = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  coarse.set(src.subarray(0, coarse.length));
  fogVer++;
}

// A fogged full sync: forget every owner (fog everywhere), then the visible
// blocks arrive in a sim-vision payload.
export function clearOwnersForFog() {
  if (!wasmMemory || cellDataPtr === null) return;
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, N);
  for (let i = 0; i < N; i++) cells[i] &= ~CELL_OWNER_MASK;
  vis.fill(0);
  fogOn = true;
  fogVer++;
  markAllDirty();
}

// How many cells of the local render cache faction `fid` owns (debug / tests).
export function countOwnedCells(fid) {
  if (!wasmMemory || cellDataPtr === null) return 0;
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, N);
  let n = 0;
  for (let i = 0; i < N; i++) if ((cells[i] & CELL_OWNER_MASK) === fid) n++;
  return n;
}

// Clear every defense-tier and has-building bit (before a full-state rebuild).
export function clearAllBuildingBits() {
  if (!wasmMemory || cellDataPtr === null) return;
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, N);
  const keep = ~(DEFENSE_MASK | BUILDING_MASK_JS) & 0xFFFF;
  for (let i = 0; i < N; i++) cells[i] &= keep;
  markAllDirty();
}

// sim-stats: a 20-byte header then one 80-byte record per player (layout:
// STATS_* consts in simulation-core/src/lib.rs — keep in sync). Returns
// { tick, landCells, dominationShare, players } with players[1..n].
export function decodeStats(buf) {
  const bytes = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(bytes);
  const n = dv.getUint16(12, true);
  const rec = dv.getUint16(14, true);
  const HEADER = 20;
  const players = [null];
  for (let f = 1; f <= n; f++) {
    const o = HEADER + (f - 1) * rec;
    const troops = dv.getFloat32(o, true);
    const attacking = dv.getFloat32(o + 4, true);
    const flags = dv.getUint32(o + 40, true);
    players.push({
      troops,                               // home reserve
      attacking,                            // committed to fronts
      total: troops + attacking,
      maxPop: dv.getFloat32(o + 8, true),   // effective cap (incl. cities)
      cells: dv.getUint32(o + 12, true),
      gold: dv.getFloat32(o + 16, true),
      income: dv.getFloat32(o + 20, true),  // gold / s
      growth: dv.getFloat32(o + 24, true),  // troops / s
      kills: dv.getFloat32(o + 28, true),
      goldSpent: dv.getFloat32(o + 32, true),
      row: dv.getUint16(o + 36, true),
      col: dv.getUint16(o + 38, true),
      alive: (flags & 1) !== 0,
      bot: (flags & 2) !== 0,
      // What this player pays right now (prices escalate per building owned).
      prices: {
        defense: dv.getFloat32(o + 44, true),
        silo: dv.getFloat32(o + 48, true),
        mine: dv.getFloat32(o + 52, true),
        antiair: dv.getFloat32(o + 56, true),
        city: dv.getFloat32(o + 60, true),
        missile: dv.getFloat32(o + 64, true),
      },
      blitzActive: dv.getFloat32(o + 68, true),   // seconds left
      blitzCooldown: dv.getFloat32(o + 72, true), // seconds until ready
      bountyEarned: dv.getFloat32(o + 76, true),  // gold from bounties, match total
    });
  }
  return {
    tick: dv.getUint32(0, true),
    landCells: dv.getUint32(4, true),
    dominationShare: dv.getFloat32(8, true),
    bountyFid: dv.getUint32(16, true), // faction with a price on its head, 0 = none
    players,
  };
}

// Remove a destroyed defense building from the client's local cell_data.
// Called from the `building-destroyed` network event.
export function removeDefenseBuilding(buildingRow, buildingCol, radius) {
  if (!wasmMemory || cellDataPtr === null) return;

  const cellView = new Uint16Array(wasmMemory.buffer, cellDataPtr, N);

  // Clear defense tier bits in the radius circle.
  const rMin = Math.max(0, buildingRow - radius);
  const rMax = Math.min(H - 1, buildingRow + radius);
  const cMin = Math.max(0, buildingCol - radius);
  const cMax = Math.min(W - 1, buildingCol + radius);

  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const dr = r - buildingRow;
      const dc = c - buildingCol;
      if (dr * dr + dc * dc <= radius * radius) {
        cellView[r * W + c] &= ~DEFENSE_MASK;
      }
    }
  }

  // Clear has_building flag on the 8×8 footprint.
  for (let r = buildingRow - 4; r < buildingRow + 4; r++) {
    for (let c = buildingCol - 4; c < buildingCol + 4; c++) {
      if (r >= 0 && r < H && c >= 0 && c < W) {
        cellView[r * W + c] &= ~BUILDING_MASK_JS;
      }
    }
  }
  markRows(Math.min(rMin, buildingRow - 4), Math.max(rMax, buildingRow + 3));
}

// Re-derive every building's fortification zone after an owner snapshot.
// Snapshots carry owner bits only, so when the builder expands into new
// cells inside a fort radius (or loses cells out of it) the defense tier bits
// would otherwise go stale. We clear every zone first, then re-stamp tier 10
// on the cells each builder currently owns — matching the server invariant
// "tier 10 iff owned by the builder and inside a live building radius".
// Two separate passes (clear-all then stamp-all) so overlapping zones of the
// same faction don't clobber each other.
export function resyncBuildingZones(buildings) {
  if (!buildings || buildings.length === 0) return;
  // Only defense towers stamp a fortification zone. Silos (no zone) and buildings
  // still under construction (zone not applied until completion) are skipped in
  // both passes — this mirrors the server's BTYPE_DEFENSE-only fortification.
  for (const b of buildings) {
    if (b.type !== 'defense' || b.constructing) continue;
    removeDefenseBuilding(b.row, b.col, b.radius);
  }
  for (const b of buildings) {
    if (b.type !== 'defense' || b.constructing) continue;
    applyDefenseBuilding(b.row, b.col, b.radius, b.defTier, b.factionId);
  }
}

// Apply a placed defense building into the client's local cell_data.
// Called from the `building-placed` network event so the GLSL heatmap
// shows the fortification zone immediately without waiting for a snapshot.
export function applyDefenseBuilding(buildingRow, buildingCol, radius, defTier, factionId) {
  if (!wasmMemory || cellDataPtr === null) return;

  const cellView = new Uint16Array(wasmMemory.buffer, cellDataPtr, N);

  // Stamp defense tier bits in the radius circle — own cells only.
  const tierBits = (defTier & 0xF) << DEFENSE_SHIFT;
  const rMin = Math.max(0, buildingRow - radius);
  const rMax = Math.min(H - 1, buildingRow + radius);
  const cMin = Math.max(0, buildingCol - radius);
  const cMax = Math.min(W - 1, buildingCol + radius);

  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const dr = r - buildingRow;
      const dc = c - buildingCol;
      if (dr * dr + dc * dc <= radius * radius) {
        const cell = r * W + c;
        if ((cellView[cell] & CELL_OWNER_MASK) === factionId) {
          cellView[cell] = (cellView[cell] & ~DEFENSE_MASK) | tierBits;
        }
      }
    }
  }

  // Stamp has_building flag on the 8×8 footprint.
  for (let r = buildingRow - 4; r < buildingRow + 4; r++) {
    for (let c = buildingCol - 4; c < buildingCol + 4; c++) {
      if (r >= 0 && r < H && c >= 0 && c < W) {
        cellView[r * W + c] |= BUILDING_MASK_JS;
      }
    }
  }
  markRows(Math.min(rMin, buildingRow - 4), Math.max(rMax, buildingRow + 3));
}
