# OrganicWar.io — Pre-Launch Implementation Plan

Items are ordered from most critical (can cause data loss, server takeover, or complete outage) to least critical (polish and growth).

---

## TIER 1 — Launch Blockers (must fix before any public traffic)

### 1. Faction Spoofing — Server Trusts Client-Sent factionId
**Risk: High — a malicious player can control any faction in a room.**
Currently the `factionId` inside `sim-input` payloads is taken from the client. A player can open DevTools and send actions on behalf of any faction.
- At join time, store `socket.assignedFaction` server-side in `socketHandlers.js`.
- In the `sim-input` handler, replace `input.factionId` with `socket.assignedFaction` before forwarding to the WASM worker.
- Reject any `sim-input` whose `factionId` does not match the socket's assigned slot.

### 2. WASM Worker Crash Recovery — Silent Room Death
**Risk: High — any panicking WASM call kills the worker thread and orphans all players in the room.**
The WASM sim runs inside a `worker_threads` Worker. If `tick()` throws (e.g. an out-of-bounds access triggered by bad input), the worker dies silently. Players get stuck with a frozen game and no feedback.
- Wrap the tick interval in `try/catch` inside `simulationWorker.js`. On uncaught error, post a `room-error` message to the main thread.
- In `simulationRunner.js`, handle `room-error` by emitting a `server-error` socket event to all room players and scheduling room GC.
- Add an `uncaughtException` / `unhandledRejection` handler at the Worker level as a final safety net.

### 3. JWT_SECRET Must Come From Environment — Not Random on Boot
**Risk: High — every server restart invalidates all user sessions and reconnect tokens.**
Currently the server generates a random `JWT_SECRET` at startup if none is set. Any crash + restart logs everyone out mid-game and breaks ranked ELO attribution.
- Enforce `JWT_SECRET` via `.env` (already has `dotenv`). Throw a hard startup error if the variable is missing in production.
- Document the required env vars in a `.env.example` file committed to the repo.

### 4. Hard Cap on Concurrent Rooms
**Risk: High — each room is a worker_thread with a full WASM instance (~50–100 MB). Uncapped rooms cause OOM and crash the process.**
- Add a `MAX_CONCURRENT_ROOMS` env var (suggested: 10–20 depending on VPS RAM).
- In `roomManager.js`, reject new Quick Play / custom game creation when the cap is reached and emit a `server-full` event with a user-facing message.
- Expose current room count in a lightweight `/healthz` HTTP endpoint for monitoring.

### 5. Per-IP Connection Limit
**Risk: Medium-High — one user can fill all 20 faction slots in a room, blocking real players or farming ELO.**
- Track socket count per IP in `server.js` using a `Map<ip, count>`.
- Reject connections beyond a threshold (e.g. 3 simultaneous connections per IP) with a `connection-limit` disconnect reason.
- Apply the same check to the `quick-play` and `join-faction` handlers.

### 6. WebSocket Rate Limiting on sim-input
**Risk: Medium-High — a spamming client can flood the WASM worker faster than the tick rate, wasting CPU and potentially triggering edge-case panics.**
- Use `socket.io`'s built-in throttle or a token-bucket per socket.
- Suggested limits: `fire_missile` → max 1/2s per socket, `build_*` → max 1/s, `expand` → max 30/s (matches tick rate).
- Drop excess messages silently (do not disconnect — lag spikes can cause bursts).

### 7. SSL / WSS — HTTPS in Production
**Risk: Medium-High — plain HTTP exposes JWT tokens and game commands in transit. Required by most browsers for secure cookies.**
- Run the Node server behind Nginx or Caddy as a reverse proxy handling TLS termination.
- Caddy is the simplest option: one `Caddyfile` with `reverse_proxy localhost:3000` handles cert renewal automatically via Let's Encrypt.
- Update `CORS` and `socket.io` origins to the production domain once SSL is active.

### 8. WASM Rebuild — Pending Code Changes Not Yet Compiled
**Risk: Medium-High — several Rust changes made during development (max-pop enforcement, building type fixes) are not yet compiled into the WASM binaries.**
- Run `npm run build:wasm` to regenerate both `src/wasm/` (browser) and `server/wasm/` (Node) targets.
- Verify the build succeeds on the deploy host — Render's build environment requires Rust + `wasm-pack` to be installed, or the WASM must be pre-built and committed.
- Add a CI check that runs `cargo test` on `simulation-core` before any deploy.

---

## TIER 2 — Stability & Security (fix within first week of launch)

### 9. Input Validation — Bounds Checking Before WASM
**Risk: Medium — malformed coordinates passed to WASM can trigger panics or undefined behavior.**
- In `simulationWorker.js`, validate that `row` and `col` are integers within `[0, MAP_HEIGHT)` and `[0, MAP_WIDTH)` before calling any WASM export.
- Validate `attack_percentage` is in `[1, 90]`, `factionId` is in `[1, 20]`, and string fields are capped in length before any DB insert.
- Return `build-rejected` for out-of-range inputs rather than forwarding them.

### 10. WASM Build Environment Validation on Deploy
**Risk: Medium — if the Rust toolchain is unavailable on the deploy host, `npm run build` silently skips the WASM step and the server boots with stale binaries.**
- Add a `scripts/check-build-env.sh` that asserts `rustc`, `wasm-pack`, and `wasm-opt` are on PATH and fails the build if not.
- Call it as a `prebuild` npm script so it runs before `npm run build`.
- Alternatively, pre-build the WASM locally and commit the output to a `wasm-dist/` directory that is not gitignored, specifically for the deploy target.

