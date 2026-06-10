export function gameUITemplate() {
  return `
    <div id="gameArea">
        <button id="btnExitMatch" style="position: absolute; top: 10px; right: 10px; z-index: 10; padding: 10px; background: rgba(0,0,0,0.5); color: white; border: 1px solid white; border-radius: 5px; cursor: pointer;">
            <span>🚪</span> Go Back
        </button>
        
        <div id="canvasContainer" style="position: absolute; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 1;">
            <canvas id="gameCanvas" style="display: block; width: 100%; height: 100%;"></canvas>
        </div>
    </div>
  `;
}
