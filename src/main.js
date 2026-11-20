import './js/initDOM.js';
import { socket, initNetwork, quitAndReload } from './js/network.js';
import { initAuthUI } from './js/authUI.js';
import { initGuildUI } from './js/guildUI.js';
import { initRankingsUI } from './js/rankingsUI.js';
import { initFeedbackUI } from './js/feedbackUI.js';
import { state } from './js/state.js';
import initWasm, { SimulationState } from './wasm/simulation_core.js';
import wasmUrl from './wasm/simulation_core_bg.wasm?url';
import { WebGLRenderer } from './js/renderer.js';
import { registerSim, getCellOwner, countOwnedCells } from './js/simBridge.js';
import { generateTerrain, warmMapCache } from './js/mapGen.js';
import { initSfx, playSfx, isMuted, setMuted } from './js/sfx.js';
import { initMatchFeel, consumeAutoQuickPlay } from './js/matchFeel.js';
import { renderProgressCards } from './js/progression.js';
import { initAds } from './js/ads.js';
import { isTyping } from './js/typing.js';
import { initBuildBar, handleBuildClick, cancelBuildMode, drawBuildPreview, syncBuildBarActive } from './js/buildBar.js';

let wasmModule = null;
let simulation = null;
let renderer = null;

// Global error surface. Details always go to the console; the player sees one
// small dismissible notice (never a raw stack trace, and never markup built
// from the error text). The full message is shown only with ?debug.
function showErrorNotice(title, detail) {
  let box = document.getElementById('errorNotice');
  if (!box) {
    box = document.createElement('div');
    box.id = 'errorNotice';
    box.className = 'error-notice';
    const text = document.createElement('div');
    text.className = 'error-notice-text';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload';
    reload.onclick = () => location.reload();
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.onclick = () => box.remove();
    box.append(text, reload, close);
    document.body.appendChild(box);
  }
  const showDetail = detail && new URLSearchParams(window.location.search).has('debug');
  box.querySelector('.error-notice-text').textContent = showDetail ? `${title} — ${detail}` : title;
}

window.addEventListener('error', (e) => {
  // Resource-load errors (an <img>/<script> 404) have no message; ignore them.
  if (!e.message) return;
  console.error('[client error]', e.message, e.filename, e.lineno, e.error);
  showErrorNotice('Something went wrong. If the game misbehaves, reload the page.', e.message);
});

