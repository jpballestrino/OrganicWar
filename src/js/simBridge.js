// Bridge between the network layer and the client-side WASM render cache.
// main.js registers the simulation handles here once WASM is loaded;
// network.js feeds it the sim-delta / sim-full / sim-stats messages.

import { TOTAL_CELLS, CELL_OWNER_MASK, COLS, ROWS } from './constants.js';
import { generateTerrain } from './mapGen.js';

const DEFENSE_SHIFT = 11;
const DEFENSE_MASK = 0x7800;
const BUILDING_MASK_JS = 0x8000;

let wasmMemory = null;
let cellDataPtr = null;
let paintedMapId = null;

export function registerSim({ memory, cellDataPtr: ptr }) {
  wasmMemory = memory;
  cellDataPtr = ptr;
}

// Repaint the static terrain for the server-chosen map. The client paints a
// default map at startup (before it knows which map the room uses), so this is
// called once the map id arrives (spawn-selection-start / init-config) to make
// the local render cache match the authoritative terrain. Only terrain bits are
// touched; owner/defense/building bits are preserved. No-op if the sim isn't
// registered yet or the map is already painted.
export function repaintTerrain(mapId) {
  if (!wasmMemory || cellDataPtr === null || !mapId) return;
  if (mapId === paintedMapId) return;
  generateTerrain(wasmMemory, cellDataPtr, mapId);
  paintedMapId = mapId;
}

// Owner faction id (0 = nature) of a cell in the local render cache. Used for the
// client-side missile target pre-check (can't aim at own/nature land).
export function getCellOwner(cellId) {
  if (!wasmMemory || cellDataPtr === null || cellId < 0 || cellId >= TOTAL_CELLS) return -1;
  const cellView = new Uint16Array(wasmMemory.buffer, cellDataPtr, TOTAL_CELLS);
  return cellView[cellId] & CELL_OWNER_MASK;
}

// ── Wire format (encoded by the sim + server/game/simulationWorker.js) ───────
// sim-delta : ArrayBuffer of u32, each `cell_id (21 bits) | owner << 21`.
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

export function applyOwnerDelta(buf) {
  if (!wasmMemory || cellDataPtr === null || !buf) return;
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, TOTAL_CELLS);
  const delta = toU32(buf);
  for (let i = 0; i < delta.length; i++) {
    const v = delta[i];
    const id = v & 0x1FFFFF;
    if (id < TOTAL_CELLS) {
      cells[id] = (cells[id] & ~CELL_OWNER_MASK) | ((v >>> 21) & CELL_OWNER_MASK);
    }
  }
}

// Rebuild every cell's owner from run-length runs (full-state sync).
export function applyOwnerRuns(buf) {
  if (!wasmMemory || cellDataPtr === null || !buf) return;
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, TOTAL_CELLS);
  const runs = toU32(buf);
  let i = 0;
  for (let r = 0; r < runs.length && i < TOTAL_CELLS; r++) {
    const owner = (runs[r] >>> 24) & CELL_OWNER_MASK;
    const end = Math.min(TOTAL_CELLS, i + (runs[r] & 0xFFFFFF));
    for (; i < end; i++) cells[i] = (cells[i] & ~CELL_OWNER_MASK) | owner;
  }
}

// How many cells of the local render cache faction `fid` owns (debug / tests).
export function countOwnedCells(fid) {
  if (!wasmMemory || cellDataPtr === null) return 0;
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, TOTAL_CELLS);
  let n = 0;
  for (let i = 0; i < TOTAL_CELLS; i++) if ((cells[i] & CELL_OWNER_MASK) === fid) n++;
  return n;
}

// Clear every defense-tier and has-building bit (before a full-state rebuild).
export function clearAllBuildingBits() {
  if (!wasmMemory || cellDataPtr === null) return;
  const cells = new Uint16Array(wasmMemory.buffer, cellDataPtr, TOTAL_CELLS);
  const keep = ~(DEFENSE_MASK | BUILDING_MASK_JS) & 0xFFFF;
  for (let i = 0; i < TOTAL_CELLS; i++) cells[i] &= keep;
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

  const cellView = new Uint16Array(wasmMemory.buffer, cellDataPtr, TOTAL_CELLS);

  // Clear defense tier bits in the radius circle.
  const rMin = Math.max(0, buildingRow - radius);
  const rMax = Math.min(ROWS - 1, buildingRow + radius);
  const cMin = Math.max(0, buildingCol - radius);
  const cMax = Math.min(COLS - 1, buildingCol + radius);

  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const dr = r - buildingRow;
      const dc = c - buildingCol;
      if (dr * dr + dc * dc <= radius * radius) {
        cellView[r * COLS + c] &= ~DEFENSE_MASK;
      }
    }
  }

  // Clear has_building flag on the 8×8 footprint.
  for (let r = buildingRow - 4; r < buildingRow + 4; r++) {
    for (let c = buildingCol - 4; c < buildingCol + 4; c++) {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
        cellView[r * COLS + c] &= ~BUILDING_MASK_JS;
      }
    }
  }
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

  const cellView = new Uint16Array(wasmMemory.buffer, cellDataPtr, TOTAL_CELLS);

  // Stamp defense tier bits in the radius circle — own cells only.
  const tierBits = (defTier & 0xF) << DEFENSE_SHIFT;
  const rMin = Math.max(0, buildingRow - radius);
  const rMax = Math.min(ROWS - 1, buildingRow + radius);
  const cMin = Math.max(0, buildingCol - radius);
  const cMax = Math.min(COLS - 1, buildingCol + radius);

  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const dr = r - buildingRow;
      const dc = c - buildingCol;
      if (dr * dr + dc * dc <= radius * radius) {
        const cell = r * COLS + c;
        if ((cellView[cell] & CELL_OWNER_MASK) === factionId) {
          cellView[cell] = (cellView[cell] & ~DEFENSE_MASK) | tierBits;
        }
      }
    }
  }

  // Stamp has_building flag on the 8×8 footprint.
  for (let r = buildingRow - 4; r < buildingRow + 4; r++) {
    for (let c = buildingCol - 4; c < buildingCol + 4; c++) {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
        cellView[r * COLS + c] |= BUILDING_MASK_JS;
      }
    }
  }
}
