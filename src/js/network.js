import { io } from 'socket.io-client';
import { state } from './state.js';
import { showToast, toggleInGameIndicator } from './guildUI.js';
import { getToken } from './auth.js';
import { applyOwnerSnapshot, applyDefenseBuilding, removeDefenseBuilding, resyncBuildingZones, repaintTerrain } from './simBridge.js';
import { escapeHtml } from './escape.js';
import { troopGrowthPerSec, GROWTH_PEAK_RATIO, POP_CAP_PER_CELL, BUILDING_RADIUS, GOLD_PER_CELL_PER_SEC, DEFENSE_BUILDING_COST, DEFENSE_BUILD_MS, SILO_BUILDING_COST, SILO_RANGE, MISSILE_COST, MINE_BUILDING_COST, ANTIAIR_BUILDING_COST } from './constants.js';

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

// Push an elimination into the kill feed (top-left). Newest on top, capped, each
// entry auto-fades after a few seconds. Called from the `player-eliminated` event.
function addKillFeedEntry(factionId) {
  const feed = document.getElementById('killFeed');
  if (!feed) return;
  const slot = state.activePlayerSlots ? state.activePlayerSlots[factionId] : null;
  const name = slot && slot.nickname ? slot.nickname : `Player ${factionId}`;
  const color = factionHexColors[factionId] || '#ffffff';

  const entry = document.createElement('div');
  entry.className = 'kill-feed-entry';
  entry.innerHTML =
    `<span class="kill-feed-skull">☠</span>` +
    `<span class="kill-feed-name" style="color:${color}">${escapeHtml(name)}</span>` +
    `<span>eliminated</span>`;
  feed.prepend(entry);

  // Cap the visible feed length.
  while (feed.children.length > 6) { feed.removeChild(feed.lastChild); }

  // Auto-fade and remove.
  setTimeout(() => {
    entry.classList.add('fade-out');
    setTimeout(() => entry.remove(), 500);
  }, 6000);
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

// ── Reconnection overlay helpers ─────────────────────────────────────────────
function showReconnecting(attempt = 0) {
  const el = document.getElementById('reconnectingOverlay');
  if (!el) return;
  el.style.display = 'flex';
  const txt = document.getElementById('reconnectAttemptText');
  if (txt) txt.innerText = attempt > 0 ? `Attempt ${attempt}…` : 'Attempting to restore your session';
}

function hideReconnecting() {
  const el = document.getElementById('reconnectingOverlay');
  if (el) el.style.display = 'none';
}

function showServerError(title = 'Connection Lost', msg = 'Unable to reach the game server. Your progress has been saved.') {
  hideReconnecting();
  const overlay = document.getElementById('serverErrorOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const t = document.getElementById('serverErrorTitle');
  if (t) t.innerText = title;
  const m = document.getElementById('serverErrorMsg');
  if (m) m.innerText = msg;
  const btn = document.getElementById('btnServerErrorReturn');
  if (btn) btn.onclick = () => quitAndReload();
}

// Transport-level reconnection events (Socket.IO engine layer)
socket.on('disconnect', (reason) => {
  // Only show overlay if the player is mid-game, not if they intentionally quit
  if (state.gameState === 'PLAYING' && reason !== 'io client disconnect') {
    showReconnecting();
  }
});

socket.io.on('reconnect', () => {
  hideReconnecting();
  // Re-send the game reconnect token so the server reclaims the faction slot
  const savedToken = sessionStorage.getItem('reconnectToken');
  if (savedToken && state.gameState === 'PLAYING') {
    socket.emit('reconnect-to-game', { token: savedToken });
  }
});

socket.io.on('reconnect_attempt', (attempt) => {
  showReconnecting(attempt);
});

socket.io.on('reconnect_failed', () => {
  showServerError('Server Unreachable', 'Could not reconnect after multiple attempts. Please return to the menu and try again.');
});

export function initNetwork() {
  const savedToken = sessionStorage.getItem('reconnectToken');
  if (savedToken) {
    console.log('[RECONNECT] Sending token:', savedToken);
    socket.emit('reconnect-to-game', { token: savedToken });
  }

  socket.on('reconnect-success', ({ factionId, nickname }) => {
    state.playerFaction = factionId;
    state.playerNickname = nickname;
    state.gameState = 'PLAYING';
    hideReconnecting();

    document.getElementById('homeScreen').style.display = 'none';
    const bgCanvas2 = document.getElementById('homeBgCanvas');
    if (bgCanvas2) bgCanvas2.style.display = 'none';
    const waitingOverlay = document.getElementById('waitingOverlay');
    if (waitingOverlay) waitingOverlay.style.display = 'none';
    const spawnOverlay = document.getElementById('spawnOverlay');
    if (spawnOverlay) spawnOverlay.style.display = 'none';

    // Paint the room's map before revealing the canvas, so a reconnecting player
    // doesn't flash the default map. (init-config, sent on reconnect, sets this.)
    if (state.currentPreset) repaintTerrain(state.currentPreset);

    const gameArea = document.getElementById('gameArea');
    if (gameArea) gameArea.style.display = 'flex';

    updateDevDashboard();
  });

  socket.on('reconnect-failed', () => {
    sessionStorage.removeItem('reconnectToken');
    state.gameState = 'SETUP';
    hideReconnecting();
    document.getElementById('homeScreen').style.display = 'flex';
  });

  // Simulation crash — room was terminated server-side (Tier 1 onError callback)
  socket.on('server-error', ({ message } = {}) => {
    sessionStorage.removeItem('reconnectToken');
    state.gameState = 'SETUP';
    showServerError('Game Error', message || 'The game server encountered an error. Please return to the menu.');
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
    // Repaint terrain to the room's map (covers the reconnect path, where the
    // client may have painted the default map at startup). Safe pre-match: only
    // terrain bits change and owner bits are still all-neutral.
    if (config.currentPreset) repaintTerrain(config.currentPreset);
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

  socket.on('ranked-match-found', () => {
    const queueView = document.getElementById('homeStateRankedQueue');
    if (queueView) queueView.style.display = 'none';
  });

  socket.on('join-success', ({ factionId, nickname, reconnectToken }) => {
    if (reconnectToken) {
      sessionStorage.setItem('reconnectToken', reconnectToken);
    }
    state.playerFaction = factionId;
    state.playerNickname = nickname;
    
    toggleInGameIndicator(true);
    
    const homeScreen = document.getElementById('homeScreen');
    if (homeScreen) homeScreen.style.opacity = '0';
    
    state.gameState = 'LOBBY_WAIT';
    
    setTimeout(() => {
      if (homeScreen) homeScreen.style.display = 'none';
      const bgCanvas = document.getElementById('homeBgCanvas');
      if (bgCanvas) bgCanvas.style.display = 'none';
    }, 300);
  });

  socket.on('start-match-now', () => {
    state.gameState = 'PLAYING';
    
    if (window.renderer && state.spawnSelections && state.spawnSelections[state.playerFaction]) {
      const spawn = state.spawnSelections[state.playerFaction];
      const targetZoom = 2.5;
      window.renderer.camera.zoom = targetZoom;
      const viewW = window.renderer.canvas.width / targetZoom;
      const viewH = window.renderer.canvas.height / targetZoom;
      window.renderer.camera.x = spawn.col - (viewW / 2);
      window.renderer.camera.y = spawn.row - (viewH / 2);
    }
    
    const gameHUD = document.getElementById('gameHUD');
    if (gameHUD) gameHUD.style.display = 'flex';
    const gameLeaderboard = document.getElementById('gameLeaderboard');
    if (gameLeaderboard) gameLeaderboard.style.display = 'block';
    const economyHUD = document.getElementById('gameEconomyHUD');
    if (economyHUD) economyHUD.style.display = 'flex';
    const killFeed = document.getElementById('killFeed');
    if (killFeed) { killFeed.innerHTML = ''; killFeed.style.display = 'flex'; }

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

    // Repaint the local terrain to the room's map before the spawn canvas shows,
    // so players pick spawns on the correct landmass. Falls back to the preset
    // received in init-config.
    const mapId = (data && data.mapId) || state.currentPreset;
    if (mapId) repaintTerrain(mapId);

    const gameArea = document.getElementById('gameArea');
    if (gameArea) gameArea.style.display = 'flex';
    
    const waitingOverlay = document.getElementById('waitingOverlay');
    if (waitingOverlay) waitingOverlay.style.display = 'none';
    
    const spawnOverlay = document.getElementById('spawnOverlay');
    if (spawnOverlay) {
      spawnOverlay.style.display = 'flex';
    }
    // Seed the countdown with the server's real duration so it doesn't flash a
    // stale placeholder before the first spawn-timer tick arrives.
    const duration = data && typeof data.duration === 'number' ? data.duration : null;
    if (duration !== null) {
      state.spawnTimeLeft = duration;
      const spawnText = document.getElementById('spawnTimerText');
      if (spawnText) spawnText.innerText = duration;
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

  socket.on('player-eliminated', ({ factionId }) => {
    addKillFeedEntry(factionId);
    state.eliminatedFactions.add(factionId);
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

  socket.on('sim-snapshot', ({ ownerDelta, playerTroops, playerMaxPop, playerAttack, playerGold, playerKills, playerGoldSpent, centroids }) => {
    let t0 = 0;
    if (state.debug) t0 = performance.now();

    if (ownerDelta) {
      applyOwnerSnapshot(ownerDelta);
      // Owner bits just changed; re-derive fort zones so newly-conquered cells
      // inside a building radius gain (and cells lost out of it drop) tier 10.
      resyncBuildingZones(state.buildings);
    }

    if (state.debug && ownerDelta) {
      const t1 = performance.now();
      state.lastApplyMs = t1 - t0;
      if (state.avgApplyMs === 0) state.avgApplyMs = state.lastApplyMs;
      else state.avgApplyMs = state.avgApplyMs * 0.9 + state.lastApplyMs * 0.1;
    }

    // Per-faction territory centroids + troops, for the in-territory labels.
    if (centroids) { state.factionCentroids = centroids; }

    if (playerTroops && playerMaxPop) {
      const troopsArray = new Float32Array(playerTroops);
      const maxPopArray = new Uint32Array(playerMaxPop);


      // Per-faction troop density ratio sent to the shader as u_player_opacity.
      // The shader multiplies this by the per-cell enclosure ratio (0=border,
      // 1=interior) to produce per-cell opacity: dense interiors solid, new borders
      // faint. A 0.12 opacity floor is applied in GLSL so owned cells stay visible.
      const opacity = state.factionOpacity || (state.factionOpacity = new Float32Array(21));
      for (let i = 1; i <= 20; i++) {
        const mp = maxPopArray[i];
        if (mp > 0) {
          const ownedCells = mp / POP_CAP_PER_CELL;
          const density = ownedCells > 0 ? troopsArray[i] / ownedCells : 0;
          opacity[i] = Math.min(density / 25, 1.0);
        } else {
          opacity[i] = 0;
        }
      }
    }

    if (playerTroops && playerMaxPop && state.playerFaction) {
      const troopsArray = new Float32Array(playerTroops);
      const maxPopArray = new Uint32Array(playerMaxPop);
      const attackArray = playerAttack ? new Float32Array(playerAttack) : null;

      const fid = parseInt(state.playerFaction);
      if (fid >= 1 && fid <= 20) {
        const troops = troopsArray[fid];   // home reserve
        const maxPop = maxPopArray[fid];
        state.playerMaxPop = maxPop;

        // Troops currently committed to an active expansion (attack pool).
        const attacking = attackArray ? Math.floor(attackArray[fid]) : 0;
        const lblAttacking = document.getElementById('lblMyAttacking');
        if (lblAttacking) {
          lblAttacking.innerText = attacking;
          lblAttacking.style.color = attacking > 0 ? '#ff9800' : '#aaa';
        }

        // Total troops = home reserve + deployed on fronts (both share the cap).
        const totalTroops = Math.floor(troops) + attacking;
        state.playerTroops = totalTroops;

        const lblTroops = document.getElementById('lblMyTroops');
        const lblMax = document.getElementById('lblMyMaxPop');
        if (lblTroops) lblTroops.innerText = totalTroops;
        if (lblMax) lblMax.innerText = maxPop;

        // Fill and growth both use the total pool so they match the Rust formula.
        const fill = maxPop > 0 ? totalTroops / maxPop : 0;
        const lblFill = document.getElementById('lblMyFill');
        if (lblFill) lblFill.innerText = `${Math.round(fill * 100)}%`;

        // Growth rate (troops/sec): green while still accelerating (below the
        // peak fill), red once past the peak and slowing toward the cap.
        const growth = troopGrowthPerSec(totalTroops, maxPop);
        const lblGrowth = document.getElementById('lblMyGrowth');
        if (lblGrowth) {
          lblGrowth.innerText = `+${Math.round(growth)}/s`;
          lblGrowth.style.color = fill < GROWTH_PEAK_RATIO ? '#28a745' : '#dc3545';
        }

        // Territory (cells) — cap scales as cells * POP_CAP_PER_CELL.
        const cells = Math.round(maxPop / POP_CAP_PER_CELL);
        const lblCells = document.getElementById('lblMyCells');
        if (lblCells) lblCells.innerText = cells;

        // Player Kills
        const killArray = playerKills ? new Float32Array(playerKills) : null;
        const kills = killArray ? Math.floor(killArray[fid]) : 0;
        state.playerKills = kills;
        const lblKills = document.getElementById('lblMyKills');
        if (lblKills) lblKills.innerText = window.formatAbbreviation ? window.formatAbbreviation(kills) : kills;

        // Leaderboard state
        if (!state.leaderboardData) state.leaderboardData = [];
        state.leaderboardData.length = 0; // Clear
        const goldSpentArray = playerGoldSpent ? new Float32Array(playerGoldSpent) : null;
        
        for (let i = 1; i <= 20; i++) {
          const t = Math.floor(troopsArray[i]);
          const c = Math.round(maxPopArray[i] / POP_CAP_PER_CELL);
          const k = killArray ? Math.floor(killArray[i]) : 0;
          const gs = goldSpentArray ? Math.floor(goldSpentArray[i]) : 0;
          
          const isEliminated = state.eliminatedFactions.has(i);
          
          if (c > 0 || t > 0 || isEliminated) {
            const score = gs + k + t + c;
            state.leaderboardData.push({ fid: i, score, isEliminated });
          }
        }
        // Descending sort
        state.leaderboardData.sort((a, b) => b.score - a.score);
        
        // Render leaderboard (throttled to roughly 2 times a second)
        const now = performance.now();
        if (!state.lastLeaderboardRender || now - state.lastLeaderboardRender > 500) {
          state.lastLeaderboardRender = now;
          const lbList = document.getElementById('leaderboardList');
          if (lbList) {
            lbList.innerHTML = state.leaderboardData.map((lb, index) => {
              const fColor = factionHexColors[lb.fid] || '#fff';
              const isMe = lb.fid === fid;
              const slot = state.activePlayerSlots ? state.activePlayerSlots[lb.fid] : null;
              const name = isMe ? 'You' : (slot && slot.nickname ? slot.nickname : `Player ${lb.fid}`);
              const fmtScore = window.formatAbbreviation ? window.formatAbbreviation(lb.score) : lb.score;
              const nameStyle = lb.isEliminated ? 'text-decoration: line-through; opacity: 0.5;' : '';
              return `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 4px; background: ${lb.fid === fid ? 'rgba(255,255,255,0.1)' : 'transparent'}; border-radius: 4px;">
                  <div style="display: flex; align-items: center; gap: 6px; overflow: hidden;">
                    <span style="font-size: 10px; color: #888; width: 12px; text-align: right;">${index + 1}.</span>
                    <div style="width: 10px; height: 10px; border-radius: 50%; background-color: ${fColor}; border: 1px solid #000;"></div>
                    <span style="font-size: 12px; color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100px; ${nameStyle}">${name}</span>
                  </div>
                  <span style="font-size: 13px; font-weight: bold; color: ${lb.isEliminated ? '#888' : '#ffc107'};">${fmtScore}</span>
                </div>
              `;
            }).join('');
          }
        }

        // --- Economy / building HUD (bottom bar) ---
        // Gold accumulated, and income rate (scales with territory owned).
        const goldArray = playerGold ? new Float32Array(playerGold) : null;
        const gold = goldArray ? Math.floor(goldArray[fid]) : 0;
        state.playerGold = gold;
        const lblGold = document.getElementById('lblMyGold');
        if (lblGold) lblGold.innerText = gold.toLocaleString();

        // Count of this player's own placed buildings.
        const myBuildings = state.buildings.filter(b => b.factionId === fid);

        const mineCount = myBuildings.filter(b => b.type === 'mine' && !b.constructing).length;
        const goldRate = Math.round(cells * GOLD_PER_CELL_PER_SEC * (1 + mineCount * 0.10));
        const lblGoldRate = document.getElementById('lblMyGoldRate');
        if (lblGoldRate) lblGoldRate.innerText = mineCount > 0 ? `+${goldRate}/s ×${(1 + mineCount * 0.10).toFixed(1)}` : `+${goldRate}/s`;
        
        const lblTowers = document.getElementById('lblMyTowers');
        if (lblTowers) {
          lblTowers.innerText = myBuildings.filter(b => b.type === 'defense').length;
        }

        const siloCount = myBuildings.filter(b => b.type === 'silo').length;
        const lblSilos = document.getElementById('lblMySilos');
        if (lblSilos) {
          lblSilos.innerText = siloCount;
        }

        // Toggle disabled states on HUD build buttons
        const btnTower = document.getElementById('btnBuildTower');
        if (btnTower) btnTower.classList.toggle('disabled', gold < DEFENSE_BUILDING_COST);

        const btnSilo = document.getElementById('btnBuildSilo');
        if (btnSilo) btnSilo.classList.toggle('disabled', gold < SILO_BUILDING_COST);

        const btnMissile = document.getElementById('btnFireMissile');
        if (btnMissile) btnMissile.classList.toggle('disabled', gold < MISSILE_COST || siloCount === 0);

        const btnMine = document.getElementById('btnBuildMine');
        if (btnMine) btnMine.classList.toggle('disabled', gold < MINE_BUILDING_COST);

        const btnAntiAir = document.getElementById('btnBuildAntiAir');
        if (btnAntiAir) btnAntiAir.classList.toggle('disabled', gold < ANTIAIR_BUILDING_COST);
      }
    }
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

  socket.on('building-placed', (data) => {
    // Placement just starts a timer — the tower grants no bonus yet. Mark it
    // under construction and record the start time for the fill bar; do NOT stamp
    // the defense tier until `building-completed` arrives.
    data.constructing = true;
    data.buildMs = data.buildMs ?? DEFENSE_BUILD_MS;
    data.builtAt = performance.now();
    if (data.type === 'antiair') {
      data.charges = 3;
    }
    state.buildings.push(data);
  });

  socket.on('building-completed', ({ type, factionId, row, col, radius, defTier }) => {
    const b = state.buildings.find(b => b.row === row && b.col === col && b.factionId === factionId);
    if (b) b.constructing = false;
    // Only defense towers fortify their zone on completion.
    if (type !== 'defense') return;
    const r = radius ?? BUILDING_RADIUS;
    const t = defTier ?? 10;
    if (b) { b.radius = r; b.defTier = t; }
    applyDefenseBuilding(row, col, r, t, factionId);
  });

  socket.on('building-destroyed', ({ row, col }) => {
    // Clear exactly what placement stamped: use the stored building's radius,
    // falling back to the current constant if the descriptor is missing.
    const b = state.buildings.find(b => b.row === row && b.col === col);
    const radius = b ? b.radius : BUILDING_RADIUS;
    // Only completed defense towers ever stamped a zone. Silos and still-building
    // towers stamped nothing, so clearing would wrongly wipe an overlapping
    // completed fort's tier until the next snapshot resync.
    const stampedZone = b && !b.constructing && b.type !== 'silo';
    state.buildings = state.buildings.filter(b => !(b.row === row && b.col === col));
    if (stampedZone) removeDefenseBuilding(row, col, radius);
  });

  socket.on('building-owner-changed', ({ row, col, factionId }) => {
    // A silo was fully conquered — recolor its icon and update who may fire it.
        const b = state.buildings.find(b => b.row === row && b.col === col);
    if (b) b.factionId = factionId;
  });

  socket.on('missile-fired', ({ sourceRow, sourceCol, targetRow, targetCol, factionId }) => {
    // Determine the distance to calculate flight time
    const dist = Math.sqrt((targetRow - sourceRow)**2 + (targetCol - sourceCol)**2);
    // Use the exact same speed as the server (40 cells/sec)
    const flightTimeMs = (dist / 40) * 1000;
    
    state.activeMissiles.push({
      sourceRow, sourceCol, targetRow, targetCol, factionId,
      startedAt: performance.now(),
      flightTimeMs,
      intercepted: false
    });

    const silo = state.buildings.find(b => b.type === 'silo' && b.row === sourceRow && b.col === sourceCol);
    if (silo) {
      silo.lastFiredAt = performance.now();
      silo.cooldownMs = 2000;
    }
  });

  socket.on('missile-intercepted', ({ sourceRow, sourceCol, targetRow, targetCol, batteryRow, batteryCol, interceptRow, interceptCol }) => {
    // Find the missile in activeMissiles and mark it intercepted
    const missile = state.activeMissiles.find(m => 
      m.sourceRow === sourceRow && m.sourceCol === sourceCol && 
      m.targetRow === targetRow && m.targetCol === targetCol && !m.intercepted
    );
    if (missile) {
      const now = performance.now();
      const timeRemainingMs = missile.flightTimeMs - (now - missile.startedAt);
      const interceptorFlightTime = Math.max(0, Math.min(400, timeRemainingMs));
      
      const tHit = (now - missile.startedAt + interceptorFlightTime) / missile.flightTimeMs;
      const hitRow = missile.sourceRow + (missile.targetRow - missile.sourceRow) * tHit;
      const hitCol = missile.sourceCol + (missile.targetCol - missile.sourceCol) * tHit;

      missile.intercepted = true;
      missile.interceptRow = hitRow;
      missile.interceptCol = hitCol;
      missile.interceptorArrivesAt = now + interceptorFlightTime;

      if (batteryRow !== undefined && batteryCol !== undefined) {
        state.activeInterceptors.push({
          sourceRow: batteryRow,
          sourceCol: batteryCol,
          targetRow: hitRow,
          targetCol: hitCol,
          startedAt: now,
          durationMs: interceptorFlightTime,
          targetAltitude: 150 * Math.sin(tHit * Math.PI)
        });
      }
    }

    // Decrement battery charges
    if (batteryRow !== undefined && batteryCol !== undefined) {
      const battery = state.buildings.find(b => b.row === batteryRow && b.col === batteryCol && b.type === 'antiair');
      if (battery) {
        battery.charges = Math.max(0, (battery.charges || 3) - 1);
      }
    }
  });

  socket.on('build-rejected', ({ type } = {}) => {
    const msg = type === 'fire_missile'
      ? `Can't fire — target must be within ${SILO_RANGE} cells of an available silo (2s cooldown), and costs ${MISSILE_COST.toLocaleString()} gold.`
      : type === 'build_silo'
        ? `Can't build a silo here — need ${SILO_BUILDING_COST.toLocaleString()} gold and you must own the entire 8×8 area, clear of other buildings.`
      : type === 'build_mine'
        ? `Can't build a gold mine here — need ${MINE_BUILDING_COST.toLocaleString()} gold and you must own the entire 8×8 area, clear of other buildings.`
      : type === 'build_antiair'
        ? `Can't build an Anti-Air battery here — need ${ANTIAIR_BUILDING_COST.toLocaleString()} gold and you must own the entire 8×8 area, clear of other buildings.`
        : `Cannot build here — need ${DEFENSE_BUILDING_COST.toLocaleString()} gold and you must own the entire 8×8 area, clear of other buildings.`;
    showToast(msg, 'error');
  });
}
