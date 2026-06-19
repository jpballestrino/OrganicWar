// Dedicated worker thread for running a single room's authoritative simulation.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parentPort, workerData } from 'worker_threads';
import { generateTerrain } from '../../src/js/mapGen.js';
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

// --- Input validators (gate every WASM call to prevent out-of-bounds panics) ---
const validFaction = (f) => Number.isInteger(f) && f >= 1 && f <= 20;
const validCell    = (c) => Number.isInteger(c) && c >= 0 && c < TOTAL_CELLS;
const validPct     = (p) => typeof p === 'number' && p >= 1 && p <= 90;
const FULL_SNAPSHOT_THRESHOLD = Math.floor(TOTAL_CELLS * 0.05);
// Defense building construction time (ms). Mirrors DEFENSE_BUILD_SECONDS in
// simulation-core/src/lib.rs (5s) and DEFENSE_BUILD_MS in src/js/constants.js.
// Sent in building-placed so the client can animate the fill bar; the sim is the
// authority on when the bonus actually applies (building-completed).
const DEFENSE_BUILD_MS = 5000;
// Silo / missile params — mirror the SILO_* / MISSILE_* consts in lib.rs.
const SILO_BUILD_MS = 10000;
const SILO_RANGE = 240;


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

    const cellPtr = this.exports.simulationstate_get_cell_data_ptr(this.statePtr);
    generateTerrain(this.exports.memory, cellPtr, this.mapId);

    this.exports.simulationstate_init_players(
      this.statePtr,
      Math.max(1, Math.min(20, numPlayers)),
      opts.startGold ?? 500,
      opts.startGrowthRate ?? 50,
      opts.startMaxCap ?? 5000,
    );

    this.tickHz = parseInt(this.env.SIM_TICK_HZ) || 25;
    this.exports.simulationstate_set_tick_hz(this.statePtr, this.tickHz);
    this.snapshotEveryTicks = Math.max(1, Math.floor(this.tickHz / 20));
    this.lastSnapshotTick = 0;
    this.destroyed = false;

    this.botFactions = [];
    this.botThinkEveryTicks = Math.max(1, Math.floor(this.tickHz * 1.5));
    this.botBuildEveryTicks = Math.max(1, Math.floor(this.tickHz * 3));

    this.prevAlive = new Set();
    this.gameOverFired = false;

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

    // Report worker RSS to the main thread every 30 s for /healthz memory tracking
    this.memReportInterval = setInterval(() => {
      if (!this.destroyed) {
        const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        parentPort.postMessage({ type: 'mem-report', rssMB });
      }
    }, 30000);

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
        this._sendSnapshot(tick);
      }
      this._emitDestroyedBuildings();
      this._emitPlacedBuildings();
      this._emitFiredMissiles();
      this._emitInterceptedMissiles();
      // Owner transfers before completions so a silo that flips owner and completes
      // on the same tick has its factionId updated before the completion lookup.
      this._emitTransferredBuildings();
      this._emitCompletedBuildings();

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
      `Snaps: ${this.profileMetrics.snapshotCount} (${this.profileMetrics.fullSnapshotCount} full) | ` +
      `Net: ${payloadKBps.toFixed(2)} KB/s | ` +
      `Dirty/snap: ${(this.profileMetrics.snapshotCount > 0 ? this.profileMetrics.totalDirtyCells / this.profileMetrics.snapshotCount : 0).toFixed(1)} | ` +
      `RSS: ${rssMB} MB`);

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
      const center = buf[i * 3];
      const factionId = buf[i * 3 + 1];
      const btype = buf[i * 3 + 2]; // 0=defense, 1=silo, 2=mine, 3=antiair, 4=city
      const row = Math.floor(center / MAP_WIDTH);
      const col = center % MAP_WIDTH;
      let payload;
      if      (btype === 1) payload = { type: 'silo',    factionId, row, col, range: SILO_RANGE, buildMs: SILO_BUILD_MS };
      else if (btype === 2) payload = { type: 'mine',    factionId, row, col, buildMs: 10000 };
      else if (btype === 3) payload = { type: 'antiair', factionId, row, col, buildMs: 10000 };
      else if (btype === 4) payload = { type: 'city',    factionId, row, col, buildMs: 5000 };
      else                  payload = { type: 'defense', factionId, row, col, radius: 40, defTier: 10, buildMs: DEFENSE_BUILD_MS };
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
      const center = buf[i * 3];
      const factionId = buf[i * 3 + 1];
      const btype = buf[i * 3 + 2]; // 0=defense, 1=silo, 2=mine, 3=antiair, 4=city
      const row = Math.floor(center / MAP_WIDTH);
      const col = center % MAP_WIDTH;
      let payload;
      if      (btype === 1) payload = { type: 'silo',    factionId, row, col, range: SILO_RANGE };
      else if (btype === 2) payload = { type: 'mine',    factionId, row, col };
      else if (btype === 3) payload = { type: 'antiair', factionId, row, col };
      else if (btype === 4) payload = { type: 'city',    factionId, row, col };
      else                  payload = { type: 'defense', factionId, row, col, radius: 40, defTier: 10 };
      parentPort.postMessage({ type: 'emit', event: 'building-completed', payload });
    }
    this.exports.simulationstate_clear_completed_buildings(this.statePtr);
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
      // Kind 2: packed-u32 delta. The Rust scratch holds (u32 cell_id, u32 owner)
      // pairs (8 bytes/change); cell_id needs 21 bits and owner 7, so we fold each
      // pair into a single u32 (cell_id | owner << 21), halving the wire size.
      const scratchPtr = this.exports.simulationstate_get_delta_scratch_ptr(this.statePtr);
      const pairs = new Uint32Array(this.exports.memory.buffer, scratchPtr, dirtyPairs * 2);
      payload = Buffer.allocUnsafe(1 + dirtyPairs * 4);
      payload[0] = 2;
      for (let i = 0; i < dirtyPairs; i++) {
        const packed = (pairs[i * 2] & 0x1FFFFF) | ((pairs[i * 2 + 1] & 0x7F) << 21);
        payload.writeUInt32LE(packed >>> 0, 1 + i * 4);
      }
    }

    this.profileMetrics.snapshotCount++;
    if (isFull) this.profileMetrics.fullSnapshotCount++;
    this.profileMetrics.totalPayloadBytes += payload.byteLength;
    this.profileMetrics.totalDirtyCells += dirtyPairs;

    const troopsPtr = this.exports.simulationstate_get_player_total_troops_ptr(this.statePtr);
    const maxPopPtr = this.exports.simulationstate_get_player_max_population_cap_ptr(this.statePtr);
    const attackPtr = this.exports.simulationstate_get_player_attack_pool_ptr(this.statePtr);
    const goldPtr = this.exports.simulationstate_get_player_gold_ptr(this.statePtr);
    const killPtr = this.exports.simulationstate_get_player_kill_count_ptr(this.statePtr);
    const goldSpentPtr = this.exports.simulationstate_get_player_gold_spent_ptr(this.statePtr);

    // Copying the buffers since we can't transfer WASM memory safely.
    // They are extremely small (84 bytes each)
    const troopsBuffer = Buffer.from(Buffer.from(this.exports.memory.buffer, troopsPtr, 21 * 4));
    const maxPopBuffer = Buffer.from(Buffer.from(this.exports.memory.buffer, maxPopPtr, 21 * 4));
    const attackBuffer = Buffer.from(Buffer.from(this.exports.memory.buffer, attackPtr, 21 * 4));
    const goldBuffer = Buffer.from(Buffer.from(this.exports.memory.buffer, goldPtr, 21 * 4));
    const killBuffer = Buffer.from(Buffer.from(this.exports.memory.buffer, killPtr, 21 * 4));
    const goldSpentBuffer = Buffer.from(Buffer.from(this.exports.memory.buffer, goldSpentPtr, 21 * 4));

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

    parentPort.postMessage({
      type: 'emit',
      event: 'sim-snapshot',
      payload: {
        tick: currentTick,
        ownerDelta: payload,
        playerTroops: troopsBuffer,
        playerMaxPop: maxPopBuffer,
        playerAttack: attackBuffer,
        playerGold: goldBuffer,
        playerKills: killBuffer,
        playerGoldSpent: goldSpentBuffer,
        centroids
      }
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

    if (this.prevAlive.size > 0) {
      for (const fid of this.prevAlive) {
        if (!nowAlive.has(fid)) {
          parentPort.postMessage({ type: 'emit', event: 'player-eliminated', payload: { factionId: fid } });
        }
      }

      if (this.prevAlive.size >= 2 && nowAlive.size <= 1 && !this.gameOverFired) {
        this.gameOverFired = true;
        const winner = nowAlive.size === 1 ? [...nowAlive][0] : null;

        // Gather final stats for all players
        const stats = {};
        const cellsPtr = this.exports.simulationstate_get_player_owned_cells_ptr(this.statePtr);
        const cellsView = new Uint32Array(this.exports.memory.buffer, cellsPtr, 21);
        const goldPtr = this.exports.simulationstate_get_player_gold_ptr(this.statePtr);
        const goldView = new Float32Array(this.exports.memory.buffer, goldPtr, 21);
        const killPtr = this.exports.simulationstate_get_player_kill_count_ptr(this.statePtr);
        const killView = new Float32Array(this.exports.memory.buffer, killPtr, 21);
        const goldSpentPtr = this.exports.simulationstate_get_player_gold_spent_ptr(this.statePtr);
        const goldSpentView = new Float32Array(this.exports.memory.buffer, goldSpentPtr, 21);

        for (let fid = 1; fid <= 20; fid++) {
          stats[fid] = {
            cells: cellsView[fid] || 0,
            gold: Math.floor(goldView[fid] || 0),
            kills: Math.floor(killView[fid] || 0),
            goldSpent: Math.floor(goldSpentView[fid] || 0)
          };
        }

        parentPort.postMessage({ type: 'gameOver', winner, stats });
      }
    }

    this.prevAlive = nowAlive;
  }

  handleInput(factionId, input) {
    if (this.destroyed) return;
    if (!input || typeof input.type !== 'string') return;
    if (!validFaction(factionId)) return;

    if (input.type === 'expand') {
      const { targetCell, attackPercentage } = input.payload ?? {};
      if (validCell(targetCell) && validPct(attackPercentage)) {
        this.exports.simulationstate_execute_expansion(this.statePtr, factionId, targetCell, attackPercentage);
      }
    } else if (input.type === 'cancel') {
      this.exports.simulationstate_cancel_expansion(this.statePtr, factionId);
    } else if (input.type === 'cancel_front') {
      const { targetFaction } = input.payload ?? {};
      if (validFaction(targetFaction)) {
        this.exports.simulationstate_cancel_front(this.statePtr, factionId, targetFaction);
      }
    } else if (input.type === 'build_defense') {
      const { targetCell } = input.payload ?? {};
      if (validCell(targetCell)) {
        const row = Math.floor(targetCell / MAP_WIDTH);
        const col = targetCell % MAP_WIDTH;
        const ok = this.exports.simulationstate_place_defense_building(this.statePtr, factionId, row, col);
        if (ok) {
          parentPort.postMessage({ type: 'emit', event: 'building-placed', payload: {
            type: 'defense', factionId, row, col, radius: 40, defTier: 10, buildMs: DEFENSE_BUILD_MS,
          }});
        } else {
          parentPort.postMessage({ type: 'emitToFaction', factionId, event: 'build-rejected', payload: { type: input.type } });
        }
      }
    } else if (input.type === 'build_silo') {
      const { targetCell } = input.payload ?? {};
      if (validCell(targetCell)) {
        const row = Math.floor(targetCell / MAP_WIDTH);
        const col = targetCell % MAP_WIDTH;
        const ok = this.exports.simulationstate_place_silo(this.statePtr, factionId, row, col);
        if (ok) {
          parentPort.postMessage({ type: 'emit', event: 'building-placed', payload: {
            type: 'silo', factionId, row, col, range: SILO_RANGE, buildMs: SILO_BUILD_MS,
          }});
        } else {
          parentPort.postMessage({ type: 'emitToFaction', factionId, event: 'build-rejected', payload: { type: input.type } });
        }
      }
    } else if (input.type === 'fire_missile') {
      const { targetCell } = input.payload ?? {};
      if (validCell(targetCell)) {
        const row = Math.floor(targetCell / MAP_WIDTH);
        const col = targetCell % MAP_WIDTH;
        // 0 = fired, 1 = reject with message (gold/range), 2 = reject silently
        // (invalid target: own cell / nature — no message per spec).
        const status = this.exports.simulationstate_fire_missile(this.statePtr, factionId, row, col);
        if (status === 1) {
          parentPort.postMessage({ type: 'emitToFaction', factionId, event: 'build-rejected', payload: { type: input.type } });
        }
      }
    } else if (input.type === 'build_mine') {
      const { targetCell } = input.payload ?? {};
      if (validCell(targetCell)) {
        const row = Math.floor(targetCell / MAP_WIDTH);
        const col = targetCell % MAP_WIDTH;
        const ok = this.exports.simulationstate_place_mine(this.statePtr, factionId, row, col);
        if (ok) {
          parentPort.postMessage({ type: 'emit', event: 'building-placed', payload: {
            type: 'mine', factionId, row, col, buildMs: 10000,
          }});
        } else {
          parentPort.postMessage({ type: 'emitToFaction', factionId, event: 'build-rejected', payload: { type: input.type } });
        }
      }
    } else if (input.type === 'build_antiair') {
      const { targetCell } = input.payload ?? {};
      if (validCell(targetCell)) {
        const row = Math.floor(targetCell / MAP_WIDTH);
        const col = targetCell % MAP_WIDTH;
        const ok = this.exports.simulationstate_place_antiair(this.statePtr, factionId, row, col);
        if (ok) {
          parentPort.postMessage({ type: 'emit', event: 'building-placed', payload: {
            type: 'antiair', factionId, row, col, buildMs: 10000,
          }});
        } else {
          parentPort.postMessage({ type: 'emitToFaction', factionId, event: 'build-rejected', payload: { type: input.type } });
        }
      }
    } else if (input.type === 'build_city') {
      const { targetCell } = input.payload ?? {};
      if (validCell(targetCell)) {
        const row = Math.floor(targetCell / MAP_WIDTH);
        const col = targetCell % MAP_WIDTH;
        const ok = this.exports.simulationstate_place_city(this.statePtr, factionId, row, col);
        if (ok) {
          parentPort.postMessage({ type: 'emit', event: 'building-placed', payload: {
            type: 'city', factionId, row, col, buildMs: 5000,
          }});
        } else {
          parentPort.postMessage({ type: 'emitToFaction', factionId, event: 'build-rejected', payload: { type: input.type } });
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
      case 'destroy':
        sim.destroy();
        process.exit(0);
        break;
    }
  });
}
