// Fog of war for one room's worker: what each player sees, and the per-player
// pieces of the map stream (wire format: src/js/fogCodec.js).
//
// The sim computes the view (lib.rs compute_vision: per 8×8 block, a bit per
// faction — its land plus VISION_RADIUS_BLOCKS around it, plus what its
// completed silos can hit). Here:
//   filterDelta  — a sim-delta per viewer with only the cells it sees;
//   visionUpdate — blocks that came into view (with their owners) or left it;
//   coarseDiff   — the minimap layer (one owner per block) for everyone.
import { encodeDelta } from '../../src/js/deltaCodec.js';
import { encodeVision, BLOCK_SHIFT, BLOCK, BLOCK_CELLS } from '../../src/js/fogCodec.js';

export class FogOfWar {
  constructor(exports, statePtr, width, height) {
    this.x = exports;
    this.ptr = statePtr;
    this.W = width;
    this.H = height;
    this.BW = exports.simulationstate_blocks_w();
    this.BH = exports.simulationstate_blocks_h();
    this.NB = this.BW * this.BH;
    this.known = new Map(); // fid → Uint8Array(NB): blocks that player's client has live
    this.prevCoarse = new Uint8Array(this.NB);
    this.computed = false;
    this.allies = null; // fid → [fids] that share its view (guild-war teams)
  }

  // Teams (guild wars): teammates see what any of them sees.
  setTeams(teams) {
    if (!teams) return;
    this.allies = new Map();
    for (const [f, t] of Object.entries(teams)) {
      this.allies.set(Number(f), Object.keys(teams).filter((g) => String(teams[g]) === String(t)).map(Number));
    }
  }

  // The vision bits (low word, high word) that count as "fid sees it".
  _mask(fid) {
    let lo = 0;
    let hi = 0;
    for (const f of (this.allies && this.allies.get(fid)) || [fid]) {
      if (f <= 32) lo |= 1 << (f - 1); else hi |= 1 << (f - 33);
    }
    return [lo >>> 0, hi >>> 0];
  }

  compute() {
    this.x.simulationstate_compute_vision(this.ptr);
    this.computed = true;
  }

  // Views into WASM memory (re-made each time: memory growth detaches them).
  _vision() { return new Uint32Array(this.x.memory.buffer, this.x.simulationstate_get_vision_ptr(this.ptr), this.NB * 2); }
  _cells() { return new Uint16Array(this.x.memory.buffer, this.x.simulationstate_get_cell_data_ptr(this.ptr), this.W * this.H); }

  blockOf(cell) {
    const r = (cell / this.W) | 0;
    return (r >> BLOCK_SHIFT) * this.BW + ((cell - r * this.W) >> BLOCK_SHIFT);
  }

  // Delta entries (u32 cell | owner << 25, sorted) → Map fid → encoded delta
  // with only the cells in blocks that fid sees (or saw until this update:
  // `known`, so a change in a block that just left view still arrives).
  filterDelta(entries, fids) {
    const out = new Map();
    if (!fids.length) return out;
    const vis = this._vision();
    const blocks = new Uint32Array(entries.length);
    for (let i = 0; i < entries.length; i++) blocks[i] = this.blockOf(entries[i] & 0x1FFFFFF);
    const pick = new Uint32Array(entries.length);
    for (const fid of fids) {
      const [lo, hi] = this._mask(fid);
      const known = this.known.get(fid);
      let n = 0;
      for (let i = 0; i < entries.length; i++) {
        const b = blocks[i];
        if ((vis[b * 2] & lo) || (vis[b * 2 + 1] & hi) || (known && known[b])) pick[n++] = entries[i];
      }
      const enc = encodeDelta(pick.subarray(0, n));
      out.set(fid, enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength));
    }
    return out;
  }

  // What changed in fid's view since its last update, or null. The first call
  // for a faction (or after forget) reveals everything it sees.
  visionUpdate(fid) {
    const vis = this._vision();
    const [lo, hi] = this._mask(fid);
    let known = this.known.get(fid);
    if (!known) { known = new Uint8Array(this.NB); this.known.set(fid, known); }
    const shown = [];
    const hidden = [];
    for (let b = 0; b < this.NB; b++) {
      const sees = ((vis[b * 2] & lo) | (vis[b * 2 + 1] & hi)) !== 0;
      if (sees && !known[b]) { shown.push(b); known[b] = 1; } else if (!sees && known[b]) { hidden.push(b); known[b] = 0; }
    }
    if (!shown.length && !hidden.length) return null;
    return encodeVision(shown, hidden, this._blockOwners(shown));
  }

  // The 64 owner bytes of each listed block, row by row.
  _blockOwners(blocks) {
    const cells = this._cells();
    const out = new Uint8Array(blocks.length * BLOCK_CELLS);
    let k = 0;
    for (const b of blocks) {
      const r0 = Math.floor(b / this.BW) * BLOCK;
      const c0 = (b % this.BW) * BLOCK;
      for (let r = r0; r < r0 + BLOCK; r++) {
        const base = r * this.W + c0;
        for (let c = 0; c < BLOCK; c++) out[k++] = cells[base + c] & 0x7F;
      }
    }
    return out;
  }

  // A full update for fid from scratch (reconnect / reload).
  fullVision(fid) {
    this.known.delete(fid);
    return this.visionUpdate(fid) || encodeVision([], [], new Uint8Array(0));
  }

  forget(fid) { this.known.delete(fid); }
  watching() { return [...this.known.keys()]; }

  _coarse() { return new Uint8Array(this.x.memory.buffer, this.x.simulationstate_get_coarse_owner_ptr(this.ptr), this.NB); }

  // Minimap blocks that changed owner since the last call (sim-delta format,
  // block ids), or null.
  coarseDiff() {
    const now = this._coarse();
    const changed = [];
    for (let b = 0; b < this.NB; b++) {
      if (now[b] !== this.prevCoarse[b]) { changed.push((b | (now[b] << 25)) >>> 0); this.prevCoarse[b] = now[b]; }
    }
    if (!changed.length) return null;
    const enc = encodeDelta(Uint32Array.from(changed));
    return enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength);
  }

  // The whole minimap layer, one byte per block (for sim-full).
  coarseFull() { return this._coarse().slice().buffer; }
}
