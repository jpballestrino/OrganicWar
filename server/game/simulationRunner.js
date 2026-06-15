// Per-room server-authoritative simulation runner.
// Loads the Rust/WASM simulation_core module directly so we have access to its
// linear memory for snapshot encoding without copying through the JS wrapper.
//
// Snapshot wire format (Node.js Buffer, sent as the `ownerDelta` field):
//   byte 0     : 0 = sparse delta, 1 = full packed-cell buffer
//   if delta   : N pairs of (u32 cell_id, u32 owner_id), little-endian. N = (length-1)/8.
//   if full    : TOTAL_CELLS * 2 bytes of u16 packed cells, little-endian.
// Cells pack owner/terrain/defense/has_building into one u16; the client merges
// only the owner bits (it generates terrain locally). See src/js/simBridge.js.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';
import { generateTerrain } from '../../src/js/mapGen.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WASM_PATH = path.join(__dirname, '..', 'wasm', 'simulation_core_bg.wasm');

const MAP_WIDTH = 1920;
const MAP_HEIGHT = 1080;
const TOTAL_CELLS = MAP_WIDTH * MAP_HEIGHT;
const FULL_SNAPSHOT_THRESHOLD = Math.floor(TOTAL_CELLS * 0.05);

const wasmBytes = fs.readFileSync(WASM_PATH);
const wasmModule = new WebAssembly.Module(wasmBytes);