// Home Background Cellular Automata Animation
(function initHomeBgCanvas() {
  const canvas = document.getElementById('homeBgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const CELL = 6;
  let cols, rows, grid, factions, animId;
  // The grid is painted into a cols×rows bitmap (one pixel per cell) and
  // scaled up in a single drawImage — instead of one fillRect per cell per
  // frame (~57k at 1080p), which pinned a CPU core on software rendering.
  let bitmap, bitmapCtx, image;

  // RGBA, alpha 0.7. Index 0 (empty) stays transparent.
  const FACTION_COLORS = [
    null,
    [220, 60, 60], [60, 140, 220], [60, 200, 80], [220, 180, 40],
    [180, 60, 220], [220, 120, 40], [40, 200, 200], [220, 80, 160],
  ];
  const NUM_FACTIONS = FACTION_COLORS.length - 1;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    cols = Math.ceil(canvas.width / CELL);
    rows = Math.ceil(canvas.height / CELL);
    bitmap = document.createElement('canvas');
    bitmap.width = cols;
    bitmap.height = rows;
    bitmapCtx = bitmap.getContext('2d');
    image = bitmapCtx.createImageData(cols, rows);
    ctx.imageSmoothingEnabled = false;
    initGrid();
  }

  function initGrid() {
    grid = new Uint8Array(rows * cols);
    factions = [];
    const count = 6 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const fid = (i % NUM_FACTIONS) + 1;
      const cr = Math.floor(Math.random() * rows);
      const cc = Math.floor(Math.random() * cols);
      const radius = 3 + Math.floor(Math.random() * 4);
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const nr = cr + dr, nc = cc + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && dr*dr + dc*dc <= radius*radius) {
            grid[nr * cols + nc] = fid;
          }
        }
      }
      factions.push(fid);
    }
  }

  function step() {
    const changes = [];
    for (let i = 0; i < 80; i++) {
      const r = Math.floor(Math.random() * rows);
      const c = Math.floor(Math.random() * cols);
      const fid = grid[r * cols + c];
      if (fid === 0) continue;
      const dir = Math.floor(Math.random() * 4);
      const dr = [0, 0, -1, 1][dir];
      const dc = [-1, 1, 0, 0][dir];
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        const target = grid[nr * cols + nc];
        if (target !== fid && Math.random() < (target === 0 ? 0.6 : 0.15)) {
          changes.push([nr, nc, fid]);
        }
      }
    }
    for (const [r, c, fid] of changes) {
      grid[r * cols + c] = fid;
    }
  }

  function draw() {
    const px = image.data;
    for (let i = 0; i < grid.length; i++) {
      const color = FACTION_COLORS[grid[i]];
      const o = i * 4;
      if (color) {
        px[o] = color[0]; px[o + 1] = color[1]; px[o + 2] = color[2]; px[o + 3] = 178;
      } else {
        px[o + 3] = 0;
      }
    }
    bitmapCtx.putImageData(image, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, cols * CELL, rows * CELL);
  }

  let lastStep = 0;
  function animate(ts) {
    const homeScreen = document.getElementById('homeScreen');
    if (!homeScreen || homeScreen.style.display === 'none') {
      canvas.style.display = 'none';
      return;
    }
    canvas.style.display = 'block';
    // The picture only changes when the automaton steps, so only redraw then.
    if (ts - lastStep > 50) {
      step();
      draw();
      lastStep = ts;
    }
    animId = requestAnimationFrame(animate);
  }

  window.addEventListener('resize', resize);
  resize();
  animId = requestAnimationFrame(animate);

  const observer = new MutationObserver(() => {
    const hs = document.getElementById('homeScreen');
    if (hs && hs.style.display !== 'none') {
      resize();
      cancelAnimationFrame(animId);
      animId = requestAnimationFrame(animate);
    }
  });
  const hs = document.getElementById('homeScreen');
  if (hs) observer.observe(hs, { attributes: true, attributeFilter: ['style'] });
})();

