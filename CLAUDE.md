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
- The cell grid is **8-connected** (Moore neighborhood): `neighbor_graph` is stride-8 per cell (0–3 cardinal, 4–7 diagonal). `process_war_fronts` expands **radially**: each tick it scores the conquerable border shell and conquers cells (xorshift random tiebreak via `next_rand`), capped at `MAX_CONQUERS_PER_TICK` **per front**. A click (`execute_expansion`) only commits troops to a front and does **not** steer direction.
- **Multiple attack fronts**: fronts are per-target, stored as `front_pool[attacker × PLAYER_ARRAY_SIZE + target]` (target 0 = neutral land, 1–20 = a specific enemy). A faction can hold several active fronts at once (neutral + multiple enemies); `process_war_fronts` gathers candidates and resolves each front independently, spending only that front's committed troops. `player_attack_pool[f]` is kept as the per-player **sum** of all fronts (recomputed each tick) so the HUD/wire format need no per-front fields. Counter-attack annihilation cancels two mutually-aimed fronts (a→b and b→a) 1-for-1, destroying those troops. `cancel_expansion` (Space) refunds and closes **all** of a faction's fronts.
- JS reads sim data **zero-copy** via `get_*_ptr()` exports that return raw pointers into WASM linear memory; the JS side builds typed-array views over `wasmModule.memory.buffer` at those offsets.
- `tick()` advances production + war fronts. `collect_dirty_cells(since_tick)` packs changed `(cell_id, owner_id)` pairs into a scratch buffer for delta export.
- **Economy is tick-rate-aware** (`set_tick_hz`): per-second rates (troop growth, gold income) are divided by the tick rate, so the *economy* is identical at any `SIM_TICK_HZ`. ⚠️ Expansion speed is **not** normalized — `MAX_CONQUERS_PER_TICK`/`MIN_CONQUERS_PER_TICK`/`EXPANSION_CELLS_PER_TROOP` are per-*tick*, so changing `SIM_TICK_HZ` changes conquest speed unless those are scaled to match. Troop growth/sec is a downward parabola in population fill `p = troops/max_cap` (peak at `GROWTH_PEAK_RATIO`=0.40, zero at full pop, positive floor at `p`=0). Max pop cap = `owned_cells * POP_CAP_PER_CELL` (no flat base). The spawn nucleus radius, `MAX_CONQUERS_PER_TICK`, and the growth constants are all `const`s near the top of `lib.rs`; the growth constants are mirrored in `src/js/constants.js` (only to display the HUD growth rate) — keep them in sync.
- **Gold economy**: `player_gold` (an `f32`, accrued each tick) grows by `owned_cells * GOLD_PER_CELL_PER_SEC` per second (income scales purely with territory). The constant is mirrored in `src/js/constants.js` so the client can show the income rate without an extra wire field. Gold is sent per-faction in the `sim-snapshot` as the `playerGold` buffer (21 × f32) alongside `playerTroops`/`playerMaxPop`/`playerAttack`. The client renders it in the **bottom HUD bar** (`#gameEconomyHUD`, same glass style as the top bar via `.game-hud-bottom`) showing Gold, Income (+/s), and the player's building count. Gold is spent on defense buildings (`DEFENSE_BUILDING_COST`); `state.playerGold` is kept current from the snapshot for the client-side affordability pre-check.
- Constants here (`MAP_WIDTH=1920`, `MAP_HEIGHT=1080`, `MAX_PLAYERS=20`, `PLAYER_ARRAY_SIZE=21`) are mirrored as magic numbers in JS/Node (`src/js/constants.js`, `simulationRunner.js`, hardcoded `1920`/`1080` in `main.js`). Change them in lockstep.

### Per-cell difficulty and territory opacity
- `difficulty_to_invade: Vec<u32>` — one value per cell, recomputed every second in `update_cell_difficulties()`. Formula: `difficulty = (player_density + terrain_cost) × defense_tier`, capped at `DIFFICULTY_CAP = 50`. `player_density` = troops / owned_cells for the cell's owner (0 for neutral). Terrain costs: plains=1, highlands=3, mountains=6. Default `defense_tier` = 1; buildings raise it to 10.
- **Attacker cost vs defender loss** (in `process_war_fronts`): `difficulty_to_invade` is what the **attacker** pays to take an *owned* cell. Two carve-outs: (1) conquering **neutral** land costs a flat `NEUTRAL_INVADE_COST` (=0.2) regardless of terrain — `difficulty_to_invade` only governs owned/defended cells; (2) the **defender** loses only their live troops-per-cell density (`troops / owned_cells`) when a cell falls, *not* the tiered/capped difficulty. So defense tier makes a cell costly for the attacker but never inflates the defender's loss, and an evenly-garrisoned empire reaches 0 troops exactly when it reaches 0 cells (never before).
- **Focused attack**: clicking an enemy opens a front against that faction only (`front_pool[f × PLAYER_ARRAY_SIZE + enemy]`); neutral land and third parties are excluded from that front's candidates, so its troops concentrate on the targeted player's border. Clicking own/neutral land feeds the neutral front (target 0).
- **Territory heatmap**: the GLSL fragment shader computes per-cell opacity as `0.12 + 0.88 × clamp((density/25 + terrainCost/25) × defTier, 0, 1)`. Opacity reaches 100% at difficulty=25 and is capped visually there, even though combat cost continues up to 50. The per-faction density ratio (`troops/cell ÷ 25`) is sent as `u_player_opacity[21]` uniform in each snapshot; terrain and defense tier are read directly from the local `cell_data` texture in the shader.

