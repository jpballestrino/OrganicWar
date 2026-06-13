# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OrganicWar.io is a real-time multiplayer territory-conquest browser game (Risk/Territorial.io style). A Rust simulation compiled to WebAssembly runs the cell-grid war on a 1920×1080 map. The **server is authoritative**: it runs the WASM sim per room and streams owner deltas to clients, which run the *same* WASM module purely as a render cache.

## Commands

Development requires **two processes running simultaneously**:

```bash
npm start      # Express + Socket.IO game server on :3000 (also runs DB migrations)
npm run dev    # Vite dev server on :5173, proxies /socket.io → :3000
```

Open the Vite URL (`:5173`) during development — it hot-reloads the client and proxies websockets to the running game server.

Other commands:
```bash
npm run build           # Full production build: WASM (both targets) + vite build → dist/
npm run build:wasm      # Rebuild WASM only (web + node targets); REQUIRED after any Rust change
npm run build:wasm:web  # → src/wasm/  (target=web, used by the browser)
npm run build:wasm:node # → server/wasm/ (target=nodejs, used by the server sim)
npm run lint            # eslint . --fix
npm test                # vitest run (NODE_ENV=test uses in-memory SQLite; no test files exist yet)
npm run preview         # serve the production dist/ build
```

Building WASM requires the Rust toolchain and `wasm-pack` installed.

Production (`render.yaml` / `Procfile`): `npm run build` then `npm start` — the server serves the static `dist/` build when it exists.

## Critical: rebuild the WASM after any Rust change

`src/wasm/` and `server/wasm/` hold generated `wasm-bindgen` output. They are **git-ignored** (wasm-pack writes a `.gitignore` into each output dir), so they are *not* committed — the deploy regenerates them via `npm run build` (see `render.yaml`). Locally, after editing `simulation-core/src/lib.rs` you MUST run `npm run build:wasm` to regenerate *both* targets, or the running game will use stale simulation logic: the browser loads `src/wasm/` and the server loads `server/wasm/` at boot, and the server only picks up the new module on restart. Keep the two targets in sync.

## Architecture

### Simulation core (`simulation-core/src/lib.rs`)
- `SimulationState` uses a **Structure-of-Arrays** layout (parallel `Vec`s indexed by cell id `row*1920+col`, or by player id 1–20; index 0 = neutral/unowned). This avoids per-cell objects and GC pressure.
- The hot per-cell fields are **bit-packed into one `u16` per cell** (`cell_data`): owner (bits 0–6, 0–127), terrain (7–10), defense tier (11–14), has-building (15). The bit layout is mirrored in `src/js/constants.js` (`CELL_*`), the renderer's GLSL unpack, and `src/js/mapGen.js` — change all four together. Private `cell_owner()/cell_terrain()/...` accessors do the masking in Rust.
- The cell grid is **8-connected** (Moore neighborhood): `neighbor_graph` is stride-8 per cell (0–3 cardinal, 4–7 diagonal). `process_war_fronts` expands **radially**: each tick it scores the conquerable border shell by enclosure (`owned_neighbor_count`) and conquers the most-enclosed cells first (xorshift random tiebreak via `next_rand`), capped at `MAX_CONQUERS_PER_TICK`. Filling concavities first means growth is gap-free, leaves **no surrounded cells**, and spreads in all directions — a click (`execute_expansion`) only commits troops to the `attack_pool` and sets a stop-target, it does **not** steer direction.
- JS reads sim data **zero-copy** via `get_*_ptr()` exports that return raw pointers into WASM linear memory; the JS side builds typed-array views over `wasmModule.memory.buffer` at those offsets.
- `tick()` advances production + war fronts. `collect_dirty_cells(since_tick)` packs changed `(cell_id, owner_id)` pairs into a scratch buffer for delta export.
- **Economy is tick-rate-aware** (`set_tick_hz`): per-second rates are divided by the tick rate, so behavior is identical at any `SIM_TICK_HZ`. Troop growth/sec is a downward parabola in population fill `p = troops/max_cap` (peak at `GROWTH_PEAK_RATIO`=0.40, zero at full pop, positive floor at `p`=0). Max pop cap = `owned_cells * POP_CAP_PER_CELL` (no flat base). The spawn nucleus radius, `MAX_CONQUERS_PER_TICK`, and the growth constants are all `const`s near the top of `lib.rs`; the growth constants are mirrored in `src/js/constants.js` (only to display the HUD growth rate) — keep them in sync.
- Constants here (`MAP_WIDTH=1920`, `MAP_HEIGHT=1080`, `MAX_PLAYERS=20`, `PLAYER_ARRAY_SIZE=21`) are mirrored as magic numbers in JS/Node (`src/js/constants.js`, `simulationRunner.js`, hardcoded `1920`/`1080` in `main.js`). Change them in lockstep.

