// Dedicated worker thread for running a single room's authoritative simulation.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parentPort, workerData } from 'worker_threads';
import { generateTerrain } from '../../src/js/mapGen.js';
import { MAX_FACTIONS } from '../../src/js/constants.js';
import { encodeDelta } from '../../src/js/deltaCodec.js';
// We cannot use the global logger cleanly since it writes to files and we are in a thread.
// We can either post logs to the parent or just use console.log. Let's post them.
function logInfo(msg) {
  parentPort.postMessage({ type: 'log', level: 'info', payload: msg });
}
function logWarn(msg) {
  parentPort.postMessage({ type: 'log', level: 'warn', payload: msg });
}
function logError(msg) {
  parentPort.postMessage({ type: 'log', level: 'error', payload: msg });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WASM_PATH = path.join(__dirname, '..', 'wasm', 'simulation_core_bg.wasm');

const MAP_WIDTH = 1920;
const MAP_HEIGHT = 1080;
const TOTAL_CELLS = MAP_WIDTH * MAP_HEIGHT;

// Input validators: gate every WASM call so a bad value can't index out of
// bounds inside the sim (a panic there kills the whole room).
const validCell = (c) => Number.isInteger(c) && c >= 0 && c < TOTAL_CELLS;
const validPct  = (p) => typeof p === 'number' && p >= 1 && p <= 90;

// Building types, indexed by the sim's BTYPE_* tag. `type` is the wire name;
// `buildMs` mirrors the *_BUILD_SECONDS consts in simulation-core/src/lib.rs
// (the sim decides when a building really completes — this only drives the
// client's progress bar); `extra` rides along in building-placed/-completed.
const BUILDING_TYPES = [
  { type: 'defense', buildMs: 5000,  extra: { radius: 40, defTier: 10 } },
  { type: 'silo',    buildMs: 10000, extra: { range: 240 } },
  { type: 'mine',    buildMs: 10000, extra: {} },
  { type: 'antiair', buildMs: 10000, extra: {} },
  { type: 'city',    buildMs: 5000,  extra: {} },
];
// sim-input type → the sim export that places that building, and its BTYPE tag.
const BUILD_INPUTS = {
  build_defense: { place: 'simulationstate_place_defense_building', btype: 0 },
  build_silo:    { place: 'simulationstate_place_silo',             btype: 1 },
  build_mine:    { place: 'simulationstate_place_mine',             btype: 2 },
  build_antiair: { place: 'simulationstate_place_antiair',          btype: 3 },
  build_city:    { place: 'simulationstate_place_city',             btype: 4 },
};
// Holding 1st place on the scoreboard this long counts as "took the lead"
// (mirrors the 3 s stability rule in src/js/matchFeel.js).
const LEAD_HOLD_SEC = 3;

// write_buildings() record width (BUILDING_EXPORT_FIELDS in lib.rs).
const BUILDING_EXPORT_FIELDS = 7;

function buildingPayload(btype, factionId, center) {
  const def = BUILDING_TYPES[btype] || BUILDING_TYPES[0];
  return {
    type: def.type,
    factionId,
    row: Math.floor(center / MAP_WIDTH),
    col: center % MAP_WIDTH,
    ...def.extra,
  };
}

const wasmBytes = fs.readFileSync(WASM_PATH);
const wasmModule = new WebAssembly.Module(wasmBytes);

function buildImports(getInstance) {
  const stubs = {};
  for (const desc of WebAssembly.Module.imports(wasmModule)) {
    if (!stubs[desc.module]) stubs[desc.module] = {};
    if (desc.name.includes('throw')) {
      stubs[desc.module][desc.name] = (ptr, len) => {
        const view = new Uint8Array(getInstance().exports.memory.buffer, ptr, len);
        throw new Error(new TextDecoder('utf-8').decode(view));
      };
    } else if (desc.name.includes('init_externref_table')) {
      stubs[desc.module][desc.name] = () => {
        const table = getInstance().exports.__wbindgen_externrefs;
        if (!table) return;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      };
    } else {
      stubs[desc.module][desc.name] = () => undefined;
    }
  }
  return stubs;
}

function instantiate() {
  let instance;
  const imports = buildImports(() => instance);
  instance = new WebAssembly.Instance(wasmModule, imports);
  if (instance.exports.__wbindgen_start) instance.exports.__wbindgen_start();
  return instance.exports;
}

class RoomSimWorker {
  constructor({ roomId, numPlayers, mapId, opts, env }) {
    this.roomId = roomId;
    this.mapId = mapId || 'north_america';
    this.exports = instantiate();
    this.statePtr = this.exports.simulationstate_new();
    this.env = env || {};
    // Player capacity comes from the sim itself (MAX_PLAYERS in lib.rs).
    this.maxPlayers = this.exports.simulationstate_max_players();
    this.arraySize = this.maxPlayers + 1; // index 0 = neutral
    if (this.maxPlayers !== MAX_FACTIONS) {
      // The client sizes its colour tables and shader arrays from MAX_FACTIONS;
      // a mismatch would mis-draw (or reject) factions above the smaller cap.
      throw new Error(`sim MAX_PLAYERS (${this.maxPlayers}) != MAX_FACTIONS (${MAX_FACTIONS}) in src/js/constants.js — rebuild the WASM`);
    }

    const cellPtr = this.exports.simulationstate_get_cell_data_ptr(this.statePtr);
    generateTerrain(this.exports.memory, cellPtr, this.mapId);

    // Total conquerable land (terrain bits 7-10; 3 = water), counted once: the
    // denominator for the domination victory and the clients' "% of map" HUD.
    const terrainCells = new Uint16Array(this.exports.memory.buffer, cellPtr, TOTAL_CELLS);
    let land = 0;
    for (let i = 0; i < TOTAL_CELLS; i++) {
      if (((terrainCells[i] >> 7) & 0xF) !== 3) land++;
    }
    this.landCells = land;
    // Domination rule: { share, decayStartSec, decayEverySec, decayStep, floor }
    // (null/absent disables). See _dominationShare() for the schedule.
    // Teams (guild wars): { fid: teamId }. Teammates can't attack each other,
    // and the match is won by a team — the last one standing, or the one
    // holding the domination share of the land together.
    this.teams = opts.teams && Object.keys(opts.teams).length ? opts.teams : null;
    const dom = opts.domination;
    this.domination = dom && Number(dom.share) > 0 ? {
      share: Number(dom.share),
      decayStartSec: Number(dom.decayStartSec) || 0,
      decayEverySec: Number(dom.decayEverySec) || 0,
      decayStep: Number(dom.decayStep) || 0,
      floor: Number(dom.floor) || Number(dom.share),
    } : null;

    this.exports.simulationstate_init_players(
      this.statePtr,
      Math.max(1, Math.min(this.maxPlayers, numPlayers)),
      opts.startGold ?? 500,
      opts.startGrowthRate ?? 50,
      opts.startMaxCap ?? 5000,
    );

    this.tickHz = parseInt(this.env.SIM_TICK_HZ) || 25;
    this.exports.simulationstate_set_tick_hz(this.statePtr, this.tickHz);
    // Owner deltas go out ~20×/s (the map must feel live); the per-player
    // stats only ~5×/s (numbers on a HUD).
    this.snapshotEveryTicks = Math.max(1, Math.floor(this.tickHz / 20));
    this.statsEveryTicks = Math.max(1, Math.round(this.tickHz / 5));
    this.destroyed = false;

    this.botFactions = [];
    this.botThinkEveryTicks = Math.max(1, Math.floor(this.tickHz * 1.5));
    this.botBuildEveryTicks = Math.max(1, Math.floor(this.tickHz * 3));

    this.prevAlive = new Set();
    this.gameOverFired = false;

    // Per-match bookkeeping for the end-of-match recap (placement, peak land,
    // survival time, who finished whom). JS-side only — the sim is untouched.
    this.startedAt = Date.now();
    this.peakCells = new Uint32Array(this.arraySize);
    // Per-faction counters for server-side XP (server/game/progression.js):
    // rivals eliminated, defense towers placed, missiles fired, and whether the
    // faction ever held 1st place on the leaderboard for LEAD_HOLD_SEC.
    this.eliminations = new Uint32Array(this.arraySize);
    this.towersBuilt = new Uint32Array(this.arraySize);
    this.missilesFired = new Uint32Array(this.arraySize);
    this.tookLead = new Uint8Array(this.arraySize);
    this.leadCandidate = 0;
    this.leadSinceMs = 0;
    this.placements = {};
    this.survivedSec = {};

    this.profileMetrics = {
      tickCount: 0,
      totalTickMs: 0,
      maxTickMs: 0,
      snapshotCount: 0,
      totalPayloadBytes: 0,
      totalDirtyCells: 0,
      lastLogTime: Date.now()
    };

    this.tickInterval = setInterval(() => this._safeTick(), Math.floor(1000 / this.tickHz));

    // Report load to the main thread for /healthz and capacity decisions: how
    // much of each tick's time budget the sim uses, and the wire rate.
    this.load = { ticks: 0, tickMs: 0, maxTickMs: 0, bytes: 0, since: Date.now() };
    this.memReportInterval = setInterval(() => {
      if (this.destroyed) return;
      const l = this.load;
      const now = Date.now();
      const seconds = Math.max(0.001, (now - l.since) / 1000);
      parentPort.postMessage({
        type: 'load-report',
        // This room's own WASM heap (process RSS is shared by every room).
        wasmMB: Math.round(this.exports.memory.buffer.byteLength / 1024 / 1024),
        avgTickMs: l.ticks ? l.tickMs / l.ticks : 0,
        maxTickMs: l.maxTickMs,
        // Share of the tick interval spent simulating (1.0 = saturated).
        tickBudgetUsed: l.ticks ? (l.tickMs / l.ticks) / (1000 / this.tickHz) : 0,
        kbPerSec: l.bytes / 1024 / seconds,
      });
      this.load = { ticks: 0, tickMs: 0, maxTickMs: 0, bytes: 0, since: now };
    }, 5000);

    logInfo(`[Sim ${roomId}] Worker started: ${numPlayers} players, ${this.tickHz} Hz`);
    parentPort.postMessage({ type: 'ready' });
  }

  _safeTick() {
    if (this.destroyed) return;
    try {
      const t0 = performance.now();
      this.exports.simulationstate_tick(this.statePtr);
      const t1 = performance.now();

      const tickMs = t1 - t0;
      this.load.ticks++;
      this.load.tickMs += tickMs;
      if (tickMs > this.load.maxTickMs) this.load.maxTickMs = tickMs;
      this.profileMetrics.tickCount++;
      this.profileMetrics.totalTickMs += tickMs;
      if (tickMs > this.profileMetrics.maxTickMs) this.profileMetrics.maxTickMs = tickMs;

      const tick = this.exports.simulationstate_get_current_tick(this.statePtr);
      if (this.botFactions.length && tick % this.botThinkEveryTicks === 0) {
        this._botThink();
      }
      if (this.botFactions.length && tick % this.botBuildEveryTicks === 0) {
        this.exports.simulationstate_bot_build_all(this.statePtr);
      }
      if (this.botFactions.length && tick % (this.tickHz * 2) === 0) {
        this.exports.simulationstate_bot_fire_missiles(this.statePtr);
      }
      if (tick % this.snapshotEveryTicks === 0) {
        this._sendDelta();
        this._checkAlive();
      }
      if (tick % this.statsEveryTicks === 0) {
        this._sendStats(tick);
      }
      this._emitDestroyedBuildings();
      this._emitPlacedBuildings();
      this._emitFiredMissiles();
      this._emitInterceptedMissiles();
      // Owner transfers before completions so a silo that flips owner and completes
      // on the same tick has its factionId updated before the completion lookup.
      this._emitTransferredBuildings();
      this._emitCompletedBuildings();
      this._emitPlunder();
      this._emitBuildingUpdates();

      if (this.env.SIM_PROFILE === '1') {
        const now = Date.now();
        if (now - this.profileMetrics.lastLogTime >= 5000) {
          this._logProfileSummary(now);
        }
      }
    } catch (err) {
      logError(`[Sim ${this.roomId}] tick failed: ${err.message}`);
      parentPort.postMessage({ type: 'room-error', message: err.message });
      this.destroy();
    }
  }

  _logProfileSummary(now) {
    const dtSeconds = (now - this.profileMetrics.lastLogTime) / 1000;
    const avgTick = this.profileMetrics.tickCount > 0 ? (this.profileMetrics.totalTickMs / this.profileMetrics.tickCount) : 0;
    const payloadKBps = dtSeconds > 0 ? (this.profileMetrics.totalPayloadBytes / 1024 / dtSeconds) : 0;
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);

    logInfo(`[Sim ${this.roomId} PROFILE Worker] ` +
      `Tick: avg ${avgTick.toFixed(2)}ms, max ${this.profileMetrics.maxTickMs.toFixed(2)}ms | ` +
      `Deltas: ${this.profileMetrics.snapshotCount} | ` +
      `Net: ${payloadKBps.toFixed(2)} KB/s | ` +
      `Dirty/snap: ${(this.profileMetrics.snapshotCount > 0 ? this.profileMetrics.totalDirtyCells / this.profileMetrics.snapshotCount : 0).toFixed(1)} | ` +
      `RSS: ${rssMB} MB`);

    this.profileMetrics.tickCount = 0;
    this.profileMetrics.totalTickMs = 0;
    this.profileMetrics.maxTickMs = 0;
    this.profileMetrics.snapshotCount = 0;
    this.profileMetrics.totalPayloadBytes = 0;
    this.profileMetrics.totalDirtyCells = 0;
    this.profileMetrics.lastLogTime = now;
  }

  _emitDestroyedBuildings() {
    const count = this.exports.simulationstate_get_destroyed_buildings_count(this.statePtr);
    if (!count) return;
    const ptr = this.exports.simulationstate_get_destroyed_buildings_ptr(this.statePtr);
    const buf = new Uint32Array(this.exports.memory.buffer, ptr, count);
    for (let i = 0; i < count; i++) {
      const center = buf[i];
      const row = Math.floor(center / MAP_WIDTH);
      const col = center % MAP_WIDTH;
      parentPort.postMessage({ type: 'emit', event: 'building-destroyed', payload: { row, col } });
    }
    this.exports.simulationstate_clear_destroyed_buildings(this.statePtr);
  }

  _emitPlacedBuildings() {
    const count = this.exports.simulationstate_get_placed_buildings_count(this.statePtr);
    if (!count) return;
    const ptr = this.exports.simulationstate_get_placed_buildings_ptr(this.statePtr);
    const buf = new Uint32Array(this.exports.memory.buffer, ptr, count * 3);
    for (let i = 0; i < count; i++) {
      const btype = buf[i * 3 + 2];
      const payload = buildingPayload(btype, buf[i * 3 + 1], buf[i * 3]);
      payload.buildMs = (BUILDING_TYPES[btype] || BUILDING_TYPES[0]).buildMs;
      if (btype === 0) this.towersBuilt[payload.factionId]++;
      parentPort.postMessage({ type: 'emit', event: 'building-placed', payload });
    }
    this.exports.simulationstate_clear_placed_buildings(this.statePtr);
  }

  _emitFiredMissiles() {
    const count = this.exports.simulationstate_get_fired_missiles_count(this.statePtr);
    if (!count) return;
    const ptr = this.exports.simulationstate_get_fired_missiles_ptr(this.statePtr);
    const buf = new Uint32Array(this.exports.memory.buffer, ptr, count * 5);
    for (let i = 0; i < count; i++) {
      const sourceRow = buf[i * 5];
      const sourceCol = buf[i * 5 + 1];
      const targetRow = buf[i * 5 + 2];
      const targetCol = buf[i * 5 + 3];
      const factionId = buf[i * 5 + 4];
      if (factionId <= this.maxPlayers) this.missilesFired[factionId]++;
      parentPort.postMessage({ type: 'emit', event: 'missile-fired', payload: {
        sourceRow, sourceCol, targetRow, targetCol, factionId
      }});
    }
    this.exports.simulationstate_clear_fired_missiles(this.statePtr);
  }

  _emitInterceptedMissiles() {
    const count = this.exports.simulationstate_get_intercepted_missiles_count(this.statePtr);
    if (!count) return;
    const ptr = this.exports.simulationstate_get_intercepted_missiles_ptr(this.statePtr);
    const buf = new Uint32Array(this.exports.memory.buffer, ptr, count * 8);
    for (let i = 0; i < count; i++) {
      const sourceRow = buf[i * 8];
      const sourceCol = buf[i * 8 + 1];
      const targetRow = buf[i * 8 + 2];
      const targetCol = buf[i * 8 + 3];
      const batteryRow = buf[i * 8 + 4];
      const batteryCol = buf[i * 8 + 5];
      const interceptRow = buf[i * 8 + 6];
      const interceptCol = buf[i * 8 + 7];
      parentPort.postMessage({ type: 'emit', event: 'missile-intercepted', payload: {
        sourceRow, sourceCol, targetRow, targetCol, batteryRow, batteryCol, interceptRow, interceptCol
      }});
    }
    this.exports.simulationstate_clear_intercepted_missiles(this.statePtr);
  }

  // Poll buildings that finished construction this tick and broadcast
  // `building-completed` so clients stamp the fortification tier (the bonus only
  // becomes real now — placement just started a timer).
  _emitCompletedBuildings() {
    const count = this.exports.simulationstate_get_completed_buildings_count(this.statePtr);
    if (!count) return;
    const ptr = this.exports.simulationstate_get_completed_buildings_ptr(this.statePtr);
    const buf = new Uint32Array(this.exports.memory.buffer, ptr, count * 3);
    for (let i = 0; i < count; i++) {
      const payload = buildingPayload(buf[i * 3 + 2], buf[i * 3 + 1], buf[i * 3]);
      parentPort.postMessage({ type: 'emit', event: 'building-completed', payload });
    }
    this.exports.simulationstate_clear_completed_buildings(this.statePtr);
  }

  // Gold seized outside the normal economy: a tower razed by conquest
  // (salvage) or a faction eliminated (its whole treasury).
  _emitPlunder() {
    const count = this.exports.simulationstate_get_plunder_count(this.statePtr);
    if (!count) return;
    const buf = new Uint32Array(
      this.exports.memory.buffer, this.exports.simulationstate_get_plunder_ptr(this.statePtr), count * 4);
    for (let i = 0; i < count; i++) {
      parentPort.postMessage({ type: 'emit', event: 'gold-seized', payload: {
        fromId: buf[i * 4], toId: buf[i * 4 + 1], gold: buf[i * 4 + 2],
        kind: buf[i * 4 + 3] === 0 ? 'plunder' : 'salvage',
      } });
    }
    this.exports.simulationstate_clear_plunder(this.statePtr);
  }

  // Buildings whose synergy links or anti-air charges changed.
  _emitBuildingUpdates() {
    const count = this.exports.simulationstate_get_building_updates_count(this.statePtr);
    if (!count) return;
    const buf = new Uint32Array(
      this.exports.memory.buffer, this.exports.simulationstate_get_building_updates_ptr(this.statePtr), count * 3);
    for (let i = 0; i < count; i++) {
      const center = buf[i * 3];
      parentPort.postMessage({ type: 'emit', event: 'building-updated', payload: {
        row: Math.floor(center / MAP_WIDTH), col: center % MAP_WIDTH, links: buf[i * 3 + 1], charges: buf[i * 3 + 2],
      } });
    }
    this.exports.simulationstate_clear_building_updates(this.statePtr);
  }

  // Poll silos that changed owner (fully conquered) and broadcast so clients
  // recolor the icon and update who may fire from it.
  _emitTransferredBuildings() {
    const count = this.exports.simulationstate_get_transferred_buildings_count(this.statePtr);
    if (!count) return;
    const ptr = this.exports.simulationstate_get_transferred_buildings_ptr(this.statePtr);
    const buf = new Uint32Array(this.exports.memory.buffer, ptr, count * 2);
    for (let i = 0; i < count; i++) {
      const center = buf[i * 2];
      const factionId = buf[i * 2 + 1];
      const row = Math.floor(center / MAP_WIDTH);
      const col = center % MAP_WIDTH;
      parentPort.postMessage({ type: 'emit', event: 'building-owner-changed', payload: { row, col, factionId } });
    }
    this.exports.simulationstate_clear_transferred_buildings(this.statePtr);
  }

  setBotFactions(factionIds) {
    this.botFactions = Array.isArray(factionIds) ? factionIds.slice() : [];
    for (const fid of this.botFactions) {
      this.exports.simulationstate_set_player_is_bot(this.statePtr, fid, true);
    }
  }

  _botThink() {
    if (!this.botFactions.length) return;
    this.exports.simulationstate_bot_think_all(this.statePtr, 45);
  }

  // Copy `byteLength` bytes out of WASM memory into a fresh ArrayBuffer that
  // can be transferred to the main thread without another copy.
  _copyOut(ptr, byteLength) {
    return this.exports.memory.buffer.slice(ptr, ptr + byteLength);
  }

  // Owner changes since the last call, as packed u32s (see lib.rs
  // collect_dirty_cells). Nothing is sent when nothing changed.
  _sendDelta() {
    const count = this.exports.simulationstate_collect_dirty_cells(this.statePtr);
    if (!count) return;
    // The scratch buffer can move when it grows: read the pointer after collect.
    const ptr = this.exports.simulationstate_get_delta_scratch_ptr(this.statePtr);
    // Compact wire form: varint cell-id gaps + owner bytes (deltaCodec.js).
    const encoded = encodeDelta(new Uint32Array(this.exports.memory.buffer, ptr, count));
    const payload = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);

    this.profileMetrics.snapshotCount++;
    this.profileMetrics.totalPayloadBytes += payload.byteLength;
    this.profileMetrics.totalDirtyCells += count;
    this.load.bytes += payload.byteLength;

    parentPort.postMessage({ type: 'emit', event: 'sim-delta', payload, stream: true }, [payload]);
  }

  // Per-player stats record, packed by the sim (layout: STATS_* in lib.rs).
  _packStats(tick) {
    const len = this.exports.simulationstate_write_stats(
      this.statePtr, this.landCells, this._dominationShare(tick));
    const ptr = this.exports.simulationstate_get_stats_ptr(this.statePtr);
    return this._copyOut(ptr, len);
  }

  _sendStats(tick) {
    const owned = new Uint32Array(
      this.exports.memory.buffer, this.exports.simulationstate_get_player_owned_cells_ptr(this.statePtr), this.arraySize);
    for (let fid = 1; fid <= this.maxPlayers; fid++) {
      if (owned[fid] > this.peakCells[fid]) this.peakCells[fid] = owned[fid];
    }
    this._trackLeader();
    const payload = this._packStats(tick);
    this.profileMetrics.totalPayloadBytes += payload.byteLength;
    this.load.bytes += payload.byteLength;
    parentPort.postMessage({ type: 'emit', event: 'sim-stats', payload, stream: true }, [payload]);
  }

  // Who leads the scoreboard (the client's score: gold spent + kills + troops
  // incl. those on attack + land). A faction that stays #1 for LEAD_HOLD_SEC
  // "took the lead" — the same rule the client uses for its announcement.
  _trackLeader() {
    const m = this.exports.memory.buffer;
    const view = (fn, T) => new T(m, this.exports[fn](this.statePtr), this.arraySize);
    const troops = view('simulationstate_get_player_total_troops_ptr', Float32Array);
    const attack = view('simulationstate_get_player_attack_pool_ptr', Float32Array);
    const kills = view('simulationstate_get_player_kill_count_ptr', Float32Array);
    const spent = view('simulationstate_get_player_gold_spent_ptr', Float32Array);
    const owned = view('simulationstate_get_player_owned_cells_ptr', Uint32Array);
    let leader = 0;
    let best = -1;
    for (let fid = 1; fid <= this.maxPlayers; fid++) {
      if (!owned[fid]) continue;
      const score = Math.floor(spent[fid]) + Math.floor(kills[fid]) + Math.floor(troops[fid] + attack[fid]) + owned[fid];
      if (score > best) { best = score; leader = fid; }
    }
    const now = Date.now();
    if (leader !== this.leadCandidate) {
      this.leadCandidate = leader;
      this.leadSinceMs = now;
    } else if (leader && now - this.leadSinceMs >= LEAD_HOLD_SEC * 1000) {
      this.tookLead[leader] = 1;
    }
  }

  // The XP counters for one faction (see the constructor).
  _xpCounters(fid) {
    return {
      eliminations: this.eliminations[fid],
      towers: this.towersBuilt[fid],
      missiles: this.missilesFired[fid],
      tookLead: this.tookLead[fid] === 1,
    };
  }

  // Everything a client needs to rebuild the match from nothing — sent to one
  // socket when it (re)joins a running match (reconnect, page reload). Deltas
  // only carry changes, so without this such a client sees a blank map.
  sendFullState(socketId) {
    if (this.destroyed) return;
    const tick = this.exports.simulationstate_get_current_tick(this.statePtr);

    // Owners, run-length encoded (see lib.rs write_full_owners).
    const runs = this.exports.simulationstate_write_full_owners(this.statePtr);
    const owners = this._copyOut(
      this.exports.simulationstate_get_delta_scratch_ptr(this.statePtr), runs * 4);

    // Buildings (shares the scratch buffer — owners were copied out above).
    const count = this.exports.simulationstate_write_buildings(this.statePtr);
    const rec = new Uint32Array(
      this.exports.memory.buffer,
      this.exports.simulationstate_get_delta_scratch_ptr(this.statePtr),
      count * BUILDING_EXPORT_FIELDS);
    const buildings = [];
    for (let i = 0; i < count; i++) {
      const o = i * BUILDING_EXPORT_FIELDS;
      const btype = rec[o + 2];
      const b = buildingPayload(btype, rec[o + 1], rec[o]);
      const completeTick = rec[o + 3];
      b.buildMs = (BUILDING_TYPES[btype] || BUILDING_TYPES[0]).buildMs;
      b.constructing = completeTick !== 0 && completeTick > tick;
      b.remainingMs = b.constructing ? Math.round((completeTick - tick) * 1000 / this.tickHz) : 0;
      if (b.type === 'antiair') b.charges = rec[o + 4];
      b.links = rec[o + 6];
      buildings.push(b);
    }

    const stats = this._packStats(tick);
    parentPort.postMessage({
      type: 'emitToSocket', socketId, event: 'sim-full',
      payload: { owners, buildings, stats },
    }, [owners, stats]);
  }

  _checkAlive() {
    if (this.destroyed) return;

    const alivePtr = this.exports.simulationstate_get_player_is_alive_ptr(this.statePtr);
    const aliveView = new Uint8Array(this.exports.memory.buffer, alivePtr, this.arraySize);

    const nowAlive = new Set();
    for (let fid = 1; fid <= this.maxPlayers; fid++) {
      if (aliveView[fid]) nowAlive.add(fid);
    }

    if (this.prevAlive.size > 0) {
      const killView = new Float32Array(
        this.exports.memory.buffer, this.exports.simulationstate_get_player_kill_count_ptr(this.statePtr), this.arraySize);
      const survivedSec = Math.floor((Date.now() - this.startedAt) / 1000);
      for (const fid of this.prevAlive) {
        if (!nowAlive.has(fid)) {
          // Everyone still standing outlasted this faction.
          const placement = nowAlive.size + 1;
          this.placements[fid] = placement;
          this.survivedSec[fid] = survivedSec;
          const killerId = this._findKiller(fid);
          if (killerId) this.eliminations[killerId]++;
          parentPort.postMessage({ type: 'emit', event: 'player-eliminated', payload: {
            factionId: fid,
            killerId,
            placement,
            aliveCount: nowAlive.size,
            survivedSec,
            peakCells: this.peakCells[fid],
            kills: Math.floor(killView[fid] || 0),
            ...this._xpCounters(fid),
          } });
        }
      }

      const cellsPtr = this.exports.simulationstate_get_player_owned_cells_ptr(this.statePtr);
      const cellsView = new Uint32Array(this.exports.memory.buffer, cellsPtr, this.arraySize);

      // Domination: one faction holds the winning share of all land.
      let dominator = 0;
      const share = this._dominationShare(this.exports.simulationstate_get_current_tick(this.statePtr));
      const teamOf = (fid) => (this.teams ? this.teams[fid] : fid);
      let winningTeam = null;
      if (this.teams) {
        // Team game: last team standing, or a team holding the share together.
        const aliveTeams = new Set([...nowAlive].map(teamOf));
        const prevTeams = new Set([...this.prevAlive].map(teamOf));
        if (prevTeams.size >= 2 && aliveTeams.size === 1) winningTeam = [...aliveTeams][0];
        if (winningTeam === null && share > 0 && aliveTeams.size > 1) {
          const land = {};
          for (const fid of nowAlive) land[teamOf(fid)] = (land[teamOf(fid)] || 0) + cellsView[fid];
          let best = null;
          for (const t of Object.keys(land)) {
            if (land[t] >= this.landCells * share && (best === null || land[t] > land[best])) best = t;
          }
          if (best !== null) winningTeam = best;
        }
        if (winningTeam !== null) {
          // The match's "winner" is the team's largest surviving member; every
          // member of the team shares the win (placement 1).
          dominator = [...nowAlive].filter((f) => String(teamOf(f)) === String(winningTeam))
            .sort((a, b) => cellsView[b] - cellsView[a])[0] || 0;
        }
      } else if (share > 0 && nowAlive.size > 1) {
        // Largest qualifying empire wins (matters once the target is below 50%).
        for (const fid of nowAlive) {
          if (cellsView[fid] >= this.landCells * share
              && (!dominator || cellsView[fid] > cellsView[dominator])) {
            dominator = fid;
          }
        }
      }

      const lastStanding = !this.teams && this.prevAlive.size >= 2 && nowAlive.size <= 1;
      if ((lastStanding || dominator) && !this.gameOverFired) {
        this.gameOverFired = true;
        const winner = dominator || (nowAlive.size === 1 ? [...nowAlive][0] : null);
        const onWinningTeam = (fid) => winningTeam !== null && String(teamOf(fid)) === String(winningTeam);

        // On a domination win the survivors are ranked behind the winner by land.
        if (dominator) {
          [...nowAlive].filter(fid => fid !== winner && !onWinningTeam(fid))
            .sort((a, b) => cellsView[b] - cellsView[a])
            .forEach((fid, i) => { this.placements[fid] = i + 2; });
        }

        // Gather final stats for all players
        const stats = {};
        const goldPtr = this.exports.simulationstate_get_player_gold_ptr(this.statePtr);
        const goldView = new Float32Array(this.exports.memory.buffer, goldPtr, this.arraySize);
        const goldSpentPtr = this.exports.simulationstate_get_player_gold_spent_ptr(this.statePtr);
        const goldSpentView = new Float32Array(this.exports.memory.buffer, goldSpentPtr, this.arraySize);

        for (let fid = 1; fid <= this.maxPlayers; fid++) {
          stats[fid] = {
            cells: cellsView[fid] || 0,
            gold: Math.floor(goldView[fid] || 0),
            kills: Math.floor(killView[fid] || 0),
            goldSpent: Math.floor(goldSpentView[fid] || 0),
            peakCells: this.peakCells[fid],
            placement: fid === winner || onWinningTeam(fid) ? 1 : (this.placements[fid] || 0),
            survivedSec: this.survivedSec[fid] ?? survivedSec,
            ...this._xpCounters(fid),
          };
        }

        parentPort.postMessage({ type: 'gameOver', winner, stats, byDomination: !!dominator && !(this.teams && [...nowAlive].every(onWinningTeam)) });
      }
    }

    this.prevAlive = nowAlive;
  }

  // Share of all land that currently wins the match outright (0 = rule off).
  // Holds at the starting share, then steps down on a fixed schedule to a floor.
  // Driven by sim time (ticks), so it is unaffected by server hiccups.
  _dominationShare(tick) {
    const d = this.domination;
    if (!d) return 0;
    if (!(d.decayEverySec > 0) || !(d.decayStep > 0)) return d.share;
    const sec = tick / this.tickHz;
    if (sec < d.decayStartSec) return d.share;
    const steps = Math.floor((sec - d.decayStartSec) / d.decayEverySec) + 1;
    // Round to whole percent so float drift never shows as "54.999%".
    return Math.max(d.floor, Math.round((d.share - steps * d.decayStep) * 100) / 100);
  }

  // Who eliminated `fid`: the sim records the last faction to take a cell from
  // each player (conquest or missile), which at the moment their final cell
  // falls is exactly their eliminator. Returns 0 if nobody is on record.
  _findKiller(fid) {
    const view = new Uint32Array(
      this.exports.memory.buffer,
      this.exports.simulationstate_get_player_last_attacker_ptr(this.statePtr), this.arraySize);
    const killer = view[fid];
    return killer >= 1 && killer <= this.maxPlayers && killer !== fid ? killer : 0;
  }

  handleInput(factionId, input) {
    if (this.destroyed) return;
    if (!input || typeof input.type !== 'string') return;
    // Gate every WASM call: an out-of-range id or cell would index out of
    // bounds inside the sim and kill the room.
    if (!Number.isInteger(factionId) || factionId < 1 || factionId > this.maxPlayers) return;
    const { targetCell, attackPercentage, targetFaction } = input.payload ?? {};
    const reject = () => parentPort.postMessage({
      type: 'emitToFaction', factionId, event: 'build-rejected', payload: { type: input.type } });

    const build = BUILD_INPUTS[input.type];
    if (build) {
      if (!validCell(targetCell)) return;
      const row = Math.floor(targetCell / MAP_WIDTH);
      const col = targetCell % MAP_WIDTH;
      if (this.exports[build.place](this.statePtr, factionId, row, col)) {
        const payload = buildingPayload(build.btype, factionId, targetCell);
        payload.buildMs = BUILDING_TYPES[build.btype].buildMs;
        if (build.btype === 0) this.towersBuilt[factionId]++;
        parentPort.postMessage({ type: 'emit', event: 'building-placed', payload });
      } else {
        reject();
      }
      return;
    }

    if (input.type === 'blitz') {
      if (this.exports.simulationstate_activate_blitz(this.statePtr, factionId)) {
        parentPort.postMessage({ type: 'emit', event: 'blitz-started', payload: { factionId } });
      }
      return;
    }

    // No attacking teammates (guild wars): an expansion or missile aimed at an
    // ally's land is refused.
    if (this.teams && (input.type === 'expand' || input.type === 'fire_missile') && validCell(targetCell)) {
      const owner = new Uint16Array(this.exports.memory.buffer,
        this.exports.simulationstate_get_cell_data_ptr(this.statePtr), TOTAL_CELLS)[targetCell] & 0x7F;
      if (owner && owner !== factionId && String(this.teams[owner]) === String(this.teams[factionId])) {
        parentPort.postMessage({ type: 'emitToFaction', factionId, event: 'notification',
          payload: { message: "That's your ally — you can't attack them.", type: 'error' } });
        return;
      }
    }

    if (input.type === 'expand') {
      if (validCell(targetCell) && validPct(attackPercentage)) {
        this.exports.simulationstate_execute_expansion(this.statePtr, factionId, targetCell, attackPercentage);
      }
    } else if (input.type === 'cancel') {
      this.exports.simulationstate_cancel_expansion(this.statePtr, factionId);
    } else if (input.type === 'cancel_front') {
      // A front's target: 0 = the neutral-land front, 1..N = an enemy faction.
      if (Number.isInteger(targetFaction) && targetFaction >= 0 && targetFaction <= this.maxPlayers) {
        this.exports.simulationstate_cancel_front(this.statePtr, factionId, targetFaction);
      }
    } else if (input.type === 'fire_missile') {
      if (!validCell(targetCell)) return;
      const row = Math.floor(targetCell / MAP_WIDTH);
      const col = targetCell % MAP_WIDTH;
      // 0 = fired, 1 = reject with message (gold/range), 2 = reject silently
      // (invalid target: own cell / nature — no message per spec).
      const status = this.exports.simulationstate_fire_missile(this.statePtr, factionId, row, col);
      if (status === 1) reject();
    }
  }

  spawnFaction(factionId, row, col) {
    if (this.destroyed) return;
    this.exports.simulationstate_spawn_faction(this.statePtr, factionId, row, col);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.memReportInterval) {
      clearInterval(this.memReportInterval);
      this.memReportInterval = null;
    }
    if (this.exports && this.statePtr) {
      try {
        this.exports.__wbg_simulationstate_free(this.statePtr, 1);
      } catch (err) {
        logWarn(`[Sim ${this.roomId}] free failed: ${err.message}`);
      }
      this.statePtr = 0;
    }
    logInfo(`[Sim ${this.roomId}] Worker destroyed`);
  }
}

// Final-safety-net handlers — catch anything that escapes the _safeTick try/catch
// (e.g. errors in buildImports stubs, out-of-thread promise rejections).
process.on('uncaughtException', (err) => {
  if (parentPort) {
    parentPort.postMessage({ type: 'room-error', message: `Worker uncaught exception: ${err.message}` });
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (parentPort) {
    parentPort.postMessage({ type: 'room-error', message: `Worker unhandled rejection: ${String(reason)}` });
  }
  process.exit(1);
});

// Ensure the worker is only created if we are actually in a thread
if (parentPort && workerData) {
  const sim = new RoomSimWorker(workerData);

  parentPort.on('message', (msg) => {
    switch (msg.type) {
      case 'handleInput':
        sim.handleInput(msg.factionId, msg.input);
        break;
      case 'spawnFaction':
        sim.spawnFaction(msg.factionId, msg.row, msg.col);
        break;
      case 'setBotFactions':
        sim.setBotFactions(msg.factionIds);
        break;
      case 'fullState':
        sim.sendFullState(msg.socketId);
        break;
      case 'destroy':
        sim.destroy();
        process.exit(0);
        break;
    }
  });
}
