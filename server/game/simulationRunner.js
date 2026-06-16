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
    this.destroyed = false;

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
        break;

      case 'emitToFaction':
        // Find the specific faction's socket and emit directly to them
        const room = activeRooms[this.roomId];
        if (room && room.activePlayerSlots[msg.factionId]) {
          const socketId = room.activePlayerSlots[msg.factionId].socketId;
          if (socketId) {
            this.io.to(socketId).emit(msg.event, msg.payload);
          }
        }
        break;

      case 'gameOver':
        if (this.onGameOver) {
          this.onGameOver(msg.winner, msg.stats);
        }
        break;

      case 'ready':
        if (this.onReady) {
          this.onReady();
        }
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

  handleInput(factionId, input, onReject) {
    if (this.destroyed) return;
    // Note: onReject cannot be serialized. The worker will handle rejections
    // by posting an 'emitToFaction' message back to us, which we handle above.
    this.worker.postMessage({ type: 'handleInput', factionId, input });
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