### Defense buildings
- Placed with the `'3'` key then a click. The server runs `place_defense_building(faction_id, center_row, center_col)` which **verifies the faction can afford `DEFENSE_BUILDING_COST` gold (currently 2000)**, validates the entire 8×8 footprint is owned by the faction and clear of existing buildings, stamps `BUILDING_MASK` (bit 15) on all 64 footprint cells, and sets `defense_tier=10` on every **own** cell within `BUILDING_RADIUS` cells (currently 40). Gold is charged only on full success (a failed validation costs nothing). Neutral and enemy cells in the radius are not affected. `BUILDING_RADIUS` and `DEFENSE_BUILDING_COST` live in `lib.rs` and are mirrored in `src/js/constants.js` (the cost also drives the HUD label and a client-side pre-check; the radius is echoed in the `building-placed` event) — change each in lockstep.
- On success the server emits `building-placed` to all room clients; on failure it emits `build-rejected` only to the requester (the client shows a toast covering both gold and placement requirements).
- **Bots build too**: `bot_build_all()` runs on a ~3s cadence (`botBuildEveryTicks`); each bot that can afford a tower and holds ≥300 cells attempts a placement near its territory centroid (with a jitter that scales with territory size). Bot placements are broadcast via a `placed_buildings_buf` (mirroring the destroyed buffer) polled each tick by `_emitPlacedBuildings()`; human placements still emit directly from `handleInput`, so only bot builds use the buffer (gated on `player_is_bot` inside `place_defense_building`).
- **Destruction**: when any enemy conquers a footprint cell, `destroy_building()` clears `BUILDING_MASK` on the footprint and resets `defense_tier=0` across the radius zone. The server emits `building-destroyed` to all clients.
- **Client sync**: `applyDefenseBuilding()` / `removeDefenseBuilding()` in `src/js/simBridge.js` write the defense tier bits and building flag directly into the client's local WASM `cell_data`, so the heatmap reflects the fortification immediately. Defense tier bits are **never** sent via the snapshot wire format (which carries owner bits only) — they travel exclusively through `building-placed` / `building-destroyed` events.
- `defense_buildings: Vec<u32>` and `destroyed_buildings_buf: Vec<u32>` in `SimulationState` track active and newly-destroyed building centers (encoded as `row × MAP_WIDTH + col`). `get_destroyed_buildings_ptr()` / `clear_destroyed_buildings()` let the server poll and clear the buffer each tick. `placed_buildings_buf` (pairs of `center, faction_id`) does the same for **bot** placements via `get_placed_buildings_ptr()` / `clear_placed_buildings()`.
- Icons are drawn on the 2D overlay canvas by `renderer.drawBuildings(ctx, state.buildings)`. `drawBuildingPlacementPreview()` shows the 8×8 footprint and the `BUILDING_RADIUS` influence zone while hovering in build mode.

### Player elimination and victory
- The Rust sim sets `player_is_alive[fid] = 0` in `update_cell_difficulties()` whenever `player_owned_cells[fid]` drops to 0.
- `RoomSim._checkAlive()` runs after each snapshot (~20×/sec): reads `player_is_alive` from WASM memory, diffs against the previous snapshot's alive set, emits `player-eliminated` per newly-dead faction, and calls `onGameOver(winnerId)` the first time ≤1 faction remains (guarded by `gameOverFired`). The `onGameOver` callback is passed in from `roomManager.js` as `(winnerId) => handleGameOver(room, winnerId)`.
- Dead players' name labels vanish automatically because `_sendSnapshot` only includes players with `owned_cells > 0` in the `centroids` object sent to clients.
- The existing `game-over` socket event triggers the VICTORY/DEFEAT overlay in `network.js` (`triggerEndGame`), with an "Exit to Title Screen" button.