// Initialize Lobby / Out of Game UI Listeners
function initLobbyUI() {
  const homeScreen = document.getElementById('homeScreen');
  const lobbyBrowser = document.getElementById('lobbyBrowserOverlay');
  const createGameOverlay = document.getElementById('createGameOverlay');
  const nickInput = document.getElementById('nicknameInput');
  
  const androidNames = [
    'Nexus-1', 'Nova-7', 'Cygnus-X', 'Orion-9', 'Aegis-4', 'Vanguard-2', 
    'Pulse-8', 'Zenith-5', 'Cobalt-3', 'Titan-6', 'Atlas-0', 'Echo-7',
  ];
  // Remember a guest's callsign between visits; fall back to a random one.
  let savedNick = '';
  try { savedNick = localStorage.getItem('ow_nickname') || ''; } catch (_) { /* storage blocked */ }
  if (nickInput && !nickInput.value) {
    nickInput.value = savedNick || androidNames[Math.floor(Math.random() * androidNames.length)];
  }

  const btnMultiplayer = document.getElementById('btn-multiplayer');
  if (btnMultiplayer) {
    btnMultiplayer.onclick = () => {
      if (lobbyBrowser) lobbyBrowser.style.display = 'flex';
      socket.emit('request-rooms');
    };
  }

  const btnMultiplayerGuest = document.getElementById('btn-multiplayer-guest');
  if (btnMultiplayerGuest) {
    btnMultiplayerGuest.onclick = () => {
      if (lobbyBrowser) lobbyBrowser.style.display = 'flex';
      socket.emit('request-rooms');
    };
  }

  // mode: 'standard' (20 players) or 'mega' (64) — two separate queues.
  const handleQuickPlay = (mode = 'standard') => {
    let name = nickInput ? nickInput.value : 'Guest';
    state.playerNickname = name;
    state.quickMode = mode;
    try { localStorage.setItem('ow_nickname', name); } catch (_) { /* storage blocked */ }
    if (homeScreen) homeScreen.style.display = 'none';
    socket.emit('quick-play', { nickname: state.playerNickname, mode });
  };

  // "Play Again" on the recap screen reloads the page with the mode saved, so
  // the player drops straight into the same kind of battle again.
  const autoMode = consumeAutoQuickPlay();
  if (autoMode) { setTimeout(() => handleQuickPlay(autoMode), 200); }

  const btnQuickPlay = document.getElementById('btn-quick-play');
  if (btnQuickPlay) btnQuickPlay.onclick = () => handleQuickPlay('standard');

  const btnQuickPlayGuest = document.getElementById('btn-quick-play-guest');
  if (btnQuickPlayGuest) btnQuickPlayGuest.onclick = () => handleQuickPlay('standard');

  for (const id of ['btn-mega-play', 'btn-mega-play-guest']) {
    const btn = document.getElementById(id);
    if (btn) btn.onclick = () => handleQuickPlay('mega');
  }

  // Ranked Matchmaker
  let rankedTimerInterval = null;
  let rankedTimeElapsed = 0;
  const startRankedTimer = () => {
    rankedTimeElapsed = 0;
    const lblTimer = document.getElementById('lblRankedTimer');
    if (lblTimer) lblTimer.innerText = '00:00';
    if (rankedTimerInterval) clearInterval(rankedTimerInterval);
    rankedTimerInterval = setInterval(() => {
      rankedTimeElapsed++;
      if (lblTimer) {
        let m = Math.floor(rankedTimeElapsed / 60).toString().padStart(2, '0');
        let s = (rankedTimeElapsed % 60).toString().padStart(2, '0');
        lblTimer.innerText = `${m}:${s}`;
      }
    }, 1000);
  };
  const stopRankedTimer = () => {
    if (rankedTimerInterval) clearInterval(rankedTimerInterval);
    rankedTimerInterval = null;
  };
  const rankedQueueVisible = () => document.getElementById('homeStateRankedQueue')?.style.display === 'flex';
  const showRankedQueue = (on) => {
    const loggedInView = document.getElementById('homeStateLoggedIn');
    const queueView = document.getElementById('homeStateRankedQueue');
    if (queueView) queueView.style.display = on ? 'flex' : 'none';
    if (loggedInView) loggedInView.style.display = on ? 'none' : 'block';
    if (!on) stopRankedTimer();
  };
  // The server refused or dropped us from the queue (not logged in, already
  // in a match…): back to the menu instead of a timer that never ends.
  socket.on('ranked-queue-left', () => { if (rankedQueueVisible()) showRankedQueue(false); });
  socket.on('ranked-match-found', () => stopRankedTimer());
  // After a reconnect the server has forgotten our place in the queue.
  socket.io.on('reconnect', () => { if (rankedQueueVisible()) socket.emit('join-ranked-queue'); });

  const btnRankedPlay = document.getElementById('btn-ranked-play');
  if (btnRankedPlay) {
    btnRankedPlay.onclick = () => {
      showRankedQueue(true);
      const lbl = document.getElementById('lblRankedPlayers');
      if (lbl) lbl.innerText = 'Searching for opponents…';
      socket.emit('join-ranked-queue');
      startRankedTimer();
    };
  }

  const btnLeaveRanked = document.getElementById('btn-leave-ranked');
  if (btnLeaveRanked) {
    btnLeaveRanked.onclick = () => {
      showRankedQueue(false);
      socket.emit('leave-ranked-queue');
    };
  }

  const btnBackLobby = document.getElementById('btn-back-lobby');
  if (btnBackLobby) {
    btnBackLobby.onclick = () => {
      if (lobbyBrowser) lobbyBrowser.style.display = 'none';
      if (homeScreen) homeScreen.style.display = 'flex';
    };
  }

  const btnShowCreate = document.getElementById('btn-show-create');
  if (btnShowCreate) {
    btnShowCreate.onclick = () => {
      if (lobbyBrowser) lobbyBrowser.style.display = 'none';
      if (createGameOverlay) createGameOverlay.style.display = 'flex';
    };
  }

  // Slider
  const sliderAttackPct = document.getElementById('sliderAttackPct');
  const lblAttackPct = document.getElementById('lblAttackPct');
  if (sliderAttackPct && lblAttackPct) {
    sliderAttackPct.oninput = (e) => {
      state.attackPercentage = parseInt(e.target.value);
      lblAttackPct.innerText = state.attackPercentage + '%';
    };
  }

  const btnBackCreate = document.getElementById('btn-back-create');
  if (btnBackCreate) {
    btnBackCreate.onclick = () => {
      if (createGameOverlay) createGameOverlay.style.display = 'none';
      if (lobbyBrowser) lobbyBrowser.style.display = 'flex';
      socket.emit('request-rooms');
    };
  }

  const btnCreateRoom = document.getElementById('btn-create-room');
  if (btnCreateRoom) {
    btnCreateRoom.onclick = () => {
      const name = document.getElementById('gameNameInput').value || 'Game';
      const maxPlayers = document.getElementById('maxPlayersInput').value || 5;
      const preset = document.getElementById('mapPresetSelect').value || 'north_america';
      
      state.playerNickname = nickInput ? nickInput.value : 'Host';
      if (createGameOverlay) createGameOverlay.style.display = 'none';
      socket.emit('create-custom-room', { name, maxPlayers, preset, nickname: state.playerNickname });
    };
  }

  const btnLeaveRoom = document.getElementById('btn-leave-room');
  if (btnLeaveRoom) {
    btnLeaveRoom.onclick = () => {
      quitAndReload();
    };
  }

  const btnForceStart = document.getElementById('btn-force-start');
  if (btnForceStart) {
    btnForceStart.onclick = () => {
      socket.emit('start-custom-game');
    };
  }

  // Tutorial / Info Modal
  const linkTutorial = document.getElementById('linkTutorial');
  const tutorialModal = document.getElementById('tutorialModal');
  const btnCloseTutorial = document.getElementById('btnCloseTutorial');
  if (linkTutorial && tutorialModal) {
    linkTutorial.onclick = (e) => {
      e.preventDefault();
      tutorialModal.style.display = 'block';
    };
  }
  if (btnCloseTutorial && tutorialModal) {
    btnCloseTutorial.onclick = () => {
      tutorialModal.style.display = 'none';
    };
  }

  // Profile Close
  const btnCloseProfile = document.getElementById('btn-close-profile');
  if (btnCloseProfile) {
    btnCloseProfile.onclick = () => {
      document.getElementById('profileModal').style.display = 'none';
    };
  }

  // Rankings Close
  const btnCloseRankings = document.getElementById('btnCloseRankings');
  if (btnCloseRankings) {
    btnCloseRankings.onclick = () => {
      document.getElementById('rankingsModal').style.display = 'none';
    };
  }
}

