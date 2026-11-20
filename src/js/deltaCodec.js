// sim-delta wire format: which cells changed owner since the last delta.
//
// The sim lists the changed cells as u32s `cell_id (25 bits) | owner << 25`,
// sorted by cell id (lib.rs collect_dirty_cells). On the wire each cell is
//   varint(cell_id − previous cell_id)   (the first one: cell_id itself)
//   u8 owner
// Changed cells cluster along the fronts, so the gap is usually 1–2 bytes:
// about 2.5 bytes per cell instead of 4, and far more compressible — measured
// on a recorded 20-player match, 58% less on the wire after permessage-deflate
// (scripts/bench-room.mjs prints both). Used by the server worker (encode), the
// client (simBridge.js) and the bench (decode).

// u32 entries (sorted by cell id) → bytes. Worst case 5 bytes per cell (a
// gap of up to 25 bits takes 4 varint bytes), so the buffer is sized for that.
export function encodeDelta(entries) {
  const out = new Uint8Array(entries.length * 5);
  let n = 0;
  let prev = 0;
  for (let i = 0; i < entries.length; i++) {
    const v = entries[i];
    const id = v & 0x1FFFFFF;
    let gap = id - prev;
    prev = id;
    while (gap >= 0x80) { out[n++] = (gap & 0x7F) | 0x80; gap >>>= 7; }
    out[n++] = gap;
    out[n++] = (v >>> 25) & 0x7F;
  }
  return out.subarray(0, n);
}

// bytes → onCell(cellId, owner) for every changed cell, in cell order.
// Accepts an ArrayBuffer or any typed array / Buffer view.
export function decodeDelta(buf, onCell) {
  const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let id = 0;
  for (let i = 0; i < b.length;) {
    let gap = 0;
    let shift = 0;
    let byte;
    do {
      byte = b[i++];
      gap |= (byte & 0x7F) << shift;
      shift += 7;
    } while (byte & 0x80 && shift < 28);
    id += gap;
    onCell(id, b[i++]);
  }
}
