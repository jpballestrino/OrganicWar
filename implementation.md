# Scaling & Optimization Plan

A staged set of optimizations toward a multiplayer launch, ordered **lowest risk → highest risk**.
Apply and test **one at a time**, decide if it's worth keeping, then move to the next.

## Root cause (context)

Almost every cost scales with `TOTAL_CELLS = 1920 × 1080 = 2,073,600` and with the **single-threaded
Node server** ticking each room. The two cost centers are:

- **Server CPU** — full-grid scans every tick (`process_war_fronts`) and every snapshot (`collect_dirty_cells`).
- **Network** — owner-delta payload broadcast to every client 20×/sec, plus a ~4 MB full-snapshot path.

Per-room memory is ~110–130 MB (the `neighbor_graph` alone is ~63 MB).

## How to use this doc

- Each step is self-contained with: **Risk · Impact · Scope · Files · Plan · Test · Rollback**.
- **Scope** tells you what to rebuild:
  - `Rust` → run `npm run build:wasm` (both targets) **and restart the server**.
  - `Server JS` → restart the server.
  - `Client JS` → Vite hot-reloads (just refresh).
- Do **Step 0 first** so every later step has before/after numbers to judge by.
- Keep a one-line note per step: baseline number → number after → keep/revert.

---

## Step 0 — Instrumentation (do this first) DONE

**Risk:** none · **Impact:** enables measuring every other step · **Scope:** Server JS + Client JS

Without numbers you can't tell if a step is "worth applying." Add lightweight, toggleable metrics.

**Plan**
- Server (`simulationRunner.js`): time `simulationstate_tick()` with `performance.now()`; keep a rolling
  avg + max tick duration. In `_sendSnapshot`, accumulate the emitted payload byte length and whether it
  was delta vs full, and the dirty-cell count. Log a summary line every ~5 s per room behind an
  env flag (e.g. `SIM_PROFILE=1`).
- Process memory: log `process.memoryUsage().rss` in the same summary.
- Client: an FPS counter + a rolling "snapshot apply ms" (time `applyOwnerSnapshot` + `resyncBuildingZones`),
  shown only when a `?debug` query param or a `state.debug` flag is set.

**Test**
- Start a match vs bots, watch the summary line. Record **baseline**: avg/max tick ms, payload KB/s,
  full-snapshot frequency, RSS, client FPS, apply ms. These are your reference for every step below.

**Rollback:** leave it in (gated by the flag); it's harmless and useful in production too.

---

## Step 1 — Lower the sim tick rate DONE 

**Risk:** low (config) · **Impact:** 2–3× server CPU cut · **Scope:** Rust (constants) + Server JS / env

`SIM_TICK_HZ` defaults to 60 (`simulationRunner.js:92`). Snapshots are already 20 Hz. The economy is
tick-rate-aware, so gold/troop growth are unchanged at a lower rate.

**⚠️ Caveat — expansion speed is NOT tick-rate-aware.** `max_conquers` per front is
`(pool * EXPANSION_CELLS_PER_TROOP).clamp(MIN_CONQUERS_PER_TICK, MAX_CONQUERS_PER_TICK)` **per tick**
(`lib.rs:777`). Fewer ticks/sec ⇒ slower conquest. To keep expansion feel identical when dropping from
60→25 Hz, scale the three constants by ~`60/new_hz` (≈2.4×): e.g. `EXPANSION_CELLS_PER_TROOP 0.3→0.72`,
`MIN_CONQUERS_PER_TICK 2→5`, `MAX_CONQUERS_PER_TICK 100→240`. (Or make `max_conquers` rate-aware by
multiplying by `60/tick_hz` once.)

**Plan**
- Set `SIM_TICK_HZ=25` (env, or change the default).
- Scale the conquer constants as above (Rust) so expansion looks the same.

**Test**
- Tick ms should drop ~2–3×; payload roughly unchanged. **Watch expansion speed** — it should look the
  same as baseline. If it crawls, the conquer-constant scaling is off.

**Rollback:** revert `SIM_TICK_HZ` and the three constants.

---

## Step 2 — Drop `neighbor_graph` (compute neighbors inline) DONE

**Risk:** low · **Impact:** −63 MB per room; slight CPU win (better cache locality) · **Scope:** Rust

It's a regular grid, so the 8 Moore neighbors are O(1) arithmetic. Storing 63 MB of them is pure waste.

**Plan**
- Add an inline helper `fn neighbor(&self, cell, dir) -> i32` (or `neighbors(cell) -> [i32; 8]`) that
  reproduces the **exact** ordering and boundary `-1` rules from `initialize_neighbor_graph`
  (0–3 cardinal: Top, Right, Bottom, Left; 4–7 diagonal: TL, TR, BR, BL).
- Replace every `self.neighbor_graph[base + i]` read (in `process_war_fronts`, `owned_neighbor_count`,
  `bot_think_all`) with the helper.