// Initialize Developer Sandbox Dashboard Button Actions
function initDevSandboxUI() {
  const btnSimulateVictory = document.getElementById('btnSimulateVictory');
  if (btnSimulateVictory) {
    btnSimulateVictory.onclick = () => {
      socket.emit('dev-simulate-game-over', { result: 'win' });
    };
  }

  const btnSimulateDefeat = document.getElementById('btnSimulateDefeat');
  if (btnSimulateDefeat) {
    btnSimulateDefeat.onclick = () => {
      socket.emit('dev-simulate-game-over', { result: 'loss' });
    };
  }
}

// Context-aware Escape key:
//   - In a match: toggle the pause menu (Resume / Main Menu).
//   - In the lobby/menus: act as "back" — close the top-most open modal, or
//     step back one screen, by reusing each surface's existing close/back button.
// Ordered most-nested (modals) first; the first visible match wins.
const ESC_BACK_CHAIN = [
  ['guildEditModal', 'btnCancelGuildEdit'],
  ['guildInviteModal', 'btnCancelInvite'],
  ['profileModal', 'btn-close-profile'],
  ['rankingsModal', 'btnCloseRankings'],
  ['tutorialModal', 'btnCloseTutorial'],
  ['guildHallOverlay', 'btn-close-guild-hall'],
  ['createGameOverlay', 'btn-back-create'],
  ['lobbyBrowserOverlay', 'btn-back-lobby'],
  ['homeStateRankedQueue', 'btn-leave-ranked'],
];

