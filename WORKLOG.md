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

## Session 5 — accounts, password reset, guilds and chat checked before launch

Tested live with a local mail catcher (the emailed links really followed) and
in a real browser with two players. Bugs found and fixed:
- [x] Guild chat membership was only set when the socket connected: a player
      whose join request was accepted got no chat until reloading; the UI
      ignored kicks/disbands unless the Guild Hall was open (chat panel stayed).
      → `server/game/guildRooms.js`, used by every membership route; the client
      reacts to `guild-update` live.
- [x] Chat showed `&lt;3` for `<3` (server HTML-escaped, client uses textContent).
- [x] Disbanding a guild that had played a Guild War crashed (foreign key).
- [x] Any officer could start a Guild War against any guild by forging
      `guild-war-accept` (no check a challenge was sent; team size unchecked).
- [x] Re-login could mark the player offline / drop them from the socket map.
- [x] No rate limits on login / register / reset emails → `server/rateLimit.js`.
- [x] If the mail server refused the verification email, the account was
      created but could never log in (500, then "username taken").
- [x] Older reset links kept working after a reset; forgot-password claimed to
      send an email when email isn't configured (now says it's unavailable).
- [x] Enter didn't submit login/register/forgot; login now also takes the email;
      register box allowed 20 chars (server max 15); password-manager hints.
- [x] Google/Discord buttons shown even when not configured (now hidden).
- [x] Inline onfocus/onmouseover handlers in the guild modals were blocked by
      the CSP (console errors) → CSS.
- [x] SMTP port 465 (SSL) didn't work (secure was hard-coded off).
Tests: `server/accounts.test.js` (6), `scripts/e2e-accounts.mjs` (67 checks),
`scripts/smoke-accounts.mjs` (32 browser checks), vitest 27/27.
- [ ] Known, not changed: a password reset doesn't log out sessions already
      open elsewhere (JWTs stay valid up to 7 days).
- [ ] **Owner:** configure email (DEPLOY.md) before launch, or "Forgot password"
      stays unavailable.

## Session 6 — bad connections, reconnecting and quitting

Tested with `scripts/smoke-network.mjs`: two players in one match, one behind a
TCP proxy that freezes (lag) or cuts (drop) its connection. Before the fix:
lag showed nothing (map just froze, up to ~45 s before anything noticed);
other players were never told; after the 30 s grace a bot took over and the
player could **never** get back (dumped to the menu); a solo player's room was
deleted the moment the bot took over; a drop during spawn selection left the
player stuck. Fixed:
- [x] Watchdog: stats stop for 2.5 s → "Connection unstable" overlay; 7 s →
      forced new connection. Retries every 0.5–2 s; server pings 10 s/10 s.
- [x] Overlay explains the faction holds for the grace period, then a bot
      plays until you're back; "Leave match" button.
- [x] Returning after the grace period takes the faction back from the bot
      (token valid all match); rooms with only away humans live 2 more minutes.
- [x] `player-connection` notices to everyone (feed + leaderboard 📡/🤖).
- [x] Match ended while away → "The match ended while you were disconnected —
      X won" instead of a silent menu.
- [x] Reconnect during spawn selection → back in the picker with the time left.
- [x] Quit waits for the server's acknowledgement before reloading.
- [x] "Logged in elsewhere" no longer leaves an endless "Reconnecting…".
Settings: `RECONNECT_GRACE_SECONDS` (30), `AWAY_KEEP_SECONDS` (120).

## Session 7 — ranked matches

Bugs found and fixed:
- [x] No skill matching: the first two players in the queue were paired, any
      ratings. → rating-based groups of 2–8 with a widening range (ranked.js).
- [x] A ranked match was a bare 1v1 with no bots on the full map (the game's
      pacing, bounty and domination rules are tuned for 20 factions). → normal
      20-faction battle, bots fill; random map like Quick Battle.
- [x] Rating used "expected vs room average", which halves the effect of
      rating gaps. → pairwise Elo, zero-sum.
- [x] A quitter whose bot outlasted the others could gain rating.
- [x] Leaving to the menu after being eliminated was recorded as quitting
      ("abandoned", ranked last) — the normal way to leave a lost match.
- [x] Custom games also changed rating (+15 / −5): free rating farming.
- [x] The ranked waiting room was listed in the public lobby and joinable.
- [x] A player could be in the ranked queue / a ranked match and start a
      Quick Battle too; their "quit" then hit the wrong room.
- [x] Client: queue screen showed "Players: 1/20"; refused joins left a timer
      running forever; the timer kept running after a match was found; a
      reconnect silently dropped you from the queue; an invisible 20 px button
      ("dev force start", not wired) sat over the page; init-config never told
      the client it was a ranked (or guild-war) match.
