export function gameUITemplate() {
  return `
    <div id="gameArea" style="display: none;">
        <div id="canvasContainer" style="position: absolute; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 1;">
            <canvas id="gameCanvas" style="display: block; width: 100%; height: 100%; position: absolute; z-index: 1;"></canvas>
            <canvas id="overlayCanvas" style="display: block; width: 100%; height: 100%; position: absolute; z-index: 2; pointer-events: none;"></canvas>
        </div>

        <!-- Esc / pause menu -->
        <div id="escMenuOverlay" class="game-overlay" style="display: none; pointer-events: auto; z-index: 1200;">
            <div style="width: 320px; background: rgba(15,15,20,0.96); border: 2px solid #ffc107; border-radius: 12px; padding: 28px; box-shadow: 0 0 30px rgba(255,193,7,0.25); text-align: center;">
                <div style="font-size: 22px; font-weight: bold; color: #ffc107; font-family: 'Orbitron', sans-serif; margin-bottom: 6px; text-transform: uppercase;">Game Menu</div>
                <div style="font-size: 12px; color: #888; margin-bottom: 24px;">Press Esc to resume</div>
                <button id="btnResumeGame" style="width: 100%; padding: 14px; margin-bottom: 12px; font-size: 16px; font-weight: bold; background: #28a745; color: #fff; border: 1px solid #3bd95d; border-radius: 8px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;">Resume</button>
                <button id="btnQuitToMenu" style="width: 100%; padding: 14px; font-size: 16px; font-weight: bold; background: rgba(220,53,69,0.85); color: #fff; border: 1px solid #dc3545; border-radius: 8px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;">Main Menu</button>
            </div>
        </div>

        <!-- Spawn Selection Overlay -->
        <div id="spawnOverlay" style="display: none; position: absolute; top: 40px; left: 50%; transform: translateX(-50%); z-index: 1000; background: linear-gradient(135deg, rgba(15, 20, 25, 0.95) 0%, rgba(10, 12, 15, 0.95) 100%); border: 1px solid rgba(255, 193, 7, 0.2); border-top: 2px solid rgba(255, 193, 7, 0.6); border-radius: 40px; padding: 12px 30px; text-align: center; pointer-events: none; box-shadow: 0 10px 25px rgba(0,0,0,0.6), 0 0 20px rgba(255, 193, 7, 0.15); backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: center; gap: 20px; width: max-content;">
            
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
                    <span id="spawnTimerText" style="font-family: 'Orbitron', monospace; font-weight: bold; font-size: 22px; color: #ff4444; text-shadow: 0 0 10px rgba(255, 68, 68, 0.6); line-height: 1;">5</span>
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
            <div id="leaderboardList" style="display: flex; flex-direction: column; gap: 4px;"></div>
        </div>

        <!-- Kill / elimination feed -->
        <div id="killFeed" style="display: none; position: absolute; top: 70px; left: 10px; width: 240px; z-index: 1000; pointer-events: none; flex-direction: column; gap: 6px;"></div>

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
                <div class="hud-stat-box">
                    <span class="hud-stat-label" title="Defense Towers you have placed">Towers</span>
                    <span class="hud-stat-value text-muted" id="lblMyTowers">0</span>
                </div>
                <div class="hud-stat-box">
                    <span class="hud-stat-label" title="Missile Silos you have placed">Silos</span>
                    <span class="hud-stat-value text-muted" id="lblMySilos">0</span>
                </div>
            </div>
            <div class="hud-controls hud-build-controls">
                <div class="build-option" id="btnBuildTower" data-mode="defense_building">
                    <span class="build-key">3</span>
                    <div class="build-info">
                        <span class="build-name">Defense Tower</span>
                        <span class="build-cost text-gold">2,000g</span>
                    </div>
                </div>
                <div class="build-option" id="btnBuildSilo" data-mode="silo">
                    <span class="build-key">4</span>
                    <div class="build-info">
                        <span class="build-name">Missile Silo</span>
                        <span class="build-cost text-gold">10,000g</span>
                    </div>
                </div>
                <div class="build-option" id="btnFireMissile" data-mode="missile">
                    <span class="build-key">2</span>
                    <div class="build-info">
                        <span class="build-name">Fire Missile</span>
                        <span class="build-cost text-gold">2,000g</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
  `;
}
