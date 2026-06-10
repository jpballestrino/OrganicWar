import './js/initDOM.js';
import { socket, initNetwork, quitAndReload } from './js/network.js';
import { initAuthUI } from './js/authUI.js';
import { initGuildUI } from './js/guildUI.js';
import { initRankingsUI } from './js/rankingsUI.js';
import { state } from './js/state.js';

// Global Error Handler
window.addEventListener('error', function(e) {
  const errDiv = document.createElement('div');
  errDiv.style.position = 'absolute';
  errDiv.style.top = '10px';
  errDiv.style.left = '10px';
  errDiv.style.color = 'red';
  errDiv.style.backgroundColor = 'black';
  errDiv.style.zIndex = '999999';
  errDiv.style.padding = '10px';
  errDiv.innerHTML = `Global Error: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}<br>${e.error ? e.error.stack : ''}`;
  document.body.appendChild(errDiv);
});

// Home Background Cellular Automata Animation
(function initHomeBgCanvas() {
  const canvas = document.getElementById('homeBgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const CELL = 6;
  let cols, rows, grid, factions, animId;

  const FACTION_COLORS = [
    null,
    'rgba(220, 60, 60, 0.7)',   'rgba(60, 140, 220, 0.7)',
    'rgba(60, 200, 80, 0.7)',    'rgba(220, 180, 40, 0.7)',
    'rgba(180, 60, 220, 0.7)',   'rgba(220, 120, 40, 0.7)',
    'rgba(40, 200, 200, 0.7)',   'rgba(220, 80, 160, 0.7)',
  ];
  const NUM_FACTIONS = FACTION_COLORS.length - 1;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    cols = Math.ceil(canvas.width / CELL);
    rows = Math.ceil(canvas.height / CELL);
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const fid = grid[r * cols + c];
        if (fid > 0) {
          ctx.fillStyle = FACTION_COLORS[fid];
          ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
        }
      }
    }
  }

  let lastStep = 0;
  function animate(ts) {
    const homeScreen = document.getElementById('homeScreen');
    if (!homeScreen || homeScreen.style.display === 'none') {
      canvas.style.display = 'none';
      return;
    }
    canvas.style.display = 'block';
    if (ts - lastStep > 50) {
      step();
      lastStep = ts;
    }
    draw();
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
  if (nickInput && !nickInput.value) {
    nickInput.value = androidNames[Math.floor(Math.random() * androidNames.length)];
  }

  const btnMultiplayer = document.getElementById('btn-multiplayer');
  if (btnMultiplayer) {
    btnMultiplayer.onclick = () => {
      if (homeScreen) homeScreen.style.display = 'none';
      if (lobbyBrowser) lobbyBrowser.style.display = 'flex';
      socket.emit('request-rooms');
    };
  }

  const btnMultiplayerGuest = document.getElementById('btn-multiplayer-guest');
  if (btnMultiplayerGuest) {
    btnMultiplayerGuest.onclick = () => {
      if (homeScreen) homeScreen.style.display = 'none';
      if (lobbyBrowser) lobbyBrowser.style.display = 'flex';
      socket.emit('request-rooms');
    };
  }

  const handleQuickPlay = () => {
    let name = nickInput ? nickInput.value : 'Guest';
    state.playerNickname = name;
    if (homeScreen) homeScreen.style.display = 'none';
    socket.emit('quick-play', { nickname: state.playerNickname });
  };

  const btnQuickPlay = document.getElementById('btn-quick-play');
  if (btnQuickPlay) btnQuickPlay.onclick = handleQuickPlay;

  const btnQuickPlayGuest = document.getElementById('btn-quick-play-guest');
  if (btnQuickPlayGuest) btnQuickPlayGuest.onclick = handleQuickPlay;

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
  };

  const btnRankedPlay = document.getElementById('btn-ranked-play');
  if (btnRankedPlay) {
    btnRankedPlay.onclick = () => {
      const loggedInView = document.getElementById('homeStateLoggedIn');
      const queueView = document.getElementById('homeStateRankedQueue');
      if (loggedInView) loggedInView.style.display = 'none';
      if (queueView) queueView.style.display = 'flex';
      
      socket.emit('join-ranked-queue');
      startRankedTimer();
    };
  }

  const btnLeaveRanked = document.getElementById('btn-leave-ranked');
  if (btnLeaveRanked) {
    btnLeaveRanked.onclick = () => {
      const loggedInView = document.getElementById('homeStateLoggedIn');
      const queueView = document.getElementById('homeStateRankedQueue');
      if (queueView) queueView.style.display = 'none';
      if (loggedInView) loggedInView.style.display = 'block';
      
      socket.emit('leave-ranked-queue');
      stopRankedTimer();
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

  const btnExitMatch = document.getElementById('btnExitMatch');
  if (btnExitMatch) {
    btnExitMatch.onclick = () => {
      quitAndReload();
    };
  }
}

// Bootstrapping
initNetwork();
initAuthUI();
initGuildUI();
initRankingsUI();
initLobbyUI();
initDevSandboxUI();