- [x] New: the recap shows "Rating 1000 → 1020 (+20) · #1 of 2 players".
Tests: ranked.test.js (9), e2e-ranked.mjs (18), smoke-ranked.mjs (10);
smoke-network 23/23 and vitest 36/36 still pass.

## Session 8 — guild wars and competitive statistics

Guild wars, bugs found and fixed:
- [x] The simulation had no teams: allies could attack each other, and a war
      only ended when one faction was left — teammates had to finish each
      other off. → worker `teams`: no attacks/missiles on allies, team victory
      (last team standing or 75%→50% of the land together).
- [x] A missing member blocked the war forever (it started only with a full
      roster). → 60 s muster: start with whoever came, or call it off.
- [x] Bots: a disconnected player's bot would have attacked its own team. → no
      bots in guild wars.
- [x] Guild rating +30/−20 for equal guilds (inflationary). → zero-sum Elo.
- [x] Individual ratings: unchanged by guild wars (only ranked changes them).
- [x] The war room was public and players had to find their side's slot. →
      private, auto-seated. The client never knew it was a guild war (no
      init-config flags), so team victory/"GUILD WAR" title never showed.
Statistics: rankings only list rated players (global positions, tier, ranked
win rate / avg place); guild W–L; profile split ranked / all modes with
placements, kills, land, form and match history with mode, place and rating
change (migration 007).
Tests: stats.test.js (5), e2e-guildwar.mjs (19), TEAMS=2 bench; vitest 41/41,
e2e-ranked 18/18, smoke-ranked 10/10.

## Session 9 — map data: GPU upload, difficulty, wire format (measured)

The 16 bits per cell are kept (≈11 needed; a u16 is the smallest word that
fits). The waste was in how the data moved. Before → after, same scripts:

| | before | after |
|---|---|---|
| sim tick, native 20-bot match (median of 5) | 0.95 ms | 0.82 ms (−14%) |
| sim tick, real worker 20-player match | 2.12 ms | 1.60 ms (−25%) |
| room CPU (share of one core) | 5.3% | 4.0% |
| room WASM heap | 8 MB | 7 MB |
| deltas per client, raw | 75.2 KB/s | 50.0 KB/s (−34%) |
| deltas per client, on the wire (deflate) | 65.8 KB/s | 27.6 KB/s (−58%) |
| GPU upload at ~40 fps (320×180) | 156 MB/s | 43.6 MB/s (−72%) |
| GPU upload, 800×450 early / mid-match | 61 / 16.6 MB/s | 31 / 9.3 MB/s |
| ms per frame uploading (40 fps) | 0.60 | 0.25 |
| ms to apply a sim-delta, mid-match | 1.26 | 0.20 (−84%) |

- [x] Renderer uploads only changed rows, nothing when nothing changed.
- [x] Fort zones re-derived only for cells that changed owner (equivalence
      test against the full redraw).
- [x] difficulty_to_invade computed on demand; exact same prices (density
      sampled once a second, fresh-cell and tier-at-sample bits): the 20-bot
      timeline is bit-identical. A first version applying tier changes at
      once changed the match (ended at 411 s instead of 510 s) — rejected.
- [x] sim-delta = varint id gap + owner byte (deltaCodec.js); full-sync check
      0 cells differ.
fps in headless Chromium (software GL) is fill-rate bound and did not move;
the upload savings matter on real GPUs/phones and the delta-apply time on
the main thread. Tests: simBridge.test.js (6), vitest 47/47, cargo 6/6,
smoke-browser all passed. Tools: bench-render.mjs, bench-room wire size.

## Session 10 — camera keys (W/A/S/D) sometimes not moving

Reproduced with `scripts/smoke-camera.mjs` (6 of 9 checks failed before):
- [x] A player who didn't pick a spawn started at the whole-map zoom, where the
      map fits the screen and the camera is clamped: no key moved it. → the
      match starts zoomed in on the server-placed centroid too.
- [x] A key held while the window lost focus stayed "down" (no keyup): it
      cancelled the opposite key or drifted. → release all on blur / hidden.
- [x] A hidden menu field (nickname, guild chat) kept the focus and every game
      key was treated as typing (also build hotkeys and Space). → `isTyping()`
      only for visible fields; focus cleared at match start.
- [x] AZERTY / non-Latin layouts: keys read by letter. → physical `e.code`.
smoke-camera 9/9, smoke-browser all, smoke-accounts all, vitest 47/47.

## Session 11 — monotonous maps, crowded Mega Battles ("aplica todos los cambios")

Five proposals, all applied:
- [x] 1. Terrain look: palette, relief shading, coast shallows/surf, snow;
      baked once per map into a texture (the per-frame shader got cheaper:
      headless fps 17.3 → 19.8 instead of 8.0 for the first unbaked try).