function buildImports(getInstance) {
  // Dynamic stubs for whatever wasm-bindgen happens to demand this build —
  // function names contain a fingerprint hash that changes per recompile.
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

// One WASM instance per room. Each has its own linear memory and SimulationState.
export class RoomSim {
  constructor(roomId, numPlayers, io, opts = {}) {
    this.roomId = roomId;
    this.io = io;
    this.exports = instantiate();
    this.statePtr = this.exports.simulationstate_new();

    // Generate the static terrain into the sim's packed cell buffer (same
    // deterministic map the client paints) BEFORE any spawns, so the
    // authoritative sim knows where water is and never lets factions expand
    // onto it. Without this the server's terrain bits are all zero (plains).
    const cellPtr = this.exports.simulationstate_get_cell_data_ptr(this.statePtr);
    generateTerrain(this.exports.memory, cellPtr);

    this.exports.simulationstate_init_players(
      this.statePtr,
      Math.max(1, Math.min(20, numPlayers)),
      opts.startCells ?? 10,
      opts.startTroops ?? 20,
      opts.startGold ?? 500,
      opts.startGrowthRate ?? 50,
      opts.startMaxCap ?? 5000,
    );

    this.tickHz = parseInt(process.env.SIM_TICK_HZ) || 60;
    // Keep the sim's per-second rates (troop growth) correct at this tick rate.
    this.exports.simulationstate_set_tick_hz(this.statePtr, this.tickHz);
    // Snapshot ~20x/sec so border expansion is shown as a smooth creep rather
    // than a few big jumps. Deltas stay tiny since only a thin shell changes.
    this.snapshotEveryTicks = Math.max(1, Math.floor(this.tickHz / 20));
    this.lastSnapshotTick = 0;
    this.destroyed = false;

    // Bot AI: faction ids the server drives (set via setBotFactions). Each bot
    // re-commits an expansion every ~1.5s so it keeps growing on its own.
    this.botFactions = [];
    this.botThinkEveryTicks = Math.max(1, Math.floor(this.tickHz * 1.5));
    // Bots evaluate building a defense tower on a slower cadence than expansion.
    this.botBuildEveryTicks = Math.max(1, Math.floor(this.tickHz * 3));

    this.onGameOver = opts.onGameOver || null;
    // Alive set from the previous snapshot check — used to detect eliminations and victory.
    this.prevAlive = new Set();

    // Instrumentation metrics
    this.profileMetrics = {
      tickCount: 0,
      totalTickMs: 0,
      maxTickMs: 0,
      snapshotCount: 0,
      fullSnapshotCount: 0,
      totalPayloadBytes: 0,
      totalDirtyCells: 0,
      lastLogTime: Date.now()
    };

    this.tickInterval = setInterval(() => this._safeTick(), Math.floor(1000 / this.tickHz));
    log('info', `[Sim ${roomId}] started: ${numPlayers} players, ${this.tickHz} Hz`);
  }

  _safeTick() {
    if (this.destroyed) return;
    try {
      const t0 = performance.now();
      this.exports.simulationstate_tick(this.statePtr);
      const t1 = performance.now();

      const tickMs = t1 - t0;
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
      if (tick % this.snapshotEveryTicks === 0) {
        this._sendSnapshot(tick);
      }
      this._emitDestroyedBuildings();
      this._emitPlacedBuildings();

      if (process.env.SIM_PROFILE === '1') {
        const now = Date.now();
        if (now - this.profileMetrics.lastLogTime >= 5000) {
          this._logProfileSummary(now);
        }
      }
    } catch (err) {
      log('error', `[Sim ${this.roomId}] tick failed`, err.message);
      this.destroy();
    }
  }

  _logProfileSummary(now) {
    const dtSeconds = (now - this.profileMetrics.lastLogTime) / 1000;
    const avgTick = this.profileMetrics.tickCount > 0 ? (this.profileMetrics.totalTickMs / this.profileMetrics.tickCount) : 0;
    const payloadKBps = dtSeconds > 0 ? (this.profileMetrics.totalPayloadBytes / 1024 / dtSeconds) : 0;
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);

    log('info', `[Sim ${this.roomId} PROFILE] ` +
      `Tick: avg ${avgTick.toFixed(2)}ms, max ${this.profileMetrics.maxTickMs.toFixed(2)}ms | ` +
      `Snaps: ${this.profileMetrics.snapshotCount} (${this.profileMetrics.fullSnapshotCount} full) | ` +
      `Net: ${payloadKBps.toFixed(2)} KB/s | ` +
      `Dirty/snap: ${(this.profileMetrics.snapshotCount > 0 ? this.profileMetrics.totalDirtyCells / this.profileMetrics.snapshotCount : 0).toFixed(1)} | ` +
      `RSS: ${rssMB} MB`);

    // Reset metrics
    this.profileMetrics.tickCount = 0;
    this.profileMetrics.totalTickMs = 0;
    this.profileMetrics.maxTickMs = 0;
    this.profileMetrics.snapshotCount = 0;
    this.profileMetrics.fullSnapshotCount = 0;
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
      this.io.to(this.roomId).emit('building-destroyed', { row, col });
    }
    this.exports.simulationstate_clear_destroyed_buildings(this.statePtr);
  }

  // Broadcast buildings placed by bots this tick. Human placements are emitted
  // directly from handleInput; bots push (center, factionId) pairs into the sim's
  // placed_buildings_buf, which we poll and clear here.
  _emitPlacedBuildings() {
    const count = this.exports.simulationstate_get_placed_buildings_count(this.statePtr);
    if (!count) return;
    const ptr = this.exports.simulationstate_get_placed_buildings_ptr(this.statePtr);
    const buf = new Uint32Array(this.exports.memory.buffer, ptr, count * 2);
    for (let i = 0; i < count; i++) {
      const center = buf[i * 2];
      const factionId = buf[i * 2 + 1];
      const row = Math.floor(center / MAP_WIDTH);
      const col = center % MAP_WIDTH;
      this.io.to(this.roomId).emit('building-placed', {
        type: 'defense', factionId, row, col, radius: 40, defTier: 10,
      });
    }
    this.exports.simulationstate_clear_placed_buildings(this.statePtr);
  }

  setBotFactions(factionIds) {
    this.botFactions = Array.isArray(factionIds) ? factionIds.slice() : [];
    // Flag the bots inside the sim so its heuristic AI knows who to drive.
    for (const fid of this.botFactions) {
      this.exports.simulationstate_set_player_is_bot(this.statePtr, fid, true);
    }
  }

  // The sim's heuristic bot AI evaluates every bot's border in one pass and
  // picks a target each: cheap neutral land to grow, or the weakest bordering
  // enemy when boxed in / clearly stronger. Expansion stays radial, so the
  // target only sets the attack-vs-grow direction and a stop point.
  _botThink() {
    if (!this.botFactions.length) return;
    // Commit ~45% of each bot's troops toward its chosen target.
    this.exports.simulationstate_bot_think_all(this.statePtr, 45);
  }

  _sendSnapshot(currentTick) {
    const dirtyPairs = this.exports.simulationstate_collect_dirty_cells(this.statePtr, this.lastSnapshotTick);
    let payload;
    let isFull = false;
    if (dirtyPairs > FULL_SNAPSHOT_THRESHOLD) {
      const cellPtr = this.exports.simulationstate_get_cell_data_ptr(this.statePtr);
      const cellView = Buffer.from(this.exports.memory.buffer, cellPtr, TOTAL_CELLS * 2);
      payload = Buffer.allocUnsafe(1 + cellView.byteLength);
      payload[0] = 1;
      cellView.copy(payload, 1);
      isFull = true;
    } else {
      const scratchPtr = this.exports.simulationstate_get_delta_scratch_ptr(this.statePtr);
      const scratchView = Buffer.from(this.exports.memory.buffer, scratchPtr, dirtyPairs * 8);
      payload = Buffer.allocUnsafe(1 + scratchView.byteLength);
      payload[0] = 0;
      scratchView.copy(payload, 1);
    }

    this.profileMetrics.snapshotCount++;
    if (isFull) this.profileMetrics.fullSnapshotCount++;
    this.profileMetrics.totalPayloadBytes += payload.byteLength;
    this.profileMetrics.totalDirtyCells += dirtyPairs;

    const troopsPtr = this.exports.simulationstate_get_player_total_troops_ptr(this.statePtr);
    const maxPopPtr = this.exports.simulationstate_get_player_max_population_cap_ptr(this.statePtr);
    const attackPtr = this.exports.simulationstate_get_player_attack_pool_ptr(this.statePtr);
    const goldPtr = this.exports.simulationstate_get_player_gold_ptr(this.statePtr);

    // PLAYER_ARRAY_SIZE is 21 (0 to 20). troops/attack/gold are f32, maxPop u32.
    const troopsBuffer = Buffer.from(this.exports.memory.buffer, troopsPtr, 21 * 4);
    const maxPopBuffer = Buffer.from(this.exports.memory.buffer, maxPopPtr, 21 * 4);
    const attackBuffer = Buffer.from(this.exports.memory.buffer, attackPtr, 21 * 4);
    const goldBuffer = Buffer.from(this.exports.memory.buffer, goldPtr, 21 * 4);

    // Territory centroids (+ troops) for the in-territory name/troop labels.
    const rowSum = new Float32Array(this.exports.memory.buffer, this.exports.simulationstate_get_player_row_sum_ptr(this.statePtr), 21);
    const colSum = new Float32Array(this.exports.memory.buffer, this.exports.simulationstate_get_player_col_sum_ptr(this.statePtr), 21);
    const owned = new Uint32Array(this.exports.memory.buffer, this.exports.simulationstate_get_player_owned_cells_ptr(this.statePtr), 21);
    const troops = new Float32Array(this.exports.memory.buffer, troopsPtr, 21);
    const centroids = {};
    for (let fid = 1; fid <= 20; fid++) {
      if (owned[fid] > 0) {
        centroids[fid] = {
          row: Math.round(rowSum[fid] / owned[fid]),
          col: Math.round(colSum[fid] / owned[fid]),
          troops: Math.floor(troops[fid]),
          cells: owned[fid],
        };
      }
    }

    this.io.to(this.roomId).emit('sim-snapshot', {
      tick: currentTick,
      ownerDelta: payload,
      playerTroops: troopsBuffer,
      playerMaxPop: maxPopBuffer,
      playerAttack: attackBuffer,
      playerGold: goldBuffer,
      centroids
    });
    this.lastSnapshotTick = currentTick;

    this._checkAlive();
  }

  _checkAlive() {
    if (this.destroyed) return;

    const alivePtr = this.exports.simulationstate_get_player_is_alive_ptr(this.statePtr);
    const aliveView = new Uint8Array(this.exports.memory.buffer, alivePtr, 21);

    const nowAlive = new Set();
    for (let fid = 1; fid <= 20; fid++) {
      if (aliveView[fid]) nowAlive.add(fid);
    }

    // On the very first snapshot prevAlive is empty — just record state, don't evaluate.
    if (this.prevAlive.size > 0) {
      for (const fid of this.prevAlive) {
        if (!nowAlive.has(fid)) {
          this.io.to(this.roomId).emit('player-eliminated', { factionId: fid });
        }
      }

      // Victory: game was contested (≥2 alive) and is now decided (≤1 alive).
      if (this.prevAlive.size >= 2 && nowAlive.size <= 1 && !this.gameOverFired) {
        this.gameOverFired = true;
        const winner = nowAlive.size === 1 ? [...nowAlive][0] : null;
        if (this.onGameOver) this.onGameOver(winner);
      }
    }

    this.prevAlive = nowAlive;
  }

  handleInput(factionId, input, onReject) {
    if (this.destroyed) return;
    if (!input || typeof input.type !== 'string') return;

    if (input.type === 'expand') {
      const { targetCell, attackPercentage } = input.payload;
      if (typeof targetCell === 'number' && typeof attackPercentage === 'number') {
        this.exports.simulationstate_execute_expansion(this.statePtr, factionId, targetCell, attackPercentage);
      }
    } else if (input.type === 'cancel') {
      // Recall un-spent attacking troops back to the defending pool.
      this.exports.simulationstate_cancel_expansion(this.statePtr, factionId);
    } else if (input.type === 'build_defense') {
      const { targetCell } = input.payload ?? {};
      if (typeof targetCell === 'number') {
        const row = Math.floor(targetCell / MAP_WIDTH);
        const col = targetCell % MAP_WIDTH;
        const ok = this.exports.simulationstate_place_defense_building(this.statePtr, factionId, row, col);
        if (ok) {
          this.io.to(this.roomId).emit('building-placed', {
            type: 'defense',
            factionId,
            row,
            col,
            radius: 40, // must match BUILDING_RADIUS in simulation-core/src/lib.rs
            defTier: 10,
          });
        } else if (onReject) {
          onReject();
        }
      }
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
    if (this.exports && this.statePtr) {
      try {
        this.exports.__wbg_simulationstate_free(this.statePtr, 1);
      } catch (err) {
        log('warn', `[Sim ${this.roomId}] free failed`, err.message);
      }
      this.statePtr = 0;
    }
    log('info', `[Sim ${this.roomId}] destroyed`);
  }
}
