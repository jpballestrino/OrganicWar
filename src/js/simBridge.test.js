// The client's map cache: the sim-delta codec, the rows handed to the GPU,
// and the incremental fortification update (src/js/deltaCodec.js, simBridge.js).
import { describe, it, expect } from 'vitest';
import { encodeDelta, decodeDelta } from './deltaCodec.js';
import {
  registerSim, applyOwnerDelta, resyncZonesForCells, resyncBuildingZones,
  takeDirtyRowSpans, markAllDirty,
} from './simBridge.js';
import { TOTAL_CELLS, COLS, ROWS } from './constants.js';

const pack = (id, owner) => (id | (owner << 21)) >>> 0;
const decodeAll = (buf) => { const out = []; decodeDelta(buf, (id, o) => out.push([id, o])); return out; };

describe('sim-delta codec', () => {
  it('round-trips, including the first and last cell and the largest owner', () => {
    const cells = [[0, 1], [1, 1], [2, 64], [130, 0], [16_000, 127], [TOTAL_CELLS - 1, 5]];
    const buf = encodeDelta(Uint32Array.from(cells.map(([i, o]) => pack(i, o))));
    expect(decodeAll(buf)).toEqual(cells);
  });

  it('round-trips a large random delta and is smaller than 4 bytes a cell', () => {
    const ids = new Set();
    while (ids.size < 5000) ids.add(Math.floor(Math.random() * TOTAL_CELLS));
    const sorted = [...ids].sort((a, b) => a - b);
    const cells = sorted.map((i) => [i, 1 + (i % 64)]);
    const buf = encodeDelta(Uint32Array.from(cells.map(([i, o]) => pack(i, o))));
    expect(decodeAll(buf)).toEqual(cells);
    expect(buf.byteLength).toBeLessThan(cells.length * 4);
  });

  it('an empty delta is empty', () => {
    expect(encodeDelta(new Uint32Array(0)).byteLength).toBe(0);
    expect(decodeAll(new ArrayBuffer(0))).toEqual([]);
  });
});

// A fake WASM memory holding cell_data at offset 0.
function freshMap() {
  const memory = { buffer: new ArrayBuffer(TOTAL_CELLS * 2) };
  registerSim({ memory, cellDataPtr: 0 });
  return new Uint16Array(memory.buffer);
}

describe('rows handed to the GPU', () => {
  it('nothing to upload when nothing changed; only the changed rows otherwise', () => {
    freshMap();
    takeDirtyRowSpans(); // registering marks everything
    expect(takeDirtyRowSpans()).toEqual([]);
    applyOwnerDelta(encodeDelta(Uint32Array.of(pack(10 * COLS + 5, 3), pack(500 * COLS, 4))));
    expect(takeDirtyRowSpans()).toEqual([[10, 10], [500, 500]]);
    // Writing the same owner again changes nothing.
    applyOwnerDelta(encodeDelta(Uint32Array.of(pack(10 * COLS + 5, 3))));
    expect(takeDirtyRowSpans()).toEqual([]);
  });

  it('merges nearby rows into one upload', () => {
    freshMap();
    takeDirtyRowSpans();
    applyOwnerDelta(encodeDelta(Uint32Array.of(pack(100 * COLS, 1), pack(105 * COLS, 1), pack(300 * COLS, 1))));
    expect(takeDirtyRowSpans()).toEqual([[100, 105], [300, 300]]);
    markAllDirty();
    expect(takeDirtyRowSpans()).toEqual([[0, ROWS - 1]]);
  });
});

describe('fortification zones after a delta', () => {
  it('updating only the changed cells gives the same map as redoing every zone', () => {
    // Overlapping towers of two factions plus one under construction.
    const buildings = [
      { type: 'defense', row: 300, col: 300, radius: 30, defTier: 10, factionId: 1 },
      { type: 'defense', row: 320, col: 330, radius: 30, defTier: 10, factionId: 1 },
      { type: 'defense', row: 310, col: 350, radius: 30, defTier: 10, factionId: 2 },
      { type: 'defense', row: 600, col: 900, radius: 30, defTier: 10, factionId: 3, constructing: true },
    ];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    // Same starting map in both: owners around the towers, zones stamped.
    const start = new Uint16Array(TOTAL_CELLS);
    for (let r = 250; r < 380; r++) for (let c = 250; c < 400; c++) start[r * COLS + c] = 1 + Math.floor(rnd() * 3);
    const deltas = [];
    for (let k = 0; k < 20; k++) {
      const ids = new Set();
      for (let n = 0; n < 400; n++) ids.add((250 + Math.floor(rnd() * 130)) * COLS + 250 + Math.floor(rnd() * 150));
      deltas.push(encodeDelta(Uint32Array.from([...ids].sort((a, b) => a - b).map((i) => pack(i, Math.floor(rnd() * 4))))));
    }

    const run = (incremental) => {
      const cells = freshMap();
      cells.set(start);
      resyncBuildingZones(buildings);
      for (const d of deltas) {
        const changed = applyOwnerDelta(d);
        if (incremental) resyncZonesForCells(changed, buildings);
        else resyncBuildingZones(buildings);
      }
      return cells.slice();
    };
    const full = run(false);
    const incremental = run(true);
    let differ = 0;
    for (let i = 0; i < TOTAL_CELLS; i++) if (full[i] !== incremental[i]) differ++;
    expect(differ).toBe(0);
    // The scenario really exercised the zones: some cells inside are fortified.
    expect(full.some((v) => ((v >> 11) & 0xF) === 10)).toBe(true);
  });
});
