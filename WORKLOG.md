# WORKLOG — resumable task log

> **To resume:** say `continue`. Read this file first, then pick up the first
> unchecked item under **Phases**. Every item is committed and pushed to
> `claude/magical-bell-uik7e1` when it is checked off, so nothing lives only in
> a session. Keep this file current: tick items, and append to **Status log**.

## The request

1. Read `CLAUDE.md`.
2. Find UI inconsistencies and fix them. Review UI logic.
3. Adapt the game for a massive multiplayer online game and scalability.
4. Review the economy and troop system; propose changes that make the game
   funnier and more addictive.
5. Review the current buildings and find new synergies between them to implement.
6. Work so that it can be resumed with a plain `continue`.

## Environment (re-do on a fresh container)

```bash
npm install
rustup target add wasm32-unknown-unknown
npm install -g wasm-pack binaryen     # binaryen = wasm-opt; wasm-pack cannot download it here
npm run build                         # wasm (both targets) + vite
cd simulation-core && cargo test --release
```

Baseline before any change (commit `1278911`): `cargo test` 2 pass; `npm run build`
ok; `npx eslint .` 5 errors + 4 warnings (pre-existing).

Perf baseline, native 20-bot match (`bot_match_report`): 14,500 ticks in 172.6 s
= **11.9 ms/tick** (≈30% of a core per room at 25 Hz). Timeline to reproduce
exactly after a pure-performance change (the sim is deterministic):
`first death at 63s, match over at 580s`; `t=60s top=145819 median=117925`,
`t=300s top=965457 median=961276`.

## Phases

### Phase 1 — UI review & fixes
- [x] 1.1 Esc in a build/targeting mode must cancel the mode only (today it also opens the pause menu).
- [x] 1.2 One `BUILDINGS` table (constants.js) drives the build bar, hotkeys, click placement, affordability, reject toasts. Bar ordered by hotkey, real `<button>`s, tooltips, owned-count badges; costs no longer hard-coded in the template.
- [x] 1.3 Consistent number formatting in the HUD (troops/land raw vs gold localized vs kills abbreviated).
- [x] 1.4 Leaderboard score includes troops out on attack. (Territory labels: same fix, server side — done with 2.3.)
- [x] 1.5 Friendly error surface instead of raw red stack + `alert()`; no `innerHTML` with error text.
- [x] 1.6 `spawnOverlay` inline style declares `display` twice (visible when it should be hidden); stale "5" placeholder.
- [x] 1.7 `building-destroyed` clears a fort zone for non-defense buildings; missile button "disabled" toast wording; duplicated colour tables.
- [x] 1.8 Bottom HUD overflows below ~1500 px wide — compact layout.
- [x] 1.9 Lint clean (5 errors, 4 warnings).
- [x] 1.10 Verify in a real browser (Playwright, headless Chromium) and screenshot.

### Phase 2 — MMO / scalability
- [ ] 2.1 Sim CPU: skip uniform 16×16 blocks in the per-tick border scan (`process_war_fronts`, `bot_think_all`); no div/mod per neighbour. Must reproduce the baseline timeline exactly.
- [ ] 2.2 Sim memory: drop dead per-cell buffers (`troops` 8 MB, `last_modified_tick` 8 MB), shrink `difficulty_to_invade` to u8, size `delta_scratch` on demand (16 MB). ~44 MB → ~8 MB per room (and per browser tab).
- [ ] 2.3 Wire: one binary frame per snapshot (today 7 attachments = 8 WS frames, 20×/s); per-player stats at 5 Hz; skip empty snapshots; authoritative income / growth / effective cap in the stats so the client stops mirroring the economy.
- [ ] 2.4 Full-state sync for reconnect / page reload / late join (today the map is blank, buildings missing, HUD hidden).
- [ ] 2.5 Capacity: room cap derived from CPU cores, load in `/healthz`, websocket compression tuned, "server full" handled.
- [ ] 2.6 Player cap: single source of truth for max players (no scattered `20`/`21`), raise engine cap; measure pacing before changing the Quick Battle default.
- [ ] 2.7 `scripts/bench-room.mjs` (spawn the real worker with bots; tick ms, KB/s, RSS).

