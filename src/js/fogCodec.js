// Fog of war wire format (server/game/fog.js encodes, simBridge.js decodes).
//
// The map is split into 8×8-cell blocks. A player is sent the owner changes of
// the blocks it sees (sim-delta, filtered per player), plus `sim-vision` when
// its view changes:
//   u32 shown, u32 hidden,
//   shown × u32 block id, hidden × u32 block id,
//   shown × 64 owner bytes (the block's cells, row by row)
// Blocks that come into view carry their current owners, since the player got
// none of their changes while they were fogged. The minimap / fog layer
// (`sim-coarse`, to everyone) is one owner per block — each block's centre
// cell — sent as changes in the sim-delta format (deltaCodec.js) with the block
// id in place of the cell id.

export const BLOCK_SHIFT = 3;
export const BLOCK = 1 << BLOCK_SHIFT;
export const BLOCK_CELLS = BLOCK * BLOCK;

export function encodeVision(shown, hidden, owners) {
  const buf = new ArrayBuffer(8 + (shown.length + hidden.length) * 4 + shown.length * BLOCK_CELLS);
  const head = new Uint32Array(buf, 0, 2 + shown.length + hidden.length);
  head[0] = shown.length;
  head[1] = hidden.length;
  head.set(shown, 2);
  head.set(hidden, 2 + shown.length);
  new Uint8Array(buf, 8 + (shown.length + hidden.length) * 4).set(owners);
  return buf;
}

export function decodeVision(buf) {
  const b = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const [shownN, hiddenN] = new Uint32Array(b, 0, 2);
  const ids = new Uint32Array(b, 8, shownN + hiddenN);
  return {
    shown: ids.subarray(0, shownN),
    hidden: ids.subarray(shownN),
    owners: new Uint8Array(b, 8 + (shownN + hiddenN) * 4, shownN * BLOCK_CELLS),
  };
}
