// End-to-end room benchmark: runs the REAL simulation worker (WASM, map
// terrain, victory rules) with every faction controlled by a bot, and reports
// tick cost, bandwidth and how the match played out. No browser or server.
//
//   npm run build:wasm:node            # once, and after any Rust change
//   node scripts/bench-room.mjs        # options: PLAYERS=20 MAP=north_america
//                                      #          SECONDS=600 SIM_TICK_HZ=25
//
// Exits non-zero if the worker crashes, a message is malformed, or the
// full-state sync does not reproduce the delta-built map.

import { Worker } from 'worker_threads';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { terrainAt, TERRAIN } from '../src/js/mapGen.js';
import { decodeDelta } from '../src/js/deltaCodec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, '..', 'server', 'game', 'simulationWorker.js');

const PLAYERS = parseInt(process.env.PLAYERS) || 20;
const MAP = process.env.MAP || 'north_america';
const SECONDS = parseInt(process.env.SECONDS) || 600;
const TEAMS = process.env.TEAMS === '2';
const TOTAL_CELLS = 1920 * 1080;

const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exitCode = 1; };

// Spread spawns over land, at least 80 cells apart (as finalizeSpawns does).
function pickSpawns(n) {
  const spawns = [];
  let guard = 0;
  while (spawns.length < n && guard++ < 200000) {
    const row = Math.floor(Math.random() * 1080);
    const col = Math.floor(Math.random() * 1920);
    if (terrainAt(col / 1920, row / 1080, MAP) === TERRAIN.WATER) continue;
    if (spawns.some(s => (s.row - row) ** 2 + (s.col - col) ** 2 < 80 * 80)) continue;
    spawns.push({ row, col });
  }
  return spawns;
}

const worker = new Worker(WORKER, {
  workerData: {
    roomId: 'BENCH',
    numPlayers: PLAYERS,
    mapId: MAP,
    opts: {
      domination: TEAMS ? { share: 0.75, decayStartSec: 240, decayEverySec: 30, decayStep: 0.05, floor: 0.5 }
        : { share: 0.65, decayStartSec: 180, decayEverySec: 30, decayStep: 0.05, floor: 0.40 },
      // TEAMS=2 splits the factions into two teams (as in a guild war):
      // the first half is team "A", the rest team "B".
      teams: TEAMS ? Object.fromEntries(Array.from({ length: PLAYERS }, (_, i) => [i + 1, i < PLAYERS / 2 ? 'A' : 'B'])) : null,
    },
    env: { SIM_TICK_HZ: process.env.SIM_TICK_HZ },
  },
});

const started = Date.now();
const bytes = { 'sim-delta': 0, 'sim-stats': 0, other: 0 };
const counts = {};
const owners = new Uint8Array(TOTAL_CELLS); // map rebuilt from deltas only
const loads = [];
const deltaPayloads = []; // kept to measure the compressed (on-the-wire) size

// Apply one sim-delta to the bench's own map (same decoding as the client).
function applyDelta(buf, map) {
  decodeDelta(buf, (id, owner) => { map[id] = owner; });
}
let eliminated = 0;
let lastStats = null;
let fullCheckDone = false;
let bountyNow = 0;
let bountySince = 0;
const bountySpans = [];

const elapsed = () => ((Date.now() - started) / 1000).toFixed(0).padStart(4) + 's';

