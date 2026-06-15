// Bridge between the network layer and the client-side WASM render cache.
// main.js registers the simulation handles here once WASM is loaded;
// network.js calls applyOwnerSnapshot() on sim-snapshot events.

import { TOTAL_CELLS, CELL_OWNER_MASK, COLS, ROWS } from './constants.js';

const DEFENSE_SHIFT = 11;
const DEFENSE_MASK = 0x7800;
const BUILDING_MASK_JS = 0x8000;

let wasmMemory = null;
let cellDataPtr = null;

export function registerSim({ memory, cellDataPtr: ptr }) {
  wasmMemory = memory;
  cellDataPtr = ptr;
}

// Snapshot format (matches server/game/simulationRunner.js):
//   byte 0      : 0 = sparse delta, 1 = full packed-cell buffer
//   if delta    : N pairs of (u32 cell_id, u32 owner_id), little-endian
//   if full     : TOTAL_CELLS * 2 bytes of u16 packed cells
// Cells are packed (owner/terrain/defense/building) into one u16, so we only
// merge the OWNER bits and leave the locally-generated terrain bits intact —
// the server never generates terrain, so its terrain bits are zero.
export function applyOwnerSnapshot(ownerDelta) {
  if (!wasmMemory || cellDataPtr === null) return;

  // Node Buffers are Uint8Array subclasses, so the first branch covers them too.
  let bytes;
  if (ownerDelta instanceof Uint8Array) {
    bytes = ownerDelta;
  } else if (ownerDelta instanceof ArrayBuffer) {
    bytes = new Uint8Array(ownerDelta);
  } else {
    bytes = new Uint8Array(ownerDelta.buffer, ownerDelta.byteOffset, ownerDelta.byteLength);
  }

  if (bytes.byteLength < 1) return;
  const kind = bytes[0];
  const cellView = new Uint16Array(wasmMemory.buffer, cellDataPtr, TOTAL_CELLS);

  // The 1-byte header leaves the payload misaligned, and typed-array views
  // require an aligned offset — copy the payload to a fresh aligned buffer.
  const payloadBytes = bytes.slice(1);

  if (kind === 1) {
    // Full snapshot: payload is packed u16 cells. Take owner bits only.
    const packed = new Uint16Array(payloadBytes.buffer, 0, payloadBytes.byteLength >> 1);
    const n = Math.min(packed.length, TOTAL_CELLS);
    for (let i = 0; i < n; i++) {
      cellView[i] = (cellView[i] & ~CELL_OWNER_MASK) | (packed[i] & CELL_OWNER_MASK);
    }
  } else if (kind === 0) {
    // Sparse delta: (u32 cell_id, u32 owner_id) pairs.
    const payload = new Uint32Array(payloadBytes.buffer, 0, payloadBytes.byteLength >> 2);
    for (let i = 0; i + 1 < payload.length; i += 2) {
      const cellId = payload[i];
      if (cellId < TOTAL_CELLS) {
        cellView[cellId] = (cellView[cellId] & ~CELL_OWNER_MASK) | (payload[i + 1] & CELL_OWNER_MASK);
      }
    }
  }
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
  for (const b of buildings) {
    removeDefenseBuilding(b.row, b.col, b.radius);
  }
  for (const b of buildings) {
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