function initEscMenu() {
  const overlay = document.getElementById('escMenuOverlay');
  if (!overlay) { return; }
  const btnResume = document.getElementById('btnResumeGame');
  const btnQuit = document.getElementById('btnQuitToMenu');

  // #gameArea is hidden until spawn selection (so the map canvas never flashes
  // during the home/matchmaking screens), then shown. Gate the pause menu on
  // match state rather than visibility. SPAWN_SELECTION counts as in-game: the
  // map is on screen during the start countdown, and Esc should work there too.
  const isInGame = () => state.gameState === 'PLAYING' || state.gameState === 'SPAWN_SELECTION';
  const isOpen = () => overlay.style.display !== 'none';
  const closeMenu = () => { overlay.style.display = 'none'; };
  const openMenu = () => { overlay.style.display = 'flex'; };
  const isVisible = (el) => el && getComputedStyle(el).display !== 'none';

  const onEscKey = (e) => {
    if (e.key !== 'Escape') { return; }

    // A placement / targeting mode is the innermost thing on screen: Esc backs
    // out of it and nothing else (it must not also open the pause menu).
    if (!isOpen() && cancelBuildMode()) { return; }

    // In a match, Esc toggles the pause menu — before the lobby rules below, so
    // a focused field (e.g. guild chat) can't swallow the first press.
    if (isInGame() || isOpen()) {
      if (isOpen()) { closeMenu(); } else { openMenu(); }
      return;
    }

    // In the lobby/menus: first Esc while typing just defocuses the field.
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      active.blur();
      return;
    }

    // Otherwise behave as back / close-modal for the current lobby surface.
    for (const [containerId, btnId] of ESC_BACK_CHAIN) {
      if (isVisible(document.getElementById(containerId))) {
        document.getElementById(btnId)?.click();
        return;
      }
    }
  };

  // Bind exactly once, replacing any previous binding (e.g. across dev
  // hot-reloads) so duplicate listeners can't toggle the menu twice per press.
  if (window.__escKeyHandler) { window.removeEventListener('keydown', window.__escKeyHandler); }
  window.__escKeyHandler = onEscKey;
  window.addEventListener('keydown', onEscKey);

  if (btnResume) { btnResume.onclick = closeMenu; }
  if (btnQuit) { btnQuit.onclick = () => quitAndReload(); }
  // Clicking the dimmed backdrop (outside the menu box) also resumes.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { closeMenu(); } });

  // Low-graphics toggle — persisted in localStorage, never reset between games
  const toggleLowGraphics = document.getElementById('toggleLowGraphics');
  if (toggleLowGraphics) {
    try { if (localStorage.getItem('lowGraphics') === '1') { state.lowGraphics = true; toggleLowGraphics.checked = true; } } catch (_) { /* storage blocked */ }
    toggleLowGraphics.onchange = (e) => {
      state.lowGraphics = e.target.checked;
      try { localStorage.setItem('lowGraphics', e.target.checked ? '1' : '0'); } catch (_) { /* storage blocked */ }
    };
  }

  // Sound toggle — persisted by the sfx module.
  const toggleSound = document.getElementById('toggleSound');
  if (toggleSound) {
    toggleSound.checked = !isMuted();
    toggleSound.onchange = (e) => {
      setMuted(!e.target.checked);
      if (e.target.checked) playSfx('select');
    };
  }
}

// Mobile device guard — game requires keyboard + mouse; no touch support
const _isMobile = window.matchMedia('(pointer: coarse) and (hover: none)').matches;
if (_isMobile) {
  const mb = document.getElementById('mobileBlock');
  if (mb) mb.style.display = 'flex';
} else {
  initSfx();
  initNetwork();
  initMatchFeel({ socket, quit: quitAndReload });
  initAds(); // Google ads, only if the server has them configured
  renderProgressCards();
  initAuthUI();
  initGuildUI();
  initRankingsUI();
  initFeedbackUI();
  initLobbyUI();
  initDevSandboxUI();
  initEscMenu();
}

// Debug mode check
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('debug')) {
  state.debug = true;
  // Lets scripts/smoke-browser.mjs inspect the client.
  window.__owState = state;
  window.__owCountOwned = countOwnedCells;
  window.__owSocket = socket;
  const debugDiv = document.createElement('div');
  debugDiv.id = 'debugUI';
  debugDiv.style.position = 'absolute';
  debugDiv.style.top = '10px';
  debugDiv.style.right = '10px';
  debugDiv.style.background = 'rgba(0,0,0,0.8)';
  debugDiv.style.color = '#0f0';
  debugDiv.style.padding = '5px 10px';
  debugDiv.style.fontFamily = 'monospace';
  debugDiv.style.zIndex = '9999';
  debugDiv.style.pointerEvents = 'none';
  debugDiv.innerHTML = `FPS: --<br>Apply: -- ms`;
  document.body.appendChild(debugDiv);
}

