// Where factions start when the player didn't pick a spot (bots, and humans
// who let the spawn timer run out). Shared by roomManager.finalizeSpawns and
// scripts/bench-room.mjs, so the bench measures the real placement.
//
// mode 'random': the first random land cell outside every taken spot's safe
//   zone (the original behaviour; clusters easily with many players).
// mode 'spread': best-candidate sampling — for each spawn, try `candidates`
//   random land cells and keep the one farthest from every spawn so far, so
//   factions start evenly spread over the land.

import { terrainAt, TERRAIN } from '../../src/js/mapGen.js';

const W = 1920;
const H = 1080;

function randomLand(mapId, rand) {
  for (let guard = 0; guard < 20000; guard++) {
    const row = Math.floor(rand() * H);
    const col = Math.floor(rand() * W);
    if (terrainAt(col / W, row / H, mapId) !== TERRAIN.WATER) return { row, col };
  }
  return { row: H >> 1, col: W >> 1 };
}

const dist2 = (a, b) => (a.row - b.row) ** 2 + (a.col - b.col) ** 2;

// taken: spots already chosen (players' picks). Returns `count` new spots.
export function placeSpawns({ taken = [], count, mapId, safeRadius = 80, mode = 'spread', candidates = 40, rand = Math.random }) {
  const all = [...taken];
  const out = [];
  for (let n = 0; n < count; n++) {
    let pick = null;
    if (mode === 'random') {
      for (let attempt = 0; attempt < 1000 && !pick; attempt++) {
        const c = randomLand(mapId, rand);
        if (!all.some((s) => dist2(s, c) < safeRadius * safeRadius)) pick = c;
      }
      // Every land cell is inside a safe zone (crowded rooms): any land will do.
      if (!pick) pick = randomLand(mapId, rand);
    } else {
      let best = -1;
      for (let k = 0; k < candidates; k++) {
        const c = randomLand(mapId, rand);
        let nearest = Infinity;
        for (const s of all) { const d = dist2(s, c); if (d < nearest) nearest = d; }
        if (nearest > best) { best = nearest; pick = c; }
      }
    }
    all.push(pick);
    out.push(pick);
  }
  return out;
}

// Distance from each spot to its nearest neighbour (crowding metric).
export function nearestNeighbourDistances(spots) {
  return spots.map((a, i) => {
    let m = Infinity;
    spots.forEach((b, j) => { if (i !== j) m = Math.min(m, dist2(a, b)); });
    return Math.sqrt(m);
  });
}