worker.on('message', (msg) => {
  if (msg.type === 'ready') {
    for (const [i, s] of pickSpawns(PLAYERS).entries()) {
      worker.postMessage({ type: 'spawnFaction', factionId: i + 1, row: s.row, col: s.col });
    }
    worker.postMessage({ type: 'setBotFactions', factionIds: Array.from({ length: PLAYERS }, (_, i) => i + 1) });
    return;
  }
  if (msg.type === 'room-error') { fail(`worker crashed: ${msg.message}`); worker.terminate(); return; }
  if (msg.type === 'load-report') { loads.push(msg); return; }
  if (msg.type === 'log' && msg.level !== 'info') { console.log(`[worker ${msg.level}] ${msg.payload}`); return; }

  if (msg.type === 'emit') {
    counts[msg.event] = (counts[msg.event] || 0) + 1;
    if (msg.event === 'sim-delta') {
      bytes['sim-delta'] += msg.payload.byteLength;
      deltaPayloads.push(msg.payload);
      applyDelta(msg.payload, owners);
    } else if (msg.event === 'sim-stats') {
      bytes['sim-stats'] += msg.payload.byteLength;
      lastStats = msg.payload;
      // Bounty placements: how often, on whom, for how long (flicker check).
      const b = new DataView(msg.payload).getUint32(16, true);
      if (b !== bountyNow) {
        if (bountyNow) bountySpans.push(`${bountyNow} for ${((Date.now() - bountySince) / 1000).toFixed(0)}s`);
        bountyNow = b;
        bountySince = Date.now();
      }
    } else {
      bytes.other += JSON.stringify(msg.payload).length;
    }
    if (msg.event === 'player-eliminated') {
      eliminated++;
      const p = msg.payload;
      console.log(`${elapsed()}  faction ${p.factionId} out (#${p.placement}, by ${p.killerId || '—'}), ${p.aliveCount} left`);
    }
    // Midway, ask for a full-state sync and check it matches the delta-built map.
    if (!fullCheckDone && eliminated >= Math.floor(PLAYERS / 3)) {
      fullCheckDone = true;
      worker.postMessage({ type: 'fullState', socketId: 'probe' });
    }
    return;
  }

  if (msg.type === 'emitToSocket' && msg.event === 'sim-full') {
    const runs = new Uint32Array(msg.payload.owners);
    let i = 0;
    let mismatches = 0;
    for (const v of runs) {
      const owner = v >>> 24;
      for (let n = v & 0xFFFFFF; n > 0; n--, i++) if (owners[i] !== owner) mismatches++;
    }
    // Deltas still in flight when the probe ran make a handful of cells differ.
    const ok = i === TOTAL_CELLS && mismatches < 2000;
    console.log(`${elapsed()}  full-state sync: ${runs.length} runs (${(runs.byteLength / 1024).toFixed(0)} KB), ` +
      `${msg.payload.buildings.length} buildings, ${mismatches} cells differ from the delta-built map`);
    if (!ok) fail(`full-state sync does not match (covered ${i} cells, ${mismatches} differ)`);
    return;
  }

  if (msg.type === 'gameOver') {
    const secs = (Date.now() - started) / 1000;
    console.log(`${elapsed()}  GAME OVER — winner ${msg.winner}${msg.byDomination ? ' (domination)' : ''}`);
    if (TEAMS) {
      const team = (f) => (f <= PLAYERS / 2 ? 'A' : 'B');
      const firsts = Object.entries(msg.stats).filter(([, st]) => st.placement === 1).map(([f]) => Number(f));
      console.log(`           team ${team(msg.winner)} wins; placement 1: factions ${firsts.join(', ')} (${firsts.every(f => team(f) === team(msg.winner)) ? 'all on the winning team' : 'MIXED TEAMS — bug'})`);
    }
    report(secs);
    clearTimeout(limit);
    worker.postMessage({ type: 'destroy' });
  }
});

worker.on('error', (e) => { fail(`worker error: ${e.message}`); });
worker.on('exit', () => { if (!process.exitCode) process.exitCode = 0; });

const raceLog = setInterval(() => {
  if (!lastStats) return;
  const dv = new DataView(lastStats);
  const land = dv.getUint32(4, true);
  const n = dv.getUint16(12, true);
  const rec = dv.getUint16(14, true);
  let top = 0;
  let alive = 0;
  for (let f = 1; f <= n; f++) {
    const c = dv.getUint32(20 + (f - 1) * rec + 12, true);
    if (c > top) top = c;
    if (c > 0) alive++;
  }
  const bounty = dv.getUint32(16, true);
  console.log(`${elapsed()}  land leader ${(100 * top / land).toFixed(1)}%, ${alive} alive, target ${(dv.getFloat32(8, true) * 100).toFixed(0)}%${bounty ? `, bounty on ${bounty}` : ''}`);
}, 60000);
raceLog.unref();