// ------------------------------------------------------------------
// High-Density Simulation & Renderer Initialization
// ------------------------------------------------------------------
async function startSimulationEngine() {
  try {
    wasmModule = await initWasm(wasmUrl);
    simulation = new SimulationState();

    // Local SimulationState is now just a render cache; the server holds
    // authoritative state and pushes owner deltas via sim-snapshot.
    // Owner + terrain + defense + has_building are bit-packed into one u16 per
    // cell (cell_data); the renderer unpacks owner/terrain on the GPU.
    const cellDataPtr = simulation.get_cell_data_ptr();

    // Paint the static North America terrain into the packed cell buffer's
    // terrain bits. It never changes, so this runs once at startup.
    generateTerrain(wasmModule.memory, cellDataPtr);

    const canvas = document.getElementById('gameCanvas');
    renderer = new WebGLRenderer(canvas, wasmModule.memory);
    window.renderer = renderer; // Expose globally for network events
    renderer.setMemoryPointers(cellDataPtr);
    registerSim({ memory: wasmModule.memory, cellDataPtr });

    console.log("WASM render cache & WebGL Renderer Started!");

    // Pre-warm the bridge cache asynchronously so it doesn't block the UI
    // when a match starts and the server chooses a different map.
    setTimeout(warmMapCache, 500);

    // Track hovered cell for building placement preview.
    canvas.addEventListener('mousemove', (e) => {
      if (state.gameState === 'PLAYING') {
        const { row, col } = renderer.screenToWorld(e.clientX, e.clientY);
        state.hoveredCell = { r: row, c: col };
      }
    });

    // Handle game input (clicks)
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    // A press on the map: right button cancels, left button orders/places.
    // Left presses are dispatched on mouse-up (see below) so a drag can pan the
    // camera without also firing an attack.
    const handleCanvasPress = (e) => {
      // Eliminated players watching the rest of the match can't issue orders.
      if (state.isSpectating) return;
      if (e.button === 2) { // Right click
        if (cancelBuildMode()) {
          // Right-click backs out of a placement / targeting mode.
        } else if (state.gameState === 'PLAYING') {
          const { row, col } = renderer.screenToWorld(e.clientX, e.clientY);
          if (row >= 0 && row < 1080 && col >= 0 && col < 1920) {
            const targetCell = row * 1920 + col;
            let targetOwner = getCellOwner(targetCell);
            if (targetOwner === parseInt(state.playerFaction)) {
              // Right-clicking own territory cancels neutral expansion (target 0)
              targetOwner = 0;
            }
            socket.emit('sim-input', { type: 'cancel_front', payload: { targetFaction: targetOwner } });
            playSfx('cancel');
          }
        }
        return;
      }

      if (state.gameState === 'SPAWN_SELECTION') {
        const { row, col } = renderer.screenToWorld(e.clientX, e.clientY);
        socket.emit('select-spawn', { row, col });
      } else if (state.gameState === 'PLAYING') {
        const { row, col } = renderer.screenToWorld(e.clientX, e.clientY);
        if (row >= 0 && row < 1080 && col >= 0 && col < 1920) {
          const targetCell = row * 1920 + col;
          if (handleBuildClick(targetCell)) { return; }
          socket.emit('sim-input', {
            type: 'expand',
            payload: { targetCell, attackPercentage: state.attackPercentage },
          });
          playSfx('order');
        }
      }
    };

    // Left-drag pans the camera; a press that never moves past the threshold is
    // a click. Spectators can still drag to look around.
    const DRAG_THRESHOLD_PX = 6;
    let press = null;
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) { handleCanvasPress(e); return; }
      if (e.button !== 0) return;
      press = {
        event: e, x: e.clientX, y: e.clientY,
        camX: renderer.camera.x, camY: renderer.camera.y, dragged: false,
      };
    });
    window.addEventListener('mousemove', (e) => {
      if (!press) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!press.dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      press.dragged = true;
      state.isPanning = true;
      // updateCamera() clamps to the map bounds on the next frame.
      renderer.camera.x = press.camX - dx / renderer.camera.zoom;
      renderer.camera.y = press.camY - dy / renderer.camera.zoom;
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', (e) => {
      if (!press || e.button !== 0) return;
      const done = press;
      press = null;
      state.isPanning = false;
      if (!done.dragged) handleCanvasPress(done.event);
    });
    window.addEventListener('blur', () => { press = null; state.isPanning = false; });

    // Space cancels every in-progress attack, recalling the troops to defense.
    // (Build / missile hotkeys live in buildBar.js.)
    window.addEventListener('keydown', (e) => {
      const inField = isTyping();
      if (state.isSpectating) return;

      if (e.code === 'Space' && state.gameState === 'PLAYING') {
        if (inField) return;
        e.preventDefault();
        socket.emit('sim-input', { type: 'cancel' });
        playSfx('cancel');
        return;
      }

    });

    initBuildBar({ emit: (input) => socket.emit('sim-input', input) });

    requestAnimationFrame(gameLoop);
  } catch (err) {
    console.error('Failed to init WASM simulation:', err);
    showErrorNotice('The game engine failed to start. Reload the page, or try another browser.', err.message);
  }
}

