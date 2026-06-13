// Bridge between the network layer and the client-side WASM render cache.
// main.js registers the simulation handles here once WASM is loaded;
// network.js calls applyOwnerSnapshot() on sim-snapshot events.

import { TOTAL_CELLS } from './constants.js';

let wasmMemory = null;
let ownerPtr = null;

export function registerSim({ memory, ownerPointer }) {
  wasmMemory = memory;
  ownerPtr = ownerPointer;
}

// Snapshot format (matches server/game/simulationRunner.js):
//   byte 0      : 0 = sparse delta, 1 = full owner buffer
//   if delta    : N pairs of (u32 cell_id, u32 owner_id), little-endian
//   if full     : TOTAL_CELLS * 4 bytes of u32 owner ids
export function applyOwnerSnapshot(ownerDelta) {
  if (!wasmMemory || ownerPtr === null) return;

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
  const ownerView = new Uint32Array(wasmMemory.buffer, ownerPtr, TOTAL_CELLS);

  // The 1-byte header leaves the u32 payload misaligned, and Uint32Array views
  // require a 4-byte-aligned offset — copy the payload to an aligned buffer.
  const payloadBytes = bytes.slice(1);
  const payload = new Uint32Array(payloadBytes.buffer, 0, payloadBytes.byteLength >> 2);

  if (kind === 1) {
    if (payload.length >= TOTAL_CELLS) ownerView.set(payload.subarray(0, TOTAL_CELLS));
  } else if (kind === 0) {
    for (let i = 0; i + 1 < payload.length; i += 2) {
      const cellId = payload[i];
      if (cellId < TOTAL_CELLS) ownerView[cellId] = payload[i + 1];
    }
  }
}
