import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { log } from '../utils/logger.js';
import { activeRooms } from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'simulationWorker.js');

// Proxy class that runs the actual simulation inside a dedicated worker_thread
export class RoomSim {
  constructor(roomId, numPlayers, io, opts = {}) {
    this.roomId = roomId;
    this.io = io;
    this.onGameOver = opts.onGameOver || null;
    this.onReady = opts.onReady || null;
    this.onPlayerEliminated = opts.onPlayerEliminated || null;
    this.onError = opts.onError || null;
    this.destroyed = false;
    this.load = null; // latest load-report from the worker

    // Serialize environment variables needed by the worker
    const envConfig = {
      SIM_TICK_HZ: process.env.SIM_TICK_HZ,
      SIM_PROFILE: process.env.SIM_PROFILE,
    };

    this.worker = new Worker(WORKER_PATH, {
      workerData: {
        roomId,
        numPlayers,
        mapId: opts.mapId || 'north_america',
        opts: {
          startCells: opts.startCells,
          startTroops: opts.startTroops,
          startGold: opts.startGold,
          startGrowthRate: opts.startGrowthRate,
          startMaxCap: opts.startMaxCap,
          domination: opts.domination,
          teams: opts.teams || null,
        },
        env: envConfig
      }
    });

    this.worker.on('message', (msg) => this._handleWorkerMessage(msg));

    this.worker.on('error', (err) => {
      log('error', `[Sim ${this.roomId}] Worker error:`, err.message);
      this.destroy();
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        log('error', `[Sim ${this.roomId}] Worker stopped with exit code ${code}`);
      }
    });

    log('info', `[Sim ${roomId}] Proxy created, worker spinning up...`);
  }

  _handleWorkerMessage(msg) {
    if (this.destroyed) return;

    switch (msg.type) {
      case 'emit':
        // Broadcast to the entire room
        this.io.to(this.roomId).emit(msg.event, msg.payload);
        // A faction's match ends at its elimination: the room manager awards
        // XP then (after the broadcast, so the client's recap is already up).
        if (msg.event === 'player-eliminated' && this.onPlayerEliminated) {
          this.onPlayerEliminated(msg.payload);
        }
        break;

      case 'emitToSocket':
        // Full-state sync for one (re)joining client.
        this.io.to(msg.socketId).emit(msg.event, msg.payload);
        break;

      case 'emitToFaction': {
        // Find the specific faction's socket and emit directly to them
        const room = activeRooms[this.roomId];
        if (room && room.activePlayerSlots[msg.factionId]) {
          const socketId = room.activePlayerSlots[msg.factionId].socketId;
          if (socketId) {
            this.io.to(socketId).emit(msg.event, msg.payload);
          }
        }
        break;
      }

      case 'gameOver':
        if (this.onGameOver) {
          this.onGameOver(msg.winner, msg.stats, !!msg.byDomination);
        }
        break;

      case 'ready':
        if (this.onReady) {
          this.onReady();
        }
        break;

      case 'load-report':
        // Polled by /healthz and the room-capacity check (see capacity.js).
        this.load = {
          wasmMB: msg.wasmMB,
          avgTickMs: msg.avgTickMs,
          maxTickMs: msg.maxTickMs,
          tickBudgetUsed: msg.tickBudgetUsed,
          kbPerSec: msg.kbPerSec,
        };
        break;

      case 'room-error':
        log('error', `[Sim ${this.roomId}] Room crashed: ${msg.message}`);
        if (this.onError) {
          this.onError(msg.message);
        }
        this.destroy();
        break;

      case 'log':
        log(msg.level, msg.payload);
        break;
    }
  }

  // --- Proxy Methods to pass inputs down to the Worker ---

  setBotFactions(factionIds) {
    if (this.destroyed) return;
    this.worker.postMessage({ type: 'setBotFactions', factionIds });
  }

  handleInput(factionId, input) {
    if (this.destroyed) return;
    // Rejections come back from the worker as 'emitToFaction' messages.
    this.worker.postMessage({ type: 'handleInput', factionId, input });
  }

  // Send the complete match state (owners, buildings, stats) to one socket.
  // Call after the socket has joined the room, so no later delta is missed.
  sendFullState(socketId) {
    if (this.destroyed) return;
    this.worker.postMessage({ type: 'fullState', socketId });
  }

  spawnFaction(factionId, row, col) {
    if (this.destroyed) return;
    this.worker.postMessage({ type: 'spawnFaction', factionId, row, col });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    
    // Tell the worker to cleanup and exit cleanly
    this.worker.postMessage({ type: 'destroy' });
    
    // Give it a brief moment to exit, then force terminate if needed
    setTimeout(() => {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
    }, 100);

    log('info', `[Sim ${this.roomId}] Proxy destroyed`);
  }
}