### Server (`server/`)
- `server.js` — Express + Socket.IO bootstrap, Helmet CSP (note `wasm-unsafe-eval` is required), JWT-from-handshake auth middleware that attaches `socket.userId`/`username`/`guildTag` (guests get `socket.isGuest`).
- `game/simulationRunner.js` — `RoomSim`: **one WASM instance per room**, ticking at `SIM_TICK_HZ` (default 60); calls `set_tick_hz` so per-second rates stay correct. **Generates the static terrain into the sim's packed buffer (`generateTerrain`) before any spawns** — otherwise the server's terrain bits are zero and factions expand over water. Instantiates the node-target WASM directly (not through the wasm-bindgen JS wrapper) to reach linear memory. `buildImports()` stubs wasm-bindgen imports dynamically because their names carry a per-build hash. Emits `sim-snapshot` (~20/sec, `tickHz/20`) with the owner-delta wire format below plus player troop/pop buffers.
- `game/roomManager.js` — room lifecycle, lobby list, matchmaking (ranked + guild war), spawn-selection → finalize → `startMatchNow` (which creates the `RoomSim`), game-over scoring (ELO), room GC. Contains a legacy `MockSimulation` class still attached as `room.sim` for compatibility (centroids, shop costs); the real authoritative sim is `room.simReal`.
- `game/socketHandlers.js` — all `socket.on(...)` event wiring; `game/state.js` — in-memory `activeRooms`, queues, socket maps; `game/gameLoop.js` — matchmaker/player-count intervals.
- `database.js` — `better-sqlite3` (`organicwar.db`, WAL mode; `:memory:` under `NODE_ENV=test`). `migrate.js` runs numbered SQL files in `migrations/` on startup, tracked in a `migrations` table — add schema changes as new numbered files, never edit applied ones.
- `routes/` — REST for auth (`/api/auth`), guilds (`/api/guilds`), and general API.

### Client (`src/`)
- `main.js` — entry. Bootstraps all UI init functions, the home-screen cellular-automata background, the context-aware Escape key chain (`ESC_BACK_CHAIN`), and `startSimulationEngine()` which loads WASM, creates a local `SimulationState` render cache, paints static terrain once, and starts the WebGL render loop. Clicks emit `select-spawn` (spawn phase) or `sim-input` (playing).
- `js/network.js` — Socket.IO client + all server-event handlers; calls `applyOwnerSnapshot()` on `sim-snapshot`.
- `js/simBridge.js` — applies the owner-delta wire format into the local WASM render cache's memory.
- `js/renderer.js` — `WebGLRenderer` uploads the single packed `cell_data` buffer to one R16UI texture each frame and unpacks owner/terrain in GLSL; `js/mapGen.js` generates the static North-America terrain into the packed buffer's terrain bits (used by both client and server); `js/state.js` — global client `state` object + `resetGameState()`.
- `js/components/*.js` — HTML-string UI templates; `js/initDOM.js` injects them. Vite root is `src/`, build output is `../dist/`.

### Owner-delta wire format (`sim-snapshot` → `ownerDelta`)
Defined identically in `server/game/simulationRunner.js` and `src/js/simBridge.js` — keep both in sync:
- byte 0: `0` = sparse delta, `1` = full packed-cell buffer
- delta: N × `(u32 cell_id, u32 owner_id)` little-endian
- full: `TOTAL_CELLS × 2` bytes of u16 packed cells
A full snapshot is sent instead of a delta when >5% of cells changed. The client merges only the **owner bits** into its local `cell_data`, leaving its own terrain bits intact (both sides generate the same deterministic terrain via `generateTerrain`). Note the 1-byte header misaligns the payload, so the client copies it to a fresh aligned buffer before viewing.

## Game flow

Quick Play / custom / ranked / guild-war all converge: lobby → `startSpawnSelection` (5s, clients pick spawn cells, radial safe zones radius 80) → `finalizeSpawns` (fills empty slots with bots, auto-places missing spawns on land outside safe zones) → `startMatchNow` (spins up `RoomSim`, spawns each faction's circular nucleus) → ticking sim streams snapshots → `handleGameOver` records match + ELO and schedules room GC.
