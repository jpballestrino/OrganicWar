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
- [x] 2.1 Sim CPU: skip uniform 16×16 blocks in the per-tick border scan (`process_war_fronts`, `bot_think_all`); no div/mod per neighbour. Must reproduce the baseline timeline exactly.
- [x] 2.2 Sim memory: drop dead per-cell buffers (`troops` 8 MB, `last_modified_tick` 8 MB), shrink `difficulty_to_invade` to u8, size `delta_scratch` on demand (16 MB). ~44 MB → ~8 MB per room (and per browser tab).
- [x] 2.3 Wire: one binary frame per snapshot (today 7 attachments = 8 WS frames, 20×/s); per-player stats at 5 Hz; skip empty snapshots; authoritative income / growth / effective cap in the stats so the client stops mirroring the economy.
- [x] 2.4 Full-state sync for reconnect / page reload / late join (today the map is blank, buildings missing, HUD hidden).
- [x] 2.5 Capacity: room cap derived from CPU cores, load in `/healthz`, websocket compression tuned, "server full" handled.
- [x] 2.6 Player cap: single source of truth for max players (no scattered `20`/`21`), raise engine cap; measure pacing before changing the Quick Battle default.
- [x] 2.7 `scripts/bench-room.mjs` (spawn the real worker with bots; tick ms, KB/s, RSS).

### Phase 3 — Economy & troops
- [x] 3.1 Escalating building prices (+25% per building of that type already owned) — fixes the gold flood / tower spam.
- [x] 3.2 Plunder: eliminating a faction takes its treasury; destroying an enemy building by conquest pays salvage.
- [x] 3.3 Blitz (key `1`): active ability on a cooldown — fronts advance faster and cheaper for a few seconds.
- [x] 3.4 Bots use the new economy (spend gold, build cities).
- [x] 3.5 Written proposals for what is NOT implemented (below).

### Phase 4 — Building synergies
- [x] 4.1 Link system in the sim (`building_links` parallel vec, recomputed on complete/destroy/transfer): Walled City (city+tower), Workforce (mine+city), Radar Guidance (silo+anti-air), Flak Tower (anti-air+tower), Arms Industry (silo+mine).
- [x] 4.2 Client: link lines on the map, linked state in tooltips/preview, range ring and missile price follow links.
- [x] 4.3 Tests for every link + bots benefit from links.

### Phase 5 — Wrap-up
- [x] 5.1 `CLAUDE.md` updated to match the code.
- [x] 5.2 Full build + `cargo test` + lint + e2e worker match + browser check.
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

### Phase 2 results (measured)
- Native 20-bot match (`bot_match_report`): **11.9 → 1.04 ms/tick** (11×), identical
  timeline (deterministic). Real worker / WASM (`scripts/bench-room.mjs`): avg
  2.5 ms/tick = **6% of a core per room** at 25 Hz; worst tick 23 ms.
- Per-cell memory 44 MB → ~6 MB (dropped `troops`, `last_modified_tick`,
  u8 difficulty, on-demand delta buffer).
- Wire per client: stats ~30 KB/s → **4.3 KB/s** (one 896-byte binary record 5×/s
  replaces 7 attachments + JSON centroids 20×/s); empty deltas not sent.
- Reload mid-match restores map / buildings / HUD (`sim-full`, 45 KB RLE).
- This container renders headless Chromium at ~2 FPS (software compositor);
  `smoke-browser.mjs` tolerates slow screenshots.

- Capacity: `server/game/capacity.js` — rooms = min(8/core, 60% RAM / 64 MB),
  refused while the sims use > 75% of the cores. 4-core box → 32 rooms.
- Player cap 20 → 64 (engine); Quick Battle stays 20. 64-player room: 2.9 ms/tick
  (7% of a core), 10 MB heap, 87 KB/s deltas + 14 KB/s stats per client.
  64-player pacing (pre-Phase-3 sim): domination win at 9m09s — leader 21% → 40%
  in ~1 min once the target bottomed out. Big rooms finish without a special rule.