- Remove the `neighbor_graph` field, its `vec![-1; ...]` init, and `initialize_neighbor_graph`
  (and the `get_neighbor_graph_ptr` export if unused — confirm first).

**Test**
- Gameplay must be **identical** (same expansion shapes, same enclosure-fill behavior). RSS should drop
  by ~63 MB/room. Tick ms equal or slightly better.
- Correctness check: diagonal wrap — make sure edge columns don't wrap to the next row (col 0 has no
  left/TL/BL neighbor). Watch borders at the map edges for one match.

**Rollback:** restore the field + `initialize_neighbor_graph` and revert the call sites.

---

## Step 3 — Incremental dirty list (replace the full-grid `collect_dirty_cells` scan) DONE

**Risk:** low–medium · **Impact:** removes a 2M-cell scan per snapshot (40M/s → O(changes)) · **Scope:** Rust + Server JS

`collect_dirty_cells` scans all 2M cells each snapshot to find the few that changed. Instead, record
changes as they happen.

**Plan**
- Add `dirty_cells: Vec<u32>` to the sim. Push `cell_id` whenever ownership changes (centralize in
  `set_cell_owner`, or at each conquest site + building stamp/destroy).
- `collect_dirty_cells(since_tick)` becomes: dedupe `dirty_cells`, drop ids whose
  `last_modified_tick < since_tick` (or just clear-per-snapshot semantics), pack into `delta_scratch`.
- Server unchanged in shape; just keep calling collect + clear each snapshot.
- Keep the full-snapshot threshold logic; if `dirty count > FULL_SNAPSHOT_THRESHOLD`, still send full.

**Gotcha:** building events also flip cell bits (`BUILDING_MASK`, defense tier) but the wire format only
carries owner bits — don't add building-only changes to the owner dirty list, or you'll send redundant
owner deltas. Only owner changes belong here.

**Test**
- Snapshots must be byte-identical to before for the same game (compare dirty counts/payloads against
  baseline). Tick/snapshot ms drops. No visual desync on clients over a long match.

**Rollback:** revert `collect_dirty_cells` to the full scan; remove `dirty_cells`.

---

## Step 4 — 4-byte delta packing (halve the per-cell wire cost)

**Risk:** medium (wire format, both sides must match) · **Impact:** ~2× smaller deltas · **Scope:** Server JS + Client JS

Delta pairs are `(u32 cell_id, u32 owner_id)` = 8 bytes. `cell_id` needs 21 bits, `owner` needs 7 → fits
in one `u32`.

**Plan**
- Bump the wire header (byte 0): keep `0`/`1`, add `2` = packed-u32 delta (so old/new can't silently
  mismatch). Encode each change as `cell_id | (owner << 21)` (21 bits cell, 7 bits owner).
- Update `simBridge.applyOwnerSnapshot` to decode kind `2`.
- Both files call this out as "keep in sync" already — update the format comment in both.

**Test**
- Payload KB/s ~halves in combat. Ownership renders correctly (no shifted/garbled cells — a packing bug
  shows as random wrong-colored cells). Test a full match incl. a full-snapshot trigger.

**Rollback:** server emits kind `0` again; client still understands `0`.

---

## Step 5 — Compress / RLE the full-snapshot path (defuse the ~4 MB burst)

**Risk:** medium · **Impact:** kills the 82 MB (4 MB × 20 clients) burst; helps late joiners · **Scope:** Server JS + Client JS

A full snapshot is ~4 MB and is broadcast on >5% change and to late joiners. Territory is large
contiguous same-owner regions → compresses enormously.

**Plan (pick one)**
- **A (simplest): RLE the owner stream.** New header kind `3` = RLE of owner bytes: `(u32 runLength,
  u8 owner)` runs. Client expands into owner bits. Typically shrinks 4 MB → tens of KB.
- **B: enable Socket.IO `perMessageDeflate`** for binary frames. One server option, no format change,
  but costs CPU per message — benchmark at 20 Hz × rooms; consider only compressing the full path.

**Test**
- Force a full snapshot (mass early expansion / reconnect). Burst size should collapse. Confirm a
  reconnecting client rebuilds the exact map. Watch server CPU if using deflate.

**Rollback:** stop emitting the new kind; revert to raw full buffer.

---

## Step 6 — Varint gap-encoded deltas (squeeze deltas further)

**Risk:** medium · **Impact:** deltas ~2–3 bytes/cell (clustered borders) · **Scope:** Server JS + Client JS

Builds on Step 4. Changed cells are spatially clustered, so sorted-id + varint gaps compress well.

**Plan**
- New header kind `4`: sort changes by `cell_id`; emit varint(gap) + owner byte per change.
- Client decodes accumulating the gap.
- Only worth it if Step 4's numbers still show deltas as the dominant bandwidth in real matches.

**Test:** payload KB/s vs Step 4; CPU for encode/decode acceptable; rendering correct.
**Rollback:** fall back to kind `2`.

---

