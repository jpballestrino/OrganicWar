export function gameUITemplate() {
  return `
    <div id="gameArea">
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
        <div id="spawnOverlay" style="display: none; position: absolute; top: 60px; left: 50%; transform: translateX(-50%); z-index: 1000; background: rgba(15,15,20,0.85); border: 2px solid #ffc107; border-radius: 8px; padding: 15px 30px; text-align: center; pointer-events: none; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
            <div style="font-size: 24px; font-weight: bold; color: #ffc107; text-transform: uppercase; margin-bottom: 5px;">Select Spawn Location</div>
            <div style="font-size: 14px; color: #fff;">Click anywhere on land. Time remaining: <span id="spawnTimerText" style="font-weight: bold; font-size: 18px; color: #ff4444;">20</span>s</div>
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
            </div>
            <div class="hud-controls">
                <div class="hud-stat-label">Attack: <span id="lblAttackPct" class="text-gold">20%</span></div>
                <input type="range" id="sliderAttackPct" class="hud-slider" min="1" max="90" value="20">
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
                <div class="hud-stat-box">
                    <span class="hud-stat-label" title="Defense buildings you have placed">Buildings</span>
                    <span class="hud-stat-value text-muted" id="lblMyBuildings">0</span>
                </div>
            </div>
            <div class="hud-controls">
                <div class="hud-stat-label">Press <span class="text-gold">3</span> to build a Defense Tower <span class="text-gold">(2,000g)</span></div>
            </div>
        </div>
    </div>
  `;
}
