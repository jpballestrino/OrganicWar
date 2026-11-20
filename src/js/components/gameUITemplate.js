import { BUILD_ACTIONS, fmtInt, linkHelp } from '../constants.js';

// Build-bar buttons, generated from the BUILD_ACTIONS table so names, hotkeys
// and prices are never hand-copied into markup (behaviour lives in buildBar.js).
function buildBarHtml() {
  const tooltip = (a) => (a.type ? `${a.desc}\n\nSynergies (within 60 cells):\n${linkHelp(a.type)}` : a.desc)
    .replace(/"/g, '&quot;');
  return BUILD_ACTIONS.map(a => `
                <button type="button" class="build-option" data-mode="${a.mode}" title="${tooltip(a)}">
                    <span class="build-key">${a.key}</span>
                    <span class="build-info">
                        <span class="build-name">${a.name}</span>
                        <span class="build-cost text-gold">${a.instant ? 'Ready' : `${fmtInt(a.cost)}g`}</span>
                    </span>
                    <span class="build-count" hidden>0</span>
                </button>`).join('');
}

export function gameUITemplate() {
  return `
    <div id="gameArea" style="display: none;">
        <div id="canvasContainer" style="position: absolute; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 1;">
            <canvas id="gameCanvas" style="display: block; width: 100%; height: 100%; position: absolute; z-index: 1;"></canvas>
            <canvas id="overlayCanvas" style="display: block; width: 100%; height: 100%; position: absolute; z-index: 2; pointer-events: none;"></canvas>
        </div>

        <!-- Esc / pause menu -->
        <div id="escMenuOverlay" class="game-overlay" style="display: none; pointer-events: auto; z-index: 1200;">
            <div class="modal-card" style="width: 320px; text-align: center;">
                <div class="modal-header" style="justify-content: center; gap: 0; flex-direction: column; align-items: center; border-bottom: none; padding-bottom: 0; margin-bottom: 20px;">
                    <div class="modal-title" style="font-size: 20px; margin-bottom: 4px;">Game Menu</div>
                    <div style="font-size: 11px; color: #555; letter-spacing: 1px;">ESC to resume</div>
                </div>
                <button id="btnResumeGame" class="modal-btn modal-btn-primary" style="width: 100%; margin-bottom: 16px; padding: 14px; font-size: 15px;">Resume</button>
                <hr class="settings-divider">
                <div class="toggle-row" style="margin-bottom: 4px;">
                    <div style="text-align: left;">
                        <div class="toggle-label">Low Graphics</div>
                        <div class="toggle-sub">Disables glow effects</div>
                    </div>
                    <label class="toggle-switch">
                        <input type="checkbox" id="toggleLowGraphics">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="toggle-row" style="margin-bottom: 4px;">
                    <div style="text-align: left;">
                        <div class="toggle-label">Sound</div>
                        <div class="toggle-sub">Battle sound effects</div>
                    </div>
                    <label class="toggle-switch">
                        <input type="checkbox" id="toggleSound" checked>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <hr class="settings-divider">
                <button id="btnQuitToMenu" class="modal-btn modal-btn-danger" style="width: 100%; padding: 14px; font-size: 15px;">Main Menu</button>
            </div>
        </div>

        <!-- Spawn Selection Overlay -->
        <div id="spawnOverlay" style="display: none; position: absolute; top: 40px; left: 50%; transform: translateX(-50%); z-index: 1000; background: linear-gradient(135deg, rgba(15, 20, 25, 0.95) 0%, rgba(10, 12, 15, 0.95) 100%); border: 1px solid rgba(255, 193, 7, 0.2); border-top: 2px solid rgba(255, 193, 7, 0.6); border-radius: 40px; padding: 12px 30px; text-align: center; pointer-events: none; box-shadow: 0 10px 25px rgba(0,0,0,0.6), 0 0 20px rgba(255, 193, 7, 0.15); backdrop-filter: blur(10px); align-items: center; justify-content: center; gap: 20px; width: max-content;">

            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="display: inline-block; width: 8px; height: 8px; background: #ffc107; border-radius: 50%; box-shadow: 0 0 10px #ffc107; animation: pulse 2s infinite;"></span>
                <div style="font-family: 'Orbitron', sans-serif; font-size: 20px; font-weight: 800; color: #ffc107; text-transform: uppercase; letter-spacing: 1.5px; text-shadow: 0 0 15px rgba(255, 193, 7, 0.3);">Deployment Phase</div>
            </div>

            <div style="width: 1px; height: 24px; background: rgba(255,255,255,0.1);"></div>

            <div style="font-size: 14px; color: #94a3b8; font-family: 'Inter', sans-serif; font-weight: 500; letter-spacing: 0.5px;">
                Secure a strategic land cell to establish your headquarters.
            </div>

            <div style="width: 1px; height: 24px; background: rgba(255,255,255,0.1);"></div>

            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 12px; color: #cbd5e1; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Drop In</span>
                <div style="display: flex; align-items: baseline; gap: 2px;">
                    <span id="spawnTimerText" style="font-family: 'Orbitron', monospace; font-weight: bold; font-size: 22px; color: #ff4444; text-shadow: 0 0 10px rgba(255, 68, 68, 0.6); line-height: 1;">–</span>
                    <span style="font-size: 13px; color: #ff4444; font-weight: 700; opacity: 0.8;">s</span>
                </div>
            </div>

        </div>

        <!-- Game HUD -->
        <div id="gameHUD" class="game-hud" style="display: none;">
            <div class="hud-stats-container">
                <div class="hud-stat-box">
                    <span class="hud-stat-label">Troops</span>
                    <span class="hud-stat-value">
                        <span id="lblMyTroops" class="text-gold" style="font-size: 1.2rem;">0</span>
                        <span class="text-muted" style="font-size: 0.9rem; margin: 0 4px;">/</span>
                        <span id="lblMyMaxPop" class="text-muted" style="font-size: 0.9rem;">0</span>
                    </span>
                </div>
                <div class="hud-stat-box">
                    <span class="hud-stat-label" title="Troops currently committed to an active expansion">Attacking</span>
                    <span class="hud-stat-value text-muted" id="lblMyAttacking">0</span>
                </div>
                <div class="hud-stat-box">
                    <span class="hud-stat-label">Fill</span>
                    <span class="hud-stat-value text-muted" id="lblMyFill">0%</span>
                </div>
                <div class="hud-stat-box">
                    <span class="hud-stat-label" title="Pop / sec — green while accelerating, red while slowing">Growth</span>
                    <span class="hud-stat-value text-success" id="lblMyGrowth">+0/s</span>
                </div>
                <div class="hud-stat-box">
                    <span class="hud-stat-label">Land</span>
                    <span class="hud-stat-value text-gold" id="lblMyCells">0</span>
                </div>
                <div class="hud-stat-box">
                    <span class="hud-stat-label">Kills</span>
                    <span class="hud-stat-value text-gold" id="lblMyKills">0</span>
                </div>
            </div>
            <div class="hud-controls">
                <div class="hud-stat-label">Attack: <span id="lblAttackPct" class="text-gold">20%</span></div>
                <input type="range" id="sliderAttackPct" class="hud-slider" min="1" max="90" value="20">
            </div>
        </div>

        <!-- Game Leaderboard Overlay -->
        <div id="gameLeaderboard" style="display: none; position: absolute; top: 70px; right: 10px; width: 180px; background: rgba(15,15,20,0.85); border: 1px solid #444; border-radius: 6px; padding: 8px; z-index: 1000; pointer-events: none; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
            <div style="font-size: 12px; font-weight: bold; color: #aaa; text-transform: uppercase; margin-bottom: 6px; text-align: center; border-bottom: 1px solid #333; padding-bottom: 4px;">Leaderboard</div>
            <div id="lblMyRank" class="leaderboard-rank-chip"></div>
            <div id="lblDomination" class="leaderboard-domination"></div>
            <div id="leaderboardList" style="display: flex; flex-direction: column; gap: 4px;"></div>
        </div>

        <!-- Kill / elimination feed -->
        <div id="terrainHint" class="terrain-hint" style="display: none;"></div>
        <canvas id="minimap" class="minimap" title="Minimap — click or drag to move the camera" style="display: none;"></canvas>
        <div id="killFeed" style="display: none; position: absolute; top: 70px; left: 10px; width: 240px; z-index: 1000; pointer-events: none; flex-direction: column; gap: 6px;"></div>

        <!-- Reconnecting overlay — shown when socket drops mid-game -->
        <div id="reconnectingOverlay" style="display:none; position:fixed; inset:0; z-index:9000; background:rgba(0,0,0,0.72); backdrop-filter:blur(4px); flex-direction:column; align-items:center; justify-content:center; gap:18px;">
            <div style="width:48px; height:48px; border:4px solid rgba(255,193,7,0.2); border-top-color:#ffc107; border-radius:50%; animation:spin 0.9s linear infinite;"></div>
            <div style="font-family:'Orbitron',sans-serif; font-size:18px; font-weight:700; color:#ffc107; letter-spacing:2px; text-transform:uppercase; text-shadow:0 0 20px rgba(255,193,7,0.5);">Reconnecting…</div>
            <div id="reconnectAttemptText" style="font-size:13px; color:#94a3b8; font-family:'Inter',sans-serif;">Attempting to restore your session</div>
            <div id="reconnectHoldText" style="font-size:12px; color:#64748b; font-family:'Inter',sans-serif; max-width:340px; text-align:center;"></div>
            <button id="btnReconnectLeave" style="margin-top:6px; padding:8px 18px; font-size:12px; background:transparent; color:#94a3b8; border:1px solid rgba(148,163,184,0.4); border-radius:6px; cursor:pointer; font-family:'Inter',sans-serif;">Leave match</button>
        </div>

        <!-- Server-error / unreachable modal — shown after repeated failures -->
        <div id="serverErrorOverlay" style="display:none; position:fixed; inset:0; z-index:9100; background:rgba(0,0,0,0.85); backdrop-filter:blur(6px); align-items:center; justify-content:center;">
            <div style="background:rgba(15,15,20,0.98); border:2px solid #dc3545; border-radius:14px; padding:36px 40px; max-width:380px; text-align:center; box-shadow:0 0 40px rgba(220,53,69,0.3);">
                <div style="font-size:32px; margin-bottom:12px;">⚠</div>
                <div style="font-family:'Orbitron',sans-serif; font-size:17px; font-weight:700; color:#dc3545; margin-bottom:10px; text-transform:uppercase; letter-spacing:1px;" id="serverErrorTitle">Connection Lost</div>
                <div style="font-size:14px; color:#94a3b8; margin-bottom:28px; line-height:1.6;" id="serverErrorMsg">Unable to reach the game server. Your progress has been saved.</div>
                <button id="btnServerErrorReturn" style="width:100%; padding:14px; font-size:15px; font-weight:700; background:#dc3545; color:#fff; border:none; border-radius:8px; cursor:pointer; text-transform:uppercase; letter-spacing:0.5px; font-family:'Orbitron',sans-serif;">Return to Menu</button>
            </div>
        </div>

        <!-- Economy / building HUD (bottom bar) -->
        <div id="gameEconomyHUD" class="game-hud game-hud-bottom" style="display: none;">
            <div class="hud-stats-container">
                <div class="hud-stat-box">
                    <span class="hud-stat-label" title="Gold accumulated">Gold</span>
                    <span class="hud-stat-value text-gold" id="lblMyGold">0</span>
                </div>
                <div class="hud-stat-box">
                    <span class="hud-stat-label" title="Gold per second — scales with territory owned">Income</span>
                    <span class="hud-stat-value text-success" id="lblMyGoldRate">+0/s</span>
                </div>
            </div>
            <div class="hud-controls hud-build-controls">${buildBarHtml()}
            </div>
        </div>
    </div>
  `;
}
