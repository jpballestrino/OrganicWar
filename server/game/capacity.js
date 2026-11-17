// How many rooms this process may run at once.
//
// Each room is one worker thread running the WASM sim. Measured with
// scripts/bench-room.mjs, a 20-player room costs ~6% of one core on average
// (25 Hz) and ~10 MB of WASM memory plus a V8 isolate. The limit is the
// smallest of:
//   * MAX_CONCURRENT_ROOMS, if set (an explicit operator decision wins);
//   * CPU: ROOMS_PER_CORE rooms per core, keeping headroom for Socket.IO
//     encoding and the main thread;
//   * memory: MB_PER_ROOM per room within 80% of what is left after the
//     server's own ~150 MB;
// and, independently of the count, a new room is refused while the rooms
// already running use more than LOAD_CEILING of the machine's CPU (from the
// workers' own load reports), so a busy box degrades by turning away new
// matches instead of slowing down every match in progress.
// CPU and memory are the CONTAINER's limits when running in one (cgroups).

import fs from 'fs';
import os from 'os';
import { activeRooms } from './state.js';

const ROOMS_PER_CORE = 8;
const MB_PER_ROOM = 64;
const LOAD_CEILING = 0.75;

// Inside a container (Docker, Render, Fly) os.cpus() / os.totalmem() report the
// HOST, not what the container may use — a 0.5-CPU / 512 MB plan on a 32-core
// host would be told it can run 256 rooms. Read the cgroup limits instead
// (v2 first, then v1), falling back to the OS numbers on bare metal.
function readFile(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

export function containerCpuLimit() {
  const v2 = readFile('/sys/fs/cgroup/cpu.max'); // "quota period" or "max period"
  if (v2) {
    const [quota, period] = v2.split(/\s+/);
    if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0) return Number(quota) / Number(period);
  }
  const q = Number(readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const p = Number(readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  if (q > 0 && p > 0) return q / p;
  return null;
}

export function containerMemoryLimitMB() {
  const v2 = readFile('/sys/fs/cgroup/memory.max');
  if (v2 && v2 !== 'max' && Number(v2) > 0) return Number(v2) / 1024 / 1024;
  const v1 = Number(readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  // cgroup v1 reports a huge number (~2^63) when unlimited.
  if (v1 > 0 && v1 < 2 ** 50) return v1 / 1024 / 1024;
  return null;
}

const hostCores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
// SIM_CORES overrides detection (e.g. a host that hides its cgroup limits).
const cores = Number(process.env.SIM_CORES) > 0
  ? Number(process.env.SIM_CORES)
  : Math.min(hostCores, containerCpuLimit() ?? hostCores);
const memoryMB = Math.min(os.totalmem() / 1024 / 1024, containerMemoryLimitMB() ?? Infinity);

export function maxRooms() {
  const explicit = parseInt(process.env.MAX_CONCURRENT_ROOMS);
  if (explicit > 0) return explicit;
  const byCpu = Math.floor(cores * ROOMS_PER_CORE);
  // The server process itself (Node, Socket.IO, SQLite) needs ~150 MB first.
  const byMemory = Math.floor((memoryMB - 150) * 0.8 / MB_PER_ROOM);
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
    memoryMB: Math.round(memoryMB),
    maxRooms: maxRooms(),
    rooms: Object.keys(activeRooms).length,
    simLoadCores: Number(simLoadCores().toFixed(3)),
    loadCeilingCores: cores * LOAD_CEILING,
  };
}