const limit = setTimeout(() => {
  console.log(`${elapsed()}  time limit reached without a winner`);
  report((Date.now() - started) / 1000);
  worker.terminate();
}, SECONDS * 1000);

// What the deltas cost on the wire. Socket.IO compresses each message of
// 2 KB or more with permessage-deflate (server.js: threshold 2048), keeping the
// compression context between messages; smaller ones go as they are.
async function wireBytes(payloads) {
  const deflate = zlib.createDeflateRaw();
  let out = 0;
  deflate.on('data', (c) => { out += c.length; });
  for (const p of payloads) {
    if (p.byteLength < 2048) { out += p.byteLength; continue; }
    await new Promise((r) => { deflate.write(Buffer.from(p)); deflate.flush(zlib.constants.Z_SYNC_FLUSH, r); });
    out -= 4; // permessage-deflate drops the 00 00 FF FF tail of each flush
  }
  deflate.end();
  return out;
}

async function report(secs) {
  const avg = (k) => loads.length ? loads.reduce((s, l) => s + l[k], 0) / loads.length : 0;
  const max = (k) => loads.reduce((m, l) => Math.max(m, l[k]), 0);
  console.log('\n── room load (from the worker\'s own load reports) ──');
  console.log(`tick cost      avg ${avg('avgTickMs').toFixed(2)} ms, worst ${max('maxTickMs').toFixed(1)} ms`);
  console.log(`tick budget    avg ${(avg('tickBudgetUsed') * 100).toFixed(1)}%, peak ${(max('tickBudgetUsed') * 100).toFixed(1)}% of one core`);
  console.log(`room memory    ${max('wasmMB')} MB of WASM heap (plus one V8 isolate)`);
  console.log('── wire, per connected client ──');
  const kb = (b) => (b / 1024 / secs).toFixed(1);
  const wire = await wireBytes(deltaPayloads);
  if (process.env.DUMP_DELTAS) {
    // Length-prefixed raw payloads, for offline encoding experiments.
    const parts = deltaPayloads.flatMap((p) => [Buffer.from(Uint32Array.of(p.byteLength).buffer), Buffer.from(p)]);
    fs.writeFileSync(process.env.DUMP_DELTAS, Buffer.concat(parts));
  }
  console.log(`sim-delta on the wire (permessage-deflate) ${kb(wire)} KB/s`);
  console.log(`sim-delta ${kb(bytes['sim-delta'])} KB/s (${counts['sim-delta'] || 0} msgs), ` +
    `sim-stats ${kb(bytes['sim-stats'])} KB/s (${counts['sim-stats'] || 0} msgs), other events ${kb(bytes.other)} KB/s`);
  if (!lastStats) { fail('no sim-stats received'); return; }
  // Land race at the end, from the last stats record (layout: STATS_* in lib.rs).
  const dv = new DataView(lastStats);
  const land = dv.getUint32(4, true);
  const n = dv.getUint16(12, true);
  const rec = dv.getUint16(14, true);
  const cells = [];
  for (let f = 1; f <= n; f++) cells.push(dv.getUint32(20 + (f - 1) * rec + 12, true));
  cells.sort((a, b) => b - a);
  const pct = (c) => (100 * c / land).toFixed(1) + '%';
  console.log(`land race      leader ${pct(cells[0])}, 2nd ${pct(cells[1] || 0)}, 3rd ${pct(cells[2] || 0)}; ` +
    `${cells.filter(c => c > 0).length} alive; domination target ${(dv.getFloat32(8, true) * 100).toFixed(0)}%`);
  if (bountyNow) bountySpans.push(`${bountyNow} for ${((Date.now() - bountySince) / 1000).toFixed(0)}s (until the end)`);
  console.log(`bounties      ${bountySpans.length ? bountySpans.join(', ') : 'none'}`);
  if (!fullCheckDone) console.log('(full-state check did not run: too few eliminations)');
}