### Phase 3 — Economy & troops
- [ ] 3.1 Escalating building prices (+25% per building of that type already owned) — fixes the gold flood / tower spam.
- [ ] 3.2 Plunder: eliminating a faction takes its treasury; destroying an enemy building by conquest pays salvage.
- [ ] 3.3 Blitz (key `1`): active ability on a cooldown — fronts advance faster and cheaper for a few seconds.
- [ ] 3.4 Bots use the new economy (spend gold, build cities).
- [ ] 3.5 Written proposals for what is NOT implemented (below).

### Phase 4 — Building synergies
- [ ] 4.1 Link system in the sim (`building_links` parallel vec, recomputed on complete/destroy/transfer): Walled City (city+tower), Workforce (mine+city), Radar Guidance (silo+anti-air), Flak Tower (anti-air+tower), Arms Industry (silo+mine).
- [ ] 4.2 Client: link lines on the map, linked state in tooltips/preview, range ring and missile price follow links.
- [ ] 4.3 Tests for every link + bots benefit from links.

### Phase 5 — Wrap-up
- [ ] 5.1 `CLAUDE.md` updated to match the code.
- [ ] 5.2 Full build + `cargo test` + lint + e2e worker match + browser check.
- [ ] 5.3 PR description current.

## Findings

### UI (Phase 1)
See the Phase 1 checklist — each item is a concrete defect found in review.
Root causes: the build bar is hand-duplicated six times across template, key
handler, click handler, affordability toggles and reject toasts; and the client
re-derives economy numbers the server already knows.

### Scalability (Phase 2)
- CPU: `process_war_fronts` walks all 2,073,600 cells every tick whenever any
  front is open, calling `get_neighbor` (a div + mod) up to 8× per owned cell.
- Memory: ~44 MB of per-cell buffers per room; three of them are unused or
  oversized.
- Network: each `sim-snapshot` carries 7 binary attachments → 8 websocket
  frames, 20×/s per client; `centroids` is ~1 KB of JSON each time.
- Correctness: nothing sends a full snapshot to a (re)joining socket, so a
  reconnected or reloaded client shows only cells that changed afterwards.
- A "full" snapshot is 4.1 MB but only triggers above 103k dirty cells, where a
  delta would be 415 KB — the threshold is on the wrong side.
- `MAX_CONCURRENT_ROOMS` defaults to 10 regardless of machine size.
- Multi-node scale-out is blocked by SQLite (single file) and in-memory room
  state; documented, not attempted (needs infra that can't be tested here).

### Economy & troops (Phase 3)
- Income is linear in territory (0.00333 gold/cell/s) but prices are flat, so by
  60 s a tower costs ~6 s of income: gold stops mattering and towers get spammed.
- Mines (+10% each) and cities (+5% each) stack without limit at a flat price.
- Bots are capped at one building per 4,000 cells and hoard gold.
- Nothing rewards aggression: no bounty, no salvage, no active ability.
- Troops regenerate fast (peak 5% of cap/s), so gold→troops conversion would be
  pointless; the interesting levers are conquest speed and cost.

### Buildings (Phase 4)
No building interacts with any other today. Placement position only matters
for towers (radius) and silos (range).

## Proposals not implemented (for the owner to decide)

_(written in Phase 3.5)_

## Status log

- Session 1: read CLAUDE.md and the whole codebase; installed toolchain;
  captured baselines; wrote this plan.
- Phase 1 done: `src/js/buildBar.js` + `BUILD_ACTIONS` table; verified with
  `scripts/smoke-browser.mjs` (17 checks, headless Chromium, needs the server
  on :3000). Lint is clean. Next: Phase 2.1.
