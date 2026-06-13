// Per-room server-authoritative simulation runner.
// Loads the Rust/WASM simulation_core module directly so we have access to its
// linear memory for snapshot encoding without copying through the JS wrapper.
//
// Snapshot wire format (Node.js Buffer, sent as the `ownerDelta` field):
//   byte 0     : 0 = sparse delta, 1 = full owner buffer
//   if delta   : N pairs of (u32 cell_id, u32 owner_id), little-endian. N = (length-1)/8.
//   if full    : TOTAL_CELLS * 4 bytes of u32 owner ids, little-endian.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';

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
    this.exports.simulationstate_init_players(
      this.statePtr,
      Math.max(1, Math.min(20, numPlayers)),
      opts.startCells ?? 10,
      opts.startTroops ?? 100,
      opts.startGold ?? 500,
      opts.startGrowthRate ?? 50,
      opts.startMaxCap ?? 5000,
    );

    this.tickHz = parseInt(process.env.SIM_TICK_HZ) || 20;
    this.snapshotEveryTicks = Math.max(1, Math.floor(this.tickHz / 5));
    this.lastSnapshotTick = 0;
    this.destroyed = false;

    this.tickInterval = setInterval(() => this._safeTick(), Math.floor(1000 / this.tickHz));
    log('info', `[Sim ${roomId}] started: ${numPlayers} players, ${this.tickHz} Hz`);
  }

  _safeTick() {
    if (this.destroyed) return;
    try {
      this.exports.simulationstate_tick(this.statePtr);
      const tick = this.exports.simulationstate_get_current_tick(this.statePtr);
      if (tick % this.snapshotEveryTicks === 0) {
        this._sendSnapshot(tick);
      }
    } catch (err) {
      log('error', `[Sim ${this.roomId}] tick failed`, err.message);
      this.destroy();
    }
  }

  _sendSnapshot(currentTick) {
    const dirtyPairs = this.exports.simulationstate_collect_dirty_cells(this.statePtr, this.lastSnapshotTick);
    let payload;
    if (dirtyPairs > FULL_SNAPSHOT_THRESHOLD) {
      const ownerPtr = this.exports.simulationstate_get_owner_ptr(this.statePtr);
      const ownerView = Buffer.from(this.exports.memory.buffer, ownerPtr, TOTAL_CELLS * 4);
      payload = Buffer.allocUnsafe(1 + ownerView.byteLength);
      payload[0] = 1;
      ownerView.copy(payload, 1);
    } else {
      const scratchPtr = this.exports.simulationstate_get_delta_scratch_ptr(this.statePtr);
      const scratchView = Buffer.from(this.exports.memory.buffer, scratchPtr, dirtyPairs * 8);
      payload = Buffer.allocUnsafe(1 + scratchView.byteLength);
      payload[0] = 0;
      scratchView.copy(payload, 1);
    }
    this.io.to(this.roomId).emit('sim-snapshot', { tick: currentTick, ownerDelta: payload });
    this.lastSnapshotTick = currentTick;
  }

  // Mechanics design will fan this out into typed handlers. For now,
  // accept the message, validate scope, and discard the payload.
  handleInput(factionId, input) {
    if (this.destroyed) return;
    if (!input || typeof input.type !== 'string') return;
    // No input types are wired up yet; payloads are intentionally discarded.
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
