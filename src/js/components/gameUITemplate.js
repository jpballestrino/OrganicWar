export function gameUITemplate() {
  return `
    <div id="gameArea">
        <div class="dev-sandbox-container">
            <h1 class="dev-title">Your Game Runs Here!</h1>
            <div class="dev-subtitle">Developer Sandbox & Testing Panel</div>
            



            <div class="dev-btn-group">
                <button id="btnExitMatch" class="dev-btn dev-btn-secondary">
                    <span>🚪</span> Go Back
                </button>
            </div>
        </div>
        
        <!-- Stub/Hidden Elements to prevent JS exceptions in common DOM lookups -->
        <div id="topHUD" style="display: none;"></div>
        <div id="bottomHUD" style="display: none;"></div>
        <div id="leaderboardPanel" style="display: none;"></div>
        <div id="minimapPanel" style="display: none;"></div>
        <div id="canvasContainer" style="display: none;">
            <canvas id="gameCanvas" width="10" height="10"></canvas>
        </div>
        <div id="spawnOverlay" style="display: none;">
            <span id="spawnTimer">0</span>
            <button id="btn-doc-balanced"></button>
            <button id="btn-doc-industrial"></button>
            <button id="btn-doc-militarist"></button>
            <button id="btn-doc-expansionist"></button>
            <button id="btn-leave-spawn"></button>
        </div>
    </div>
  `;
}
