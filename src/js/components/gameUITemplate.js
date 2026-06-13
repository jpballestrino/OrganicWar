export function gameUITemplate() {
  return `
    <div id="gameArea">
        <div id="canvasContainer" style="position: absolute; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 1;">
            <canvas id="gameCanvas" style="display: block; width: 100%; height: 100%;"></canvas>
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
    </div>
  `;
}
