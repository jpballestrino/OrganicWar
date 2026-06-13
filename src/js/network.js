import { io } from 'socket.io-client';
import { state } from './state.js';
import { showToast } from './guildUI.js';
import { getToken } from './auth.js';
import { applyOwnerSnapshot } from './simBridge.js';
import { escapeHtml } from './escape.js';

export const socket = io({
  auth: { token: getToken() },
});

export function quitAndReload() {
  sessionStorage.removeItem('reconnectToken');
  socket.emit('quit-game');
  location.reload();
}

const factionHexColors = {
  1: '#5499C7', 2: '#CD6155', 3: '#F0B27A', 4: '#AF7AC5', 5: '#48C9B0',
  6: '#F4D03F', 7: '#85929E', 8: '#F1948A', 9: '#76D7C4', 10: '#85C1E9',
  11: '#EC7063', 12: '#BB8FCE', 13: '#F5B7B1', 14: '#E59866', 15: '#A3E4D7',
  16: '#F7DC6F', 17: '#ABEBC6', 18: '#CCD1D1', 19: '#EB984E', 20: '#A9CCE3',
};

export function updateSlotsUI(slots) {
  const grid = document.getElementById('slotsGrid');
  if (!grid) return;
  grid.innerHTML = '';

  for (let fid in slots) {
    let slot = slots[fid];
    let card = document.createElement('div');
    card.className = `slot-card ${slot ? 'taken' : ''} ${state.selectedSlot == fid ? 'active' : ''}`;
    card.style.borderLeft = `5px solid ${factionHexColors[fid] || '#fff'}`;
        
    let statusText = slot ? `Occupied by ${escapeHtml(slot.nickname)}` : 'Available (Bot Control)';
    let fName = `Faction ${fid}`;
        
    card.innerHTML = `
            <span>
                <span class="faction-dot" style="background-color: ${factionHexColors[fid] || '#fff'};"></span>
                ${fName}
            </span>
            <span style="font-size: 11px; opacity: 0.8;">${statusText}</span>
        `;
        
    if (!slot) {
      card.onclick = () => {
        state.selectedSlot = fid;
        document.querySelectorAll('.slot-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        socket.emit('join-faction', { factionId: fid, nickname: state.playerNickname, doctrine: state.selectedDoctrine });
      };
    }
    grid.appendChild(card);
  }
}

export function updateDevDashboard() {
  const devRoomId = document.getElementById('devRoomId');
  if (devRoomId) {
    devRoomId.textContent = state.roomId || 'No Active Room';
  }
  const devMatchType = document.getElementById('devMatchType');
  if (devMatchType) {
    let typeText = 'Custom Game';
    if (state.isQuickPlay) typeText = 'Quick Game';
    if (state.isRankedMatch) typeText = 'Ranked Match';
    if (state.isGuildWar) typeText = 'Guild War';
    devMatchType.textContent = typeText;
  }
  const devPlayerSlot = document.getElementById('devPlayerSlot');
  if (devPlayerSlot) {
    devPlayerSlot.textContent = state.playerFaction ? `Faction ${state.playerFaction} (${state.playerNickname})` : 'Spectating';
  }
  const devPlayersList = document.getElementById('devPlayersList');
  if (devPlayersList) {
    let listHTML = '';
    for (let fid in state.activePlayerSlots) {
      let slot = state.activePlayerSlots[fid];
      if (slot) {
        let name = escapeHtml(slot.nickname);
        if (slot.guildTag) name = `[${escapeHtml(slot.guildTag)}] ${name}`;
        listHTML += `
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
            <span class="faction-dot" style="background-color: ${factionHexColors[fid] || '#fff'}; width: 10px; height: 10px; border-radius: 50%; display: inline-block;"></span>
            <span style="font-weight: bold; color: ${factionHexColors[fid]};">Faction ${fid}:</span>
            <span style="color: #fff;">${name}</span>
          </div>
        `;
      }
    }
    devPlayersList.innerHTML = listHTML || '<div style="color:#888;">No human players</div>';
  }
}

export function triggerEndGame(status) {
  state.gameState = 'END_GAME';
    
  const container = document.getElementById('gameArea') || document.body;
  const oldOverlay = document.getElementById('endGameOverlay');
  if (oldOverlay) {oldOverlay.remove();}

  const overlay = document.createElement('div'); 
  overlay.className = 'game-overlay';
  overlay.id = 'endGameOverlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.background = 'rgba(10,10,10,0.9)';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '10000';
  overlay.style.pointerEvents = 'auto';

  const title = document.createElement('div');
  title.style.fontSize = '3rem';
  title.style.fontWeight = 'bold';
  title.style.marginBottom = '20px';
  title.style.color = status === 'VICTORY' ? '#4ade80' : '#f87171';
  title.innerText = status === 'VICTORY' ? '🏆 Victory!' : '💀 Defeat';
  overlay.appendChild(title);

  const desc = document.createElement('div');
  desc.style.color = '#ccc';
  desc.style.marginBottom = '30px';
  desc.style.fontSize = '1.2rem';
  desc.innerText = status === 'VICTORY' ? 'Congratulations, Commander! You won.' : 'Better luck next time, Commander.';
  overlay.appendChild(desc);

  const btnContainer = document.createElement('div');
  btnContainer.style.display = 'flex';
  btnContainer.style.gap = '15px';

  const restartBtn = document.createElement('button');
  restartBtn.className = 'home-btn';
  restartBtn.style.padding = '12px 24px';
  restartBtn.style.background = '#28a745';
  restartBtn.innerText = 'Exit to Title Screen';
  restartBtn.onclick = () => quitAndReload();
  btnContainer.appendChild(restartBtn);

  overlay.appendChild(btnContainer);
  container.appendChild(overlay);
}

export function initNetwork() {
  const savedToken = sessionStorage.getItem('reconnectToken');
  if (savedToken) {
    console.log('[RECONNECT] Sending token:', savedToken);
    socket.emit('reconnect-to-game', { token: savedToken });
  }

  socket.on('reconnect-success', ({ factionId, nickname, isQuickPlay }) => {
    state.playerFaction = factionId;
    state.playerNickname = nickname;
    state.gameState = 'PLAYING';
    
    document.getElementById('homeScreen').style.display = 'none';
    const bgCanvas2 = document.getElementById('homeBgCanvas');
    if (bgCanvas2) bgCanvas2.style.display = 'none';
    const waitingOverlay = document.getElementById('waitingOverlay');
    if (waitingOverlay) waitingOverlay.style.display = 'none';
    const spawnOverlay = document.getElementById('spawnOverlay');
    if (spawnOverlay) spawnOverlay.style.display = 'none';
    
    const gameArea = document.getElementById('gameArea');
    if (gameArea) gameArea.style.display = 'flex';
    
    updateDevDashboard();
  });

  socket.on('reconnect-failed', () => {
    sessionStorage.removeItem('reconnectToken');
    state.gameState = 'SETUP';
    document.getElementById('homeScreen').style.display = 'flex';
  });

  socket.on('player-count-update', (count) => {
    const el = document.getElementById('homePlayersOnline');
    if (el) {
      el.innerText = `Players Online: ${count}`;
    }
  });

  socket.on('init-config', (config) => {
    state.activePlayerSlots = config.activePlayerSlots;
    state.currentPreset = config.currentPreset;
    state.isQuickPlay = config.isQuickPlay || false;
    state.isRankedMatch = config.isRankedMatch || false;
    state.isGuildWar = config.isGuildWar || false;
    state.guildA = config.guildA || null;
    state.guildB = config.guildB || null;
    state.teamSize = config.teamSize || 0;
    
    updateSlotsUI(state.activePlayerSlots);
    
    const waitingOverlay = document.getElementById('waitingOverlay');
    if (waitingOverlay) {
      waitingOverlay.style.display = 'flex';
      const title = document.getElementById('waitingTitle');
      if (state.isGuildWar) {
        title.innerHTML = `GUILD WAR: <span style="color:#ffc107">[${escapeHtml(state.guildA.tag)}]</span> vs <span style="color:#ff6b6b">[${escapeHtml(state.guildB.tag)}]</span>`;
      } else if (config.isQuickPlay) {
        title.innerText = 'Quick Game Matchmaking';
      } else {
        title.innerText = 'Custom Game Lobby';
      }
      
      const btnForceStart = document.getElementById('btn-force-start');
      if (btnForceStart) {
        btnForceStart.style.display = config.isHost ? 'block' : 'none';
      }
    }
  });

  socket.on('slots-update', (slots) => {
    state.activePlayerSlots = slots;
    updateSlotsUI(slots);
    updateDevDashboard();
  });

  socket.on('ranked-queue-update', (data) => {
    const lblPlayers = document.getElementById('lblRankedPlayers');
    if (lblPlayers) {
      lblPlayers.innerText = `Players: ${data.count}/${data.required}`;
    }
  });

  socket.on('ranked-match-found', (data) => {
    const queueView = document.getElementById('homeStateRankedQueue');
    if (queueView) queueView.style.display = 'none';
  });

  socket.on('join-success', ({ factionId, nickname, isQuickPlay, reconnectToken, isRankedMatch }) => {
    if (reconnectToken) {
      sessionStorage.setItem('reconnectToken', reconnectToken);
    }
    state.playerFaction = factionId;
    state.playerNickname = nickname;
    
    const homeScreen = document.getElementById('homeScreen');
    if (homeScreen) homeScreen.style.opacity = '0';
    
    state.gameState = 'LOBBY_WAIT';
    
    setTimeout(() => {
      if (homeScreen) homeScreen.style.display = 'none';
      const bgCanvas = document.getElementById('homeBgCanvas');
      if (bgCanvas) bgCanvas.style.display = 'none';
    }, 300);
  });

  socket.on('start-match-now', (data) => {
    state.gameState = 'PLAYING';
    
    const waitingOverlay = document.getElementById('waitingOverlay');
    if (waitingOverlay) waitingOverlay.style.display = 'none';
    const spawnOverlay = document.getElementById('spawnOverlay');
    if (spawnOverlay) spawnOverlay.style.display = 'none';
    
    const gameArea = document.getElementById('gameArea');
    if (gameArea) gameArea.style.display = 'flex';
    
    updateDevDashboard();
  });

  socket.on('spawn-selection-start', (data) => {
    state.gameState = 'SPAWN_SELECTION';
    
    const gameArea = document.getElementById('gameArea');
    if (gameArea) gameArea.style.display = 'flex';
    
    const waitingOverlay = document.getElementById('waitingOverlay');
    if (waitingOverlay) waitingOverlay.style.display = 'none';
    
    const spawnOverlay = document.getElementById('spawnOverlay');
    if (spawnOverlay) {
      spawnOverlay.style.display = 'flex';
    }
  });

  socket.on('spawn-selections-update', (selections) => {
    state.spawnSelections = selections;
  });

  socket.on('spawn-rejected', (reason) => {
    showToast(reason, 'error');
  });

  socket.on('spawns-finalized', (data) => {
    state.gameState = 'PLAYING';
    const spawnOverlay = document.getElementById('spawnOverlay');
    if (spawnOverlay) spawnOverlay.style.display = 'none';
    
    if (data.centroids) {
      state.factionCentroids = data.centroids;
    }
    if (data.slots) {
      state.activePlayerSlots = data.slots;
      updateSlotsUI(data.slots);
      updateDevDashboard();
    }
  });

  socket.on('custom-game-starting', () => {
    // Just informative, keep waiting overlay open
  });

  socket.on('notification', ({ message, type }) => {
    showToast(message, type);
  });

  socket.on('game-over', ({ winner }) => {
    const isWin = winner === state.playerFaction;
    triggerEndGame(isWin ? 'VICTORY' : 'DEFEAT');
  });

  socket.on('rooms-list-update', (list) => {
    const container = document.getElementById('roomsList');
    if (!container) return;
    
    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML = '<div style="color: #888; text-align: center; padding: 10px; font-style: italic;">No open games found. Create one!</div>';
      return;
    }
    
    list.forEach(room => {
      let card = document.createElement('div');
      card.style.background = 'rgba(255,255,255,0.05)';
      card.style.border = '1px solid rgba(255,255,255,0.1)';
      card.style.padding = '10px';
      card.style.borderRadius = '4px';
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'center';

      let infoDiv = document.createElement('div');
      let nameDiv = document.createElement('div');
      nameDiv.style.fontWeight = 'bold';
      nameDiv.style.color = '#fff';
      nameDiv.textContent = room.name;
      let detailDiv = document.createElement('div');
      detailDiv.style.fontSize = '11px';
      detailDiv.style.color = '#aaa';
      detailDiv.textContent = `Map: ${room.preset} | Players: ${room.currentPlayers}/${room.maxPlayers}`;
      infoDiv.appendChild(nameDiv);
      infoDiv.appendChild(detailDiv);

      let btn = document.createElement('button');
      btn.className = 'home-btn';
      btn.style.cssText = 'padding: 6px 12px; background-color: #007bff; font-size: 12px; border: none; border-radius: 4px; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; width: auto;';
      btn.textContent = 'Join';
      btn.onclick = () => {
        document.getElementById('lobbyBrowserOverlay').style.display = 'none';
        socket.emit('join-room', { roomId: room.id });
      };

      card.appendChild(infoDiv);
      card.appendChild(btn);
      container.appendChild(card);
    });
  });

  socket.on('sim-snapshot', ({ ownerDelta }) => {
    if (!ownerDelta) return;
    applyOwnerSnapshot(ownerDelta);
  });

  socket.on('waiting-tick', (ticks) => {
    const text = document.getElementById('waitingCountdownText');
    if (text) {
      text.style.display = 'block';
      text.innerText = ticks + 's';
    }
  });

  socket.on('spawn-timer', (ticks) => {
    state.spawnTimeLeft = ticks;
    const spawnText = document.getElementById('spawnTimerText');
    if (spawnText) {
      spawnText.innerText = ticks;
    }
  });
}