- [x] 2. Mega fixes: spawns spread by best-candidate sampling (spawns.js);
      Mega Battles draw from the land-rich maps (MEGA_MAP_POOL); bot truce
      measured and kept at 50 s (same share of early eliminations as 20p);
      labels culled by overlap/size, kill feed folds bursts.
- [x] 3. Gameplay terrain: forests (×3), river fords (×5), gold deposits
      (+0.1 gold/s per cell), ruins (×10, 8 gold per cell); cargo test
      terrain_features_gold_ruins_forest; hover hint. 20-bot matches still
      end at 188–214 s.
- [x] 4. Maps: South America, Asia, Oceania (polygonMap) and procedural
      Pangaea; meandering rivers (flow field). One component each.
- [x] 5. Mega map 2560×1440 (second sim build, cargo feature `mega`).
- [x] Terrain off the hot path: computed at server boot in a background
      thread (6 maps in 9.6 s) and shared with rooms: room start 2.4 s →
      0.19 s (Mega 3.7 s → 0.22 s); browser computes in a Web Worker (no
      3 s freeze). Spawns validated against the exact post-bridge terrain.

Measured (64 players, before → after): spawn nearest neighbour median
~75 → ~185 cells (min ≥ 140); free land gone 18–21 s → ~25 s; tick 2.6 →
3.7–4.4 ms (bigger map); wire 38–40 KB/s per client.

## Session 12 — fog of war and minimap ("only surrounding changes transmitted")

- [x] Sim: compute_vision — per 8×8 block a u64 of factions that see it (own
      land + 48 cells, completed silos see their whole range) + coarse owner.
- [x] Worker: per-player sim-delta, sim-vision reveals (with owners), sim-coarse
      minimap layer to all, fogged sim-full, unfogged spectator view on
      elimination, shared vision for guild-war teammates.
- [x] Client: fog in the shader (coarse empires, dimmed), rival buildings hidden
      in fog, missiles can't be aimed into fog, minimap with camera rectangle.
Measured (bench-room, per player on the wire, full → fogged): 20 players
31.9 → 9.1 KB/s; Mega 56.4 → 7.2 KB/s; minimap layer +0.7 / 1.2 KB/s. Every
viewer's map equals the real one in every block it sees (0 cells wrong).
Fog work ~3 ms/s per viewer. Tests: cargo 8/8 (both builds), vitest 49/49,
smoke-browser standard + mega, smoke-network, smoke-camera.

## Session 13 — spectating was laggy

Measured with `SPECTATE=1 node scripts/bench-render.mjs` (Mega Battle, headless):
spectating 27.2 ms/frame CPU, 11.6 MB/s to the GPU; recap open 123.5 ms/frame.
- [x] GPU upload by 32×32 tiles instead of whole rows (spectators change cells all
      over the map): 24 → 0.14 ms/frame, 11.6 → 0.4 MB/s.
- [x] Recap: no backdrop blur over the live map; map redrawn 4×/s behind it.
- [x] Link pairing only among buildings in view; tower-zone lookup by grid.
- [x] Spectator stream batched to 5/s (each cell once, current owner): 28.8 →
      8.8 KB/s on the wire (20 players).
- [x] permessage-deflate threshold 2048 → 256: a player's fogged stream 9.1 →
      2.8 KB/s.
- [x] Blitz button refreshes the moment it's pressed (the browser test's
      intermittent "Blitz button shows it is active" was a slow frame).
Result: spectating 27.2 → 1.6 ms/frame CPU, recap 123.5 → 3.8 ms/frame.

## Session 14 — buildings drawn by the GPU (WebGL)

Measured with `SPECTATE=1 node scripts/bench-render.mjs` (Mega Battle, spectating;
new: CPU ms spent on buildings + a whole-map view with every building on screen).
- [x] Icon art moved to `buildingArt.js` (unchanged), painted once per distinct icon
      into a sprite atlas; `buildingLayer.js` draws all icons in one instanced
      draw (+ a rotated layer for the spinning parts); zone rings and synergy
      links as instanced distance-field strokes. Construction bar, silo
      cooldown, anti-air charges stay on the overlay canvas.
Whole map (~260 buildings): buildings 6.7–9.1 → 1.0–1.5 ms CPU per frame, frame
8.1–11.9 → 2.2–2.7 ms, 1.9–2.0 → 6.2–6.8 fps (software GL). Zoomed in:
0.7–0.9 → 0.4 ms.
- [x] smoke-camera: checks start away from the map's edges (a spawn at the edge
      pinned the camera there and read as a stuck key — intermittent).