### Server (`server/`)
- `server.js` — Express + Socket.IO bootstrap, Helmet CSP (note `wasm-unsafe-eval` is required), JWT-from-handshake auth middleware that attaches `socket.userId`/`username`/`guildTag` (guests get `socket.isGuest`).
- `game/simulationRunner.js` — `RoomSim`: **one WASM instance per room**, ticking at `SIM_TICK_HZ` (default 60); calls `set_tick_hz` so per-second rates stay correct. **Generates the static terrain into the sim's packed buffer (`generateTerrain`) before any spawns**. Instantiates the node-target WASM directly (not through the wasm-bindgen JS wrapper) to reach linear memory. `buildImports()` stubs wasm-bindgen imports dynamically because their names carry a per-build hash. Emits `sim-snapshot` (~20/sec, `tickHz/20`) with the owner-delta wire format below plus per-faction `playerTroops`/`playerMaxPop`/`playerAttack`/`playerGold` buffers (21 × f32/u32) and a `centroids` object (per-faction `row`/`col`/`troops`/`cells` for the in-territory labels). Accepts an `onGameOver` callback in `opts` to hook into room lifecycle.
- `game/roomManager.js` — room lifecycle, lobby list, matchmaking (ranked + guild war), spawn-selection → finalize → `startMatchNow` (which creates the `RoomSim` with the `onGameOver` callback), game-over scoring (ELO), room GC. Contains a legacy `MockSimulation` class still attached as `room.sim` for compatibility (centroids, shop costs); the real authoritative sim is `room.simReal`.
- `game/socketHandlers.js` — all `socket.on(...)` event wiring; routes `sim-input` to `room.simReal.handleInput(fid, input, onReject)` where `onReject` emits `build-rejected` back to the sender. `game/state.js` — in-memory `activeRooms`, queues, socket maps; `game/gameLoop.js` — matchmaker/player-count intervals.
- `database.js` — `better-sqlite3` (`organicwar.db`, WAL mode; `:memory:` under `NODE_ENV=test`). `migrate.js` runs numbered SQL files in `migrations/` on startup, tracked in a `migrations` table — add schema changes as new numbered files, never edit applied ones.
- `routes/` — REST for auth (`/api/auth`), guilds (`/api/guilds`), and general API.

### Client (`src/`)
- `main.js` — entry. Bootstraps all UI init functions, the home-screen cellular-automata background, the context-aware Escape key chain (`ESC_BACK_CHAIN`), and `startSimulationEngine()` which loads WASM, creates a local `SimulationState` render cache, paints static terrain once, and starts the WebGL render loop. Clicks emit `select-spawn` (spawn phase), `sim-input` with type `expand` (normal attack), or `sim-input` with type `build_defense` when `state.activePurchaseMode === 'defense_building'`. Key `'3'` toggles defense building placement mode; `Escape` cancels it.
- `js/network.js` — Socket.IO client + all server-event handlers; calls `applyOwnerSnapshot()` on `sim-snapshot`, `applyDefenseBuilding()` on `building-placed`, `removeDefenseBuilding()` on `building-destroyed`.
- `js/simBridge.js` — applies the owner-delta wire format into the local WASM render cache's memory (`applyOwnerSnapshot`); also provides `applyDefenseBuilding` and `removeDefenseBuilding` to directly write defense tier and building flag bits into `cell_data` from building events.
- `js/renderer.js` — `WebGLRenderer` uploads the single packed `cell_data` buffer to one R16UI texture each frame and unpacks owner/terrain/defense/building in GLSL; `js/mapGen.js` generates the static North-America terrain into the packed buffer's terrain bits (used by both client and server); `js/state.js` — global client `state` object + `resetGameState()`. State includes `buildings: []` (list of placed building descriptors) and `activePurchaseMode` (null or `'defense_building'`).
- `js/components/*.js` — HTML-string UI templates; `js/initDOM.js` injects them. Vite root is `src/`, build output is `../dist/`.

### Owner-delta wire format (`sim-snapshot` → `ownerDelta`)
Defined identically in `server/game/simulationRunner.js` and `src/js/simBridge.js` — keep both in sync:
- byte 0: `0` = sparse delta, `1` = full packed-cell buffer
- delta: N × `(u32 cell_id, u32 owner_id)` little-endian
- full: `TOTAL_CELLS × 2` bytes of u16 packed cells
A full snapshot is sent instead of a delta when >5% of cells changed. The client merges only the **owner bits** (bits 0–6) into its local `cell_data`, leaving terrain, defense tier, and building flag bits intact — those are set locally by `generateTerrain` and building events. Note the 1-byte header misaligns the payload, so the client copies it to a fresh aligned buffer before viewing.

## Game flow

Quick Play / custom / ranked / guild-war all converge: lobby → `startSpawnSelection` (5s, clients pick spawn cells, radial safe zones radius 80) → `finalizeSpawns` (fills empty slots with bots, auto-places missing spawns on land outside safe zones) → `startMatchNow` (spins up `RoomSim` with `onGameOver` callback, spawns each faction's circular nucleus) → ticking sim streams snapshots → `_checkAlive` detects eliminations and victory → `handleGameOver` records match + ELO and schedules room GC.