### Phase 3 results (measured)
- Native 20-bot match: over at **407 s** (was 580 s), first elimination 56 s (was 63 s).
- New sim API: `activate_blitz`, `get_plunder_*`; stats record 44 → 76 bytes
  (6 live prices, blitz active / cooldown seconds).
- Events: `blitz-started {factionId}`, `gold-seized {fromId, toId, gold, kind}`.

### Phase 4 results
- Links: Walled City, Workforce, Radar Guidance, Arms Industry, Flak Battery
  (LINK_* in lib.rs, BUILDING_LINKS in constants.js). Seventh parallel vec
  `building_links`; event `building-updated {row, col, links, charges}`.
- Bots build next to their own buildings half the time → links form
  (63 linked buildings seen in a browser match). Native 20-bot match: 422 s.
- Client: links drawn as dashed lines + a ring on each linked icon; placement
  preview names the links you would form; tooltips list synergies.
- 64-player room with Phase 3+4: domination at **4:03** (was 9:09). Leader 52%
  vs 2nd 7.7% — plunder feeds the snowball in big rooms; proposal 1 (bounty on
  the leader) is the counterweight to try first.

## Proposals not implemented (for the owner to decide)

Ordered by expected fun per effort. None needs a wire-format change beyond
what Phases 2–3 added, except where noted.

1. **Bounty on the leader.** Cells taken from the current #1 (by land) cost
   the attacker 20% less and pay a little gold. The anti-snowball throttle is
   invisible today; this turns "stop the leader" into a visible, rewarded goal
   and makes the domination race dramatic. ~40 lines in `process_war_fronts`;
   show a crown + "BOUNTY" on the leader's label.
2. **Neutral hotspots.** 5–8 marked map cells (oil, gold, ports) that pay +X
   gold/s to whoever holds them. Gives the opening a shape (race for the
   hotspot) and the mid-game objectives to fight over. Needs a per-match
   hotspot list in the sim and one more icon type.
3. **Underdog surge.** A faction under ⅓ of the fair share regrows 50% faster.
   Keeps late joiners / losers in the fight longer (retention), cheap to add
   in `apply_production`. Risk: slower matches — measure with the bot report.
4. **Momentum.** A front that keeps conquering for 5 s without stalling gets
   +25% speed until it stalls. Rewards committing to an attack; Blitz is the
   active version, this the passive one. Try one of the two first, not both.
5. **Truces / alliances.** The client already has dormant alliance-proposal
   DOM. A mutual non-aggression pact for 60 s (cannot target each other)
   creates diplomacy and betrayal moments — the most "social" feature for an
   MMO, but needs UI, server validation and bot rules. Largest item.
6. **Interest on banked gold** (e.g. 1%/10 s up to a cap). Makes hoarding a
   choice; with plunder it becomes risk-vs-reward. Cheap, but it fights the
   escalating prices — only if gold still feels pointless after Phase 3.

Not recommended: converting gold into troops. Troops regenerate at up to 5% of
the cap per second, so any fair exchange rate is either useless or decisive.

## Status log

- Session 1: read CLAUDE.md and the whole codebase; installed toolchain;
  captured baselines; wrote this plan.
- Phase 1 done: `src/js/buildBar.js` + `BUILD_ACTIONS` table; verified with
  `scripts/smoke-browser.mjs` (17 checks, headless Chromium, needs the server
  on :3000). Lint is clean. Next: Phase 2.1.
- Phase 2.1–2.4 + 2.7 done (sim block index, exports, worker/runner/client
  rewire, full-state sync, bench script). Next: 2.5 capacity, 2.6 player cap.
- Phase 2.5 + 2.6 done. Next: decide the domination schedule for big rooms
  (measurement running: `PLAYERS=64 SECONDS=1200 node scripts/bench-room.mjs`), then Phase 3.
- Phase 3.1–3.4 done (prices, plunder/salvage, Blitz, bots). Next: 3.5 proposals, then Phase 4.
- Phase 4 done (synergies + visuals, tests). Next: Phase 5 (CLAUDE.md, final verification, PR text).
- Phase 5: CLAUDE.md rewritten for the new wire format, economy, synergies,
  capacity and build bar; dead client constants removed. Final checks: 5 sim
  tests pass, lint clean, `npm run build` ok, browser suite all pass, 20-player
  worker match = domination at 3:30 (6% of a core, 8 MB heap, ~80 KB/s deltas
  + 7 KB/s stats per client), full-state sync exact.
