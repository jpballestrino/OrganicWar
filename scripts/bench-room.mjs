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
import path from 'path';
import { fileURLToPath } from 'url';
import { terrainAt, TERRAIN } from '../src/js/mapGen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, '..', 'server', 'game', 'simulationWorker.js');

const PLAYERS = parseInt(process.env.PLAYERS) || 20;
const MAP = process.env.MAP || 'north_america';
const SECONDS = parseInt(process.env.SECONDS) || 600;
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
    opts: { domination: { share: 0.65, decayStartSec: 180, decayEverySec: 30, decayStep: 0.05, floor: 0.40 } },
    env: { SIM_TICK_HZ: process.env.SIM_TICK_HZ },
  },
});

const started = Date.now();
const bytes = { 'sim-delta': 0, 'sim-stats': 0, other: 0 };
const counts = {};
const owners = new Uint8Array(TOTAL_CELLS); // map rebuilt from deltas only
const loads = [];
let eliminated = 0;
let lastStats = null;
let fullCheckDone = false;

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
      const d = new Uint32Array(msg.payload);
      for (const v of d) owners[v & 0x1FFFFF] = v >>> 21;
    } else if (msg.event === 'sim-stats') {
      bytes['sim-stats'] += msg.payload.byteLength;
      lastStats = msg.payload;
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
    report(secs);
    clearTimeout(limit);
    worker.postMessage({ type: 'destroy' });
  }
});

worker.on('error', (e) => { fail(`worker error: ${e.message}`); });
worker.on('exit', () => { if (!process.exitCode) process.exitCode = 0; });

const limit = setTimeout(() => {
  console.log(`${elapsed()}  time limit reached without a winner`);
  report((Date.now() - started) / 1000);
  worker.terminate();
}, SECONDS * 1000);

function report(secs) {
  const avg = (k) => loads.length ? loads.reduce((s, l) => s + l[k], 0) / loads.length : 0;
  const max = (k) => loads.reduce((m, l) => Math.max(m, l[k]), 0);
  console.log('\n── room load (from the worker\'s own load reports) ──');
  console.log(`tick cost      avg ${avg('avgTickMs').toFixed(2)} ms, worst ${max('maxTickMs').toFixed(1)} ms`);
  console.log(`tick budget    avg ${(avg('tickBudgetUsed') * 100).toFixed(1)}%, peak ${(max('tickBudgetUsed') * 100).toFixed(1)}% of one core`);
  console.log(`worker RSS     ${max('rssMB')} MB`);
  console.log('── wire, per connected client ──');
  const kb = (b) => (b / 1024 / secs).toFixed(1);
  console.log(`sim-delta ${kb(bytes['sim-delta'])} KB/s (${counts['sim-delta'] || 0} msgs), ` +
    `sim-stats ${kb(bytes['sim-stats'])} KB/s (${counts['sim-stats'] || 0} msgs), other events ${kb(bytes.other)} KB/s`);
  if (!lastStats) fail('no sim-stats received');
  if (!fullCheckDone) console.log('(full-state check did not run: too few eliminations)');
}