## Step 7 — Partial texture upload on the client

**Risk:** medium · **Impact:** removes a 4 MB texture upload every frame · **Scope:** Client JS

The renderer re-uploads the whole packed `cell_data` (4 MB) to the R16UI texture each frame.

**Plan**
- Track the bounding box (or dirty rows) of changed cells from the last applied snapshot and use
  `texSubImage2D` to upload only that region. Full upload only on a full snapshot.

**Test:** client FPS up / GPU upload down on low-end machines; map renders correctly (no stale regions
after partial uploads). Verify after a full snapshot too.
**Rollback:** revert to full `texImage2D` each frame.

---

## Step 8 — Incremental `resyncBuildingZones`

**Risk:** medium · **Impact:** removes O(buildings × radius²) work every snapshot · **Scope:** Client JS

`resyncBuildingZones` re-stamps every building's ~5,000-cell radius on **every** snapshot. With bots now
building towers, this grows with building count.

**Plan**
- Only re-derive a building's zone when cells inside it actually changed owner this snapshot (intersect
  the snapshot's changed-cell set with each building's bounding box), instead of clear-all/restamp-all.

**Test:** client apply-ms drops as building count grows; fortification opacity still tracks ownership
exactly as territory shifts inside a fort radius (the original feature still works).
**Rollback:** revert to the two-pass clear/restamp.

---

## Step 9 — Incremental frontier in `process_war_fronts` (biggest server CPU win)

**Risk:** high (rewrites the hot loop) · **Impact:** turns a 2M-cell/tick scan into O(active border) · **Scope:** Rust

Only border cells can be conquered. Maintain each faction's frontier (border cell set) and update it as
cells flip, instead of rescanning the entire grid every tick.

**Plan**
- Maintain a per-faction frontier structure; when a cell is conquered, remove it from frontiers and add
  its now-eligible neighbors. Gather candidates from the frontier, not a full scan.
- This is subtle: dedupe, handle a cell bordering multiple fronts, handle elimination, keep the
  enclosure-first ordering. Do it with heavy before/after correctness diffing.

**Test:** expansion shapes must match the current behavior on identical seeds; tick ms drops sharply with
territory size. Long-match soak test for frontier drift (no missed/extra conquerable cells).
**Rollback:** keep the full-scan version behind a flag until the frontier version is proven equal.

---

## Step 10 — Horizontal scaling (multi-process + Redis adapter) DONE

**Risk:** high (infra) · **Impact:** scales rooms past one core · **Scope:** Server JS + infra

Node is single-threaded; one process caps at a handful of rooms.

**Plan**
- Either `worker_threads` (one room/sim per worker) or **multiple processes** behind a load balancer with
  sticky sessions + the **Socket.IO Redis adapter** for cross-process rooms/broadcasts.
- Decide the room→process mapping and where authoritative state lives. Update `render.yaml`/`Procfile`.

**Test:** spin up N rooms across processes; confirm matchmaking, room join, broadcasts, and game-over all
work across the boundary; measure per-process CPU.
**Rollback:** single process (current).

---

## Step 11 — Coarser simulation grid (highest leverage, highest risk)

**Risk:** highest (touches everything) · **Impact:** cuts CPU, memory, and bandwidth ~linearly with cell count · **Scope:** Rust + Server JS + Client JS

A 480×270 grid (130k cells) is 16× cheaper everywhere; rendered upscaled/interpolated it can still look
smooth. This is the single biggest ceiling-raiser and should be a conscious, early decision if you go for
real scale.

**Plan (only if the cheaper steps aren't enough)**
- Change `MAP_WIDTH/MAP_HEIGHT` (and all mirrors: `constants.js`, `simulationRunner.js`, hardcoded
  `1920`/`1080` in `main.js`, `mapGen.js`, the GLSL/texture sizing).
- Re-tune spawn radius, building footprint/radius, conquer caps for the new scale.
- Decide rendering: upscale the coarse owner texture with smoothing, or keep a finer *visual* terrain
  layer over a coarse *sim* layer.

**Test:** essentially a re-balance + full visual pass. Treat as its own milestone, not a quick toggle.
**Rollback:** revert the dimension constants (large change — branch it).

---

## Suggested order to actually do them

1. **Step 0** (instrument) — always first.
2. **Steps 1–4** (tick rate, drop neighbor_graph, dirty list, 4-byte deltas) — low risk, immediate CPU+mem+bandwidth wins; enough for a closed beta.
3. **Steps 5–8** (full-snapshot compression, varint deltas, partial texture, incremental resync) — medium, do the ones your Step-0 numbers say matter.
4. **Steps 9–11** (frontier, horizontal scaling, coarser grid) — for public-scale; each is its own project.

> Reminder: every Rust change needs `npm run build:wasm` + a server restart to take effect; JS-only
> changes need at most a server restart (client hot-reloads via Vite). Wire-format steps (4, 5, 6) must
> have server and client updated together.