### 11. Process Management — PM2 or Docker
**Risk: Medium — without a process manager, a crash kills the server permanently until someone manually restarts it.**
- **PM2 (simpler):** Create `ecosystem.config.js` with `restart_delay`, `max_memory_restart`, and `NODE_ENV=production`. Add `pm2 startup` to auto-start on reboot.
- **Docker (portable):** Create a `Dockerfile` (Node 20 + Rust + wasm-pack) and a `docker-compose.yml` mounting the SQLite DB as a volume. Ensures identical behavior between local and production.
- Either option should log stdout/stderr to rotating files.

### 12. Automated Database Backups
**Risk: Medium — a single corrupt or accidentally deleted `organicwar.db` file wipes all user accounts and ELO history.**
- Add a cron job (or `node-cron` task in `server.js`) that copies `organicwar.db` to a timestamped backup file every hour.
- Retain the last 48 hourly backups and one backup per day for 30 days.
- If the VPS provider offers volume snapshots, enable them as a second layer.

### 13. Logging and Monitoring
**Risk: Medium — without structured logs, diagnosing production issues (room crashes, authentication failures, abnormal disconnects) is very difficult.**
- Replace `console.log` calls in `server.js`, `roomManager.js`, and `simulationRunner.js` with a lightweight logger (e.g. `pino`) that writes structured JSON in production.
- Log key events: room created/destroyed, player join/leave/disconnect, game over, ELO update, build errors.
- Set up an uptime monitor (e.g. UptimeRobot, free tier) pointing at `/healthz` to alert on downtime.

### 14. Error Handling & Reconnection UI
**Risk: Low-Medium — players who lose connection see a frozen game with no feedback and no way back in without a full reload.**
- Add a visible "Reconnecting…" overlay (already has reconnect logic in `network.js` — just needs UI).
- Show a "Server unreachable" modal with a manual reconnect button if the socket fails after N retries.
- Preserve `reconnectToken` in `sessionStorage` so a page refresh mid-game restores the session (partially implemented — verify it works end-to-end).

---

## TIER 3 — Performance (tune after first players arrive)

### 15. Frontend Production Build
The current deploy already runs `npm run build` → `dist/` and `server.js` serves it in production. Verify this path is active and that Vite's dev server is not accidentally exposed on port 5173 in production.
- Confirm `NODE_ENV=production` is set in the deploy environment.
- Add a check in `server.js` that warns if `dist/` is missing so the server doesn't silently serve nothing.

### 16. WASM Optimization (wasm-opt)
`wasm-pack` calls `wasm-opt` by default in release mode. Verify it is installed on the build host (`wasm-opt --version`). Without it, the WASM binary is 2–3× larger and slower.
- Pass `--release` to `wasm-pack build` (already the case in `package.json` — confirm).
- Gzip-compress the `.wasm` file in Nginx/Caddy; a typical 1 MB WASM compresses to ~300 KB.

### 17. Room Worker Memory Profiling
Each WASM room worker uses a fixed 64 MB linear memory plus Node overhead. On a 1 GB VPS, this caps viable concurrent rooms at roughly 8–10. Profile actual memory usage under load before setting `MAX_CONCURRENT_ROOMS`.
- Use `--inspect` + Chrome DevTools or `clinic.js` to measure per-worker heap.
- Consider reducing WASM `initial_memory` in `Cargo.toml` if the sim does not need the full 64 MB.

---

## TIER 4 — UX Polish (do after stable launch)

### 18. SEO & Social Sharing
Add Open Graph and Twitter card meta tags to `index.html` so Discord / Reddit previews show the game screenshot and description. Include a `robots.txt`, a `sitemap.xml` with the landing page URL, and a 512×512 favicon.

### 19. Mobile Graceful Rejection
The game requires keyboard shortcuts (`1`–`6`, Space, Escape) and right-click. On mobile the UI is unusable. Add a `navigator.maxTouchPoints > 0` check on load that shows a polite "Desktop only" banner instead of a broken layout. Implement touch controls only if mobile support is a future roadmap item.

### 20. Low Graphics Mode
Add a toggle in the settings/ESC menu that disables `shadowBlur` on all canvas draw calls and reduces WebGL shader complexity (remove bilinear blending, flatten heatmap). This helps players on integrated GPUs or lower-end laptops.

---
now 
## Tracking Checklist

| # | Item | Status |
|---|------|--------|
| 1 | Faction spoofing fix | ✓ |
| 2 | WASM worker crash recovery | ✓ |
| 3 | JWT_SECRET from env | ✓ |
| 4 | Concurrent room cap | ✓ |
| 5 | Per-IP connection limit | ✓ |
| 6 | sim-input rate limiting | ✓ |
| 7 | SSL / WSS via Caddy/Nginx | ✓ |
| 8 | WASM rebuild (pending changes) | ⚠ run `npm run build:wasm` |
| 9 | Input bounds validation | ✓ |
| 10 | Build env validation script | ✓ |
| 11 | PM2 / Docker process manager | ✓ |
| 12 | Automated DB backups | ✓ |
| 13 | Structured logging + uptime monitor | ✓ |
| 14 | Reconnection UI overlay | ✓ |
| 15 | Verify prod build path active | ✓ |
| 16 | wasm-opt + Gzip compression | ✓ |
| 17 | Room worker memory profiling | ✓ |
| 18 | SEO / Open Graph tags | ☐ |
| 19 | Mobile rejection banner | ☐ |
| 20 | Low graphics mode toggle | ☐ |