let lastFrameTime = 0;
let frameCount = 0;
let fps = 0;

function gameLoop(time) {
  if (state.debug) {
    frameCount++;
    if (time - lastFrameTime >= 1000) {
      fps = frameCount;
      frameCount = 0;
      lastFrameTime = time;
      const debugDiv = document.getElementById('debugUI');
      if (debugDiv) {
        debugDiv.innerHTML = `FPS: ${fps}<br>Apply: ${state.avgApplyMs.toFixed(1)} ms`;
      }
    }
  }

  // Only render if game area is active
  const gameArea = document.getElementById('gameArea');
  if (gameArea && gameArea.style.display !== 'none' && renderer) {
      renderer.render(time);
      
      const overlayCanvas = document.getElementById('overlayCanvas');
      const gameCanvas = document.getElementById('gameCanvas');
      
      if (state.isPanning) {
          if (gameCanvas) gameCanvas.style.cursor = 'grabbing';
      } else if (state.gameState === 'SPAWN_SELECTION' || state.activePurchaseMode) {
          if (gameCanvas) gameCanvas.style.cursor = 'crosshair';
      } else {
          if (gameCanvas) gameCanvas.style.cursor = 'default';
      }

      syncBuildBarActive();

      if (overlayCanvas) {
        if (overlayCanvas.width !== window.innerWidth || overlayCanvas.height !== window.innerHeight) {
          overlayCanvas.width = window.innerWidth;
          overlayCanvas.height = window.innerHeight;
        }
        const ctx = overlayCanvas.getContext('2d');
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

        if (state.gameState === 'SPAWN_SELECTION') {
          // The server shrinks safe zones in big rooms (spawn-selection-start).
          renderer.drawSpawnOverlay(ctx, state.spawnSelections, parseInt(state.playerFaction), state.safeZoneRadius);
        } else if (state.gameState === 'PLAYING') {
          // Name + total troops drawn at each faction's territory centroid.
          renderer.drawFactionLabels(ctx, state.factionCentroids, state.activePlayerSlots, parseInt(state.playerFaction));
          // Building icons, then synergy links on top (tower auras are opaque
          // enough to hide anything drawn underneath them).
          renderer.drawBuildings(ctx, state.buildings);
          renderer.drawBuildingLinks(ctx, state.buildings);
          // Active missiles flying through the air
          state.activeMissiles = renderer.drawMissiles(ctx, state.activeMissiles, state.activeExplosions);
          // Active missile blasts (expanding flash), pruned when finished.
          state.activeExplosions = renderer.drawExplosions(ctx, state.activeExplosions);
          // Active AA interceptor missiles
          state.activeInterceptors = renderer.drawInterceptors(ctx, state.activeInterceptors);
          drawBuildPreview(renderer, ctx);
        }
      }
  }
  requestAnimationFrame(gameLoop);
}

// Start the engine only on desktop (mobile shows the rejection banner instead)
if (!_isMobile) { startSimulationEngine(); }