- **All planned work is done.** Open decisions for the owner: the proposals
  above (bounty on the leader first — plunder feeds the snowball in big rooms),
  and whether to offer a 64-player mode in the UI (engine + custom rooms
  support it; Quick Battle stays 20).

## Session 2 — bounty on the leader + Mega Battle (asked after PR #5 merged)

- [x] Bounty on the leader (sim, stats header, bots, map tag, leaderboard 🎯,
      banners, bounty-gold toasts, How to Play) + hysteresis against flicker.
- [x] Mega Battle (64): second Quick Battle queue + home button, per-room
      safe-zone radius (45 for 64), land-only spawn fallback, scaled land
      milestones, Play Again remembers the mode.
- [x] Tests: `bounty_on_a_runaway_leader`; browser suite in both modes
      (`MODE=mega npm run test:browser`).
- Measured before hysteresis: 64 players → domination at 4:00, final lands
  54.9% vs 38.3% (was 52% vs 7.7%); 20 players → 3:40, 54.9% vs 45%.
- After hysteresis + bots ganging up on the target (3 × 64 players, 1 × 20):
  64p ends 4:13 / 4:34 / 4:44, runner-up 35.9% / 40.1% / 37.1% (was 6–8%);
  20p ends 3:50, 55.0% vs 44.8%. Bounties last 2–21 s; the client announces
  the same target at most once per 30 s.
- [x] XP for Mega Battle: results scored as standard-battle equivalents
      (`fieldScale` in progression.js) — land ×3.2, placement ÷3.2, Victory
      150 → 480; mission cards show the Mega target. First JS test file
      (`src/js/progression.test.js`, 8 tests); standard XP is unchanged.
- [x] XP synced to the server for logged-in players: server-scored from the
      worker's own match numbers (shared pure core in progression.js),
      `user_progression` table (migration 006), pushed on connect / at match
      end, one-time validated guest import, player-timezone days. Tests: 16
      vitest (incl. server/game/progression.test.js) + scripts/e2e-progression.mjs
      (real match eliminated / game over, import, win) + Chromium login flow.

## Session 3 — going live

- [x] Production fixes: proxy-aware client IP (`TRUST_PROXY`, server/clientIp.js —
      without it all players behind Render/Caddy shared one IP and the 5-per-IP
      limit capped the game at ~5 players), `DB_PATH` + backups on the volume,
      container-aware capacity (cgroups), Dockerfile rewritten (was broken:
      copied a non-existent /app/migrations; Node 22; no apt; non-root via
      entrypoint), `.dockerignore`, Caddyfile fix (`br` crashed stock Caddy).
- [x] `render.yaml` Blueprint (Docker, Starter, 1 GB disk at /data, health
      check, generated JWT_SECRET, one instance) and docker-compose.yml + Caddy.
- [x] Verified in Docker: image build, 1 CPU/1 GB container (capacity 8 rooms),
      browser suite, persistence across container replacement, root-owned
      disk, real-IP limits, Compose+Caddy HTTPS + full match over wss.
- [ ] **Owner:** buy hosting (Render Starter ≈ $7.25/mo) and optionally a
      domain, then follow DEPLOY.md.

## Session 4 — Google ads option

- [x] Optional AdSense (off unless ADSENSE_CLIENT): home + recap side-rail
      units, between-match interstitials via the Ad Placement API, ads.txt,
      CSP opened only when on, privacy policy page (/privacy, draft to review),
      footer link. Tests: server/ads.test.js (5), scripts/smoke-ads.mjs
      (15 checks on, 7 off), regular browser suite unchanged.
- [x] Fixed: the production image lacked src/reset-password.html (password
      reset links would have failed).
- [ ] **Owner:** own domain → AdSense approval → set ADSENSE_* + CONTACT_EMAIL;
      apply for H5 Games Ads for between-match ads; publish the GDPR message;
      review /privacy.
