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
        <div id="spawnOverlay" style="display: none; position: absolute; top: 20px; left: 50%; transform: translateX(-50%); z-index: 1000; background: rgba(15,15,20,0.85); border: 2px solid #ffc107; border-radius: 8px; padding: 15px 30px; text-align: center; pointer-events: none; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
            <div style="font-size: 24px; font-weight: bold; color: #ffc107; text-transform: uppercase; margin-bottom: 5px;">Select Spawn Location</div>
            <div style="font-size: 14px; color: #fff;">Click anywhere on land. Time remaining: <span id="spawnTimerText" style="font-weight: bold; font-size: 18px; color: #ff4444;">20</span>s</div>
        </div>

        <!-- Game HUD -->
        <div id="gameHUD" style="display: none; position: absolute; top: 0; left: 0; width: 100vw; height: 50px; z-index: 1000; background: rgba(15,15,20,0.9); border-bottom: 2px solid #ffc107; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; box-sizing: border-box; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
            <div style="font-size: 16px; color: #fff; font-weight: bold; text-transform: uppercase;">
                Troops: <span id="lblMyTroops" style="color: #ffc107; font-size: 18px;">0</span> / <span id="lblMyMaxPop" style="color: #aaa;">0</span>
            </div>
            <div style="display: flex; align-items: center; gap: 15px;">
                <div style="font-size: 14px; color: #ffc107; font-weight: bold; text-transform: uppercase;">Attack: <span id="lblAttackPct">50%</span></div>
                <input type="range" id="sliderAttackPct" min="1" max="100" value="50" style="width: 200px; cursor: pointer; accent-color: #ffc107;">
            </div>
        </div>
    </div>
  `;
}
