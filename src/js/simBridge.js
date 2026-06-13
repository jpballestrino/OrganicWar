// Bridge between the network layer and the client-side WASM render cache.
// main.js registers the simulation handles here once WASM is loaded;
// network.js calls applyOwnerSnapshot() on sim-snapshot events.

import { TOTAL_CELLS, CELL_OWNER_MASK } from './constants.js';

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
