// The client's map cache: the sim-delta codec, the rows handed to the GPU,
// and the incremental fortification update (src/js/deltaCodec.js, simBridge.js).
import { describe, it, expect } from 'vitest';
import { encodeDelta, decodeDelta } from './deltaCodec.js';
import {
  registerSim, applyOwnerDelta, resyncZonesForCells, resyncBuildingZones,
  takeDirtyRects, markAllDirty,
} from './simBridge.js';
import { TOTAL_CELLS, COLS, ROWS } from './constants.js';

const pack = (id, owner) => (id | (owner << 25)) >>> 0;
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

describe('rectangles handed to the GPU', () => {
  it('nothing to upload when nothing changed; only the changed tiles otherwise', () => {
    freshMap();
    takeDirtyRects(); // registering marks everything
    expect(takeDirtyRects()).toEqual([]);
    applyOwnerDelta(encodeDelta(Uint32Array.of(pack(10 * COLS + 5, 3), pack(500 * COLS + 1000, 4))));
    // The 32×32 tiles holding (10, 5) and (500, 1000).
    expect(takeDirtyRects()).toEqual([[0, 0, 32, 32], [992, 480, 32, 32]]);
    // Writing the same owner again changes nothing.
    applyOwnerDelta(encodeDelta(Uint32Array.of(pack(10 * COLS + 5, 3))));
    expect(takeDirtyRects()).toEqual([]);
  });

  it('joins neighbouring tiles along a row; the whole map when most of it changed', () => {
    freshMap();
    takeDirtyRects();
    applyOwnerDelta(encodeDelta(Uint32Array.of(pack(100 * COLS + 40, 1), pack(100 * COLS + 70, 1), pack(100 * COLS + 300, 1))));
    expect(takeDirtyRects()).toEqual([[32, 96, 64, 32], [288, 96, 32, 32]]);
    markAllDirty();
    expect(takeDirtyRects()).toEqual([[0, 0, COLS, ROWS]]);
  });

  it('a spectator-like delta (fronts all over the map) uploads far less than the rows it touches', () => {
    freshMap();
    takeDirtyRects();
    const ids = [];
    for (let k = 0; k < 60; k++) {
      const r0 = (k * 97) % (ROWS - 20);
      const c0 = (k * 389) % (COLS - 20);
      for (let i = 0; i < 40; i++) ids.push((r0 + (i % 12)) * COLS + c0 + (i >> 2));
    }
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    applyOwnerDelta(encodeDelta(Uint32Array.from(sorted.map((i) => pack(i, 2)))));
    const bytes = takeDirtyRects().reduce((n, [, , w, h]) => n + w * h * 2, 0);
    const rows = new Set(sorted.map((i) => Math.floor(i / COLS))).size;
    expect(bytes).toBeLessThan(rows * COLS * 2 / 4);
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

describe('fog of war (sim-vision)', () => {
  it('round-trips a vision update', async () => {
    const { encodeVision, decodeVision } = await import('./fogCodec.js');
    const owners = new Uint8Array(2 * 64).map((_, i) => i % 7);
    const v = decodeVision(encodeVision([5, 900], [12], owners));
    expect([...v.shown]).toEqual([5, 900]);
    expect([...v.hidden]).toEqual([12]);
    expect([...v.owners]).toEqual([...owners]);
  });

  it('the first update fogs everything not in view; blocks come and go', async () => {
    const { encodeVision } = await import('./fogCodec.js');
    const { applyVision, fogEnabled, fogLayers, isCellVisible, resetFog } = await import('./simBridge.js');
    const cells = freshMap();
    resetFog();
    expect(fogEnabled()).toBe(false);
    expect(isCellVisible(0)).toBe(true); // no fog before the match
    const bw = COLS / 8;
    const block = 3 * bw + 4; // rows 24-31, cols 32-39
    const changed = applyVision(encodeVision([block], [], new Uint8Array(64).fill(9)));
    expect(fogEnabled()).toBe(true);
    expect(changed.length).toBe(64);
    expect(cells[24 * COLS + 32] & 0x7F).toBe(9);
    expect(cells[31 * COLS + 39] & 0x7F).toBe(9);
    expect(cells[23 * COLS + 32] & 0x7F).toBe(0);
    expect(isCellVisible(24 * COLS + 32)).toBe(true);
    expect(isCellVisible(0)).toBe(false);
    expect(fogLayers().vis.reduce((n, x) => n + (x ? 1 : 0), 0)).toBe(1);
    applyVision(encodeVision([], [block], new Uint8Array(0)));
    expect(isCellVisible(24 * COLS + 32)).toBe(false);
    expect(cells[24 * COLS + 32] & 0x7F).toBe(9); // last seen stays
  });
});
