// How many rooms this process may run at once.
//
// Each room is one worker thread running the WASM sim. Measured with
// scripts/bench-room.mjs, a 20-player room costs ~6% of one core on average
// (25 Hz) and ~10 MB of WASM memory plus a V8 isolate. The limit is the
// smallest of:
//   * MAX_CONCURRENT_ROOMS, if set (an explicit operator decision wins);
//   * CPU: ROOMS_PER_CORE rooms per core, keeping headroom for Socket.IO
//     encoding and the main thread;
//   * memory: MB_PER_ROOM per room within 60% of system memory;
// and, independently of the count, a new room is refused while the rooms
// already running use more than LOAD_CEILING of the machine's CPU (from the
// workers' own load reports), so a busy box degrades by turning away new
// matches instead of slowing down every match in progress.

import os from 'os';
import { activeRooms } from './state.js';

const ROOMS_PER_CORE = 8;
const MB_PER_ROOM = 64;
const LOAD_CEILING = 0.75;

const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

export function maxRooms() {
  const explicit = parseInt(process.env.MAX_CONCURRENT_ROOMS);
  if (explicit > 0) return explicit;
  const byCpu = cores * ROOMS_PER_CORE;
  const byMemory = Math.floor((os.totalmem() / 1024 / 1024) * 0.6 / MB_PER_ROOM);
  return Math.max(1, Math.min(byCpu, byMemory));
}

// Sum of the running rooms' simulation load, in cores (1.0 = one full core).
export function simLoadCores() {
  let total = 0;
  for (const room of Object.values(activeRooms)) {
    total += room.simReal?.load?.tickBudgetUsed || 0;
  }
  return total;
}

// null if a new room may start, otherwise the reason it may not.
export function roomRefusal() {
  const rooms = Object.keys(activeRooms).length;
  const limit = maxRooms();
  if (rooms >= limit) return `at room cap (${rooms}/${limit})`;
  const load = simLoadCores();
  if (load > cores * LOAD_CEILING) return `CPU busy (${load.toFixed(2)} of ${cores} cores)`;
  return null;
}

export function capacityReport() {
  return {
    cores,
    maxRooms: maxRooms(),
    rooms: Object.keys(activeRooms).length,
    simLoadCores: Number(simLoadCores().toFixed(3)),
    loadCeilingCores: cores * LOAD_CEILING,
  };
}
