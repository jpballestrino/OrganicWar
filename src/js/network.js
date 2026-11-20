import { io } from 'socket.io-client';
import { state } from './state.js';
import { showToast, toggleInGameIndicator } from './guildUI.js';
import { getToken, isLoggedIn } from './auth.js';
import { setServerMode, setServerProfile, loadLocalProfile, renderProgressCards } from './progression.js';
import { applyOwnerDelta, applyOwnerRuns, clearAllBuildingBits, decodeStats, applyDefenseBuilding, removeDefenseBuilding, resyncBuildingZones, resyncZonesForCells, repaintTerrain, setMapSize } from './simBridge.js';
import { escapeHtml } from './escape.js';
import { MAP_LABELS } from './mapGen.js';
import { onSnapshotStats } from './matchFeel.js';
import { GROWTH_PEAK_RATIO, BUILDING_RADIUS, DEFENSE_BUILD_MS, factionHexColors, fmtInt, MAP_SIZES } from './constants.js';
import { updateBuildBar, rejectMessage } from './buildBar.js';

// The handshake carries the player's UTC offset so the server rolls daily
// missions and streaks over at the player's own midnight.
export const socketAuth = () => ({ token: getToken(), tzOffset: new Date().getTimezoneOffset() });

export const socket = io({
  auth: socketAuth(),
  // Retry quickly: a player whose connection blipped should be back in a
  // second or two, not after the default 5 s back-off.
  reconnectionDelay: 500,
  reconnectionDelayMax: 2000,
});

// Leave the match for good (a bot takes over the faction at once). Waits for
// the server to confirm — at most 1 s — so the quit isn't lost in the reload.
export function quitAndReload() {
  sessionStorage.removeItem('reconnectToken');
  let left = false;
  const go = () => { if (!left) { left = true; location.reload(); } };
  if (socket.connected) {
    socket.timeout(1000).emit('quit-game', go);
    setTimeout(go, 1200);
  } else {
    go();
  }
}

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
// In a busy room (a Mega Battle opening loses ~30 factions in a minute) the
// eliminations that don't involve you fold into one "+N more" line once three
// arrived within FEED_BURST_MS.
const FEED_BURST_MS = 4000;
let feedBurst = [];
let feedSummary = null;
function foldIntoSummary(feed) {
  const now = Date.now();
  feedBurst = feedBurst.filter((t) => now - t < FEED_BURST_MS);
  feedBurst.push(now);
  if (feedBurst.length <= 3) return false;
  if (!feedSummary || !feedSummary.isConnected) {
    feedSummary = document.createElement('div');
    feedSummary.className = 'kill-feed-entry';
    feedSummary.dataset.count = '0';
  }
  feedSummary.dataset.count = String(Number(feedSummary.dataset.count) + 1);
  feedSummary.innerHTML = `<span class="kill-feed-skull">☠</span><span>+${feedSummary.dataset.count} more eliminated</span>`;
  feedSummary.classList.remove('fade-out');
  feed.prepend(feedSummary);
  clearTimeout(feedSummary.fadeTimer);
  const el = feedSummary;
  el.fadeTimer = setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => { el.remove(); if (feedSummary === el) feedSummary = null; }, 500);
  }, 6000);
  return true;
}

function addKillFeedEntry(factionId, killerId = 0) {
  const feed = document.getElementById('killFeed');
  if (!feed) return;
  const me = parseInt(state.playerFaction);
  if (factionId !== me && killerId !== me && foldIntoSummary(feed)) return;
  const slot = state.activePlayerSlots ? state.activePlayerSlots[factionId] : null;
  const name = slot && slot.nickname ? slot.nickname : `Player ${factionId}`;
  const color = factionHexColors[factionId] || '#ffffff';

  const entry = document.createElement('div');
  entry.className = 'kill-feed-entry';
  entry.innerHTML =
    `<span class="kill-feed-skull">☠</span>` +
    `<span class="kill-feed-name" style="color:${color}">${escapeHtml(name)}</span>` +
    `<span>eliminated</span>`;
  if (killerId && killerId !== factionId) {
    const kSlot = state.activePlayerSlots ? state.activePlayerSlots[killerId] : null;
    const kName = kSlot && kSlot.nickname ? kSlot.nickname : `Player ${killerId}`;
    entry.innerHTML +=
      `<span>by</span>` +
      `<span class="kill-feed-name" style="color:${factionHexColors[killerId] || '#ffffff'}">${escapeHtml(kName)}</span>`;
  }
  feed.prepend(entry);

  // Cap the visible feed length.
  while (feed.children.length > 6) { feed.removeChild(feed.lastChild); }

  // Auto-fade and remove.
  setTimeout(() => {
    entry.classList.add('fade-out');
    setTimeout(() => entry.remove(), 500);
  }, 6000);
}

// Zoom in on a map cell (spawn at match start, own territory after a reload).
function centerCamera(row, col, zoom = 2.5) {
  const r = window.renderer;
  r.camera.zoom = zoom;
  r.camera.x = col - r.canvas.width / zoom / 2;
  r.camera.y = row - r.canvas.height / zoom / 2;
}

// Show the in-match HUD (top bar, leaderboard, build bar, kill feed) and the
// map. Used when a match starts and when a reload / reconnect lands mid-match.
function showMatchHud() {
  const show = (id, display) => { const el = document.getElementById(id); if (el) el.style.display = display; };
  show('gameHUD', 'flex');
  show('gameLeaderboard', 'block');
  show('gameEconomyHUD', 'flex');
  show('killFeed', 'flex');
  show('waitingOverlay', 'none');
  show('spawnOverlay', 'none');
  show('gameArea', 'flex');
}

// A generic kill-feed line: "<icon> <faction A> <text> [<faction B>]".
function addFeedLine(icon, fidA, text, fidB = 0) {
  const feed = document.getElementById('killFeed');
  if (!feed) return;
  const nameOf = (fid) => {
    const slot = state.activePlayerSlots ? state.activePlayerSlots[fid] : null;
    return fid === parseInt(state.playerFaction) ? 'You' : (slot && slot.nickname ? slot.nickname : `Player ${fid}`);
  };
  const entry = document.createElement('div');
  entry.className = 'kill-feed-entry';
  entry.innerHTML =
    `<span class="kill-feed-skull">${icon}</span>` +
    `<span class="kill-feed-name" style="color:${factionHexColors[fidA] || '#fff'}">${escapeHtml(nameOf(fidA))}</span>` +
    `<span>${escapeHtml(text)}</span>` +
    (fidB ? `<span class="kill-feed-name" style="color:${factionHexColors[fidB] || '#fff'}">${escapeHtml(nameOf(fidB))}</span>` : '');
  feed.prepend(entry);
  while (feed.children.length > 6) feed.removeChild(feed.lastChild);
  setTimeout(() => {
    entry.classList.add('fade-out');
    setTimeout(() => entry.remove(), 500);
  }, 6000);
}

// ── Bad connections ──────────────────────────────────────────────────────────
// Three ways the connection goes bad mid-match, all shown with the
// "Reconnecting…" overlay:
//   * it closes — Socket.IO retries on its own;
//   * it stalls without closing (Wi-Fi hiccup, overloaded router): nothing
//     arrives, so a watchdog notices that the 5-per-second stats stopped,
//     shows the overlay after STALL_SHOW_MS and forces a fresh connection
//     after STALL_RECONNECT_MS (the old one may never recover by itself);
//   * the server can't place us back (match over / we were gone too long).
// While we're away the faction holds still for the server's grace period
// (init-config `reconnectGraceSec`), then a bot plays it until we're back.
const STALL_SHOW_MS = 2500;
const STALL_RECONNECT_MS = 7000;
let lastServerMsgAt = performance.now();
// Armed by the first stats of a match (they start a moment after the match
// does), so a slow start isn't mistaken for a stalled connection.
let statsFlowing = false;
socket.onAny((ev) => {
  lastServerMsgAt = performance.now();
  if (ev === 'sim-stats') statsFlowing = true;
});
const inMatch = () => state.gameState === 'PLAYING' && statsFlowing;

function showReconnecting(detail) {
  const el = document.getElementById('reconnectingOverlay');
  if (!el) return;
  el.style.display = 'flex';
  const txt = document.getElementById('reconnectAttemptText');
  if (txt && detail) txt.innerText = detail;
  const hold = document.getElementById('reconnectHoldText');
  if (hold) {
    const g = state.reconnectGraceSec || 30;
    hold.innerText = `Your territory holds for ${g} s — after that a bot plays for you until you're back.`;
  }
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

setInterval(() => {
  if (!inMatch() || !socket.connected) return;
  const quiet = performance.now() - lastServerMsgAt;
  if (quiet > STALL_RECONNECT_MS) {
    // The connection is stuck: drop it and let Socket.IO open a new one.
    lastServerMsgAt = performance.now();
    showReconnecting('Connection lost — reconnecting…');
    socket.io.engine.close();
  } else if (quiet > STALL_SHOW_MS) {
    showReconnecting('Connection unstable — waiting for the server…');
  } else {
    hideReconnecting();
  }
}, 500);

// Transport-level reconnection events (Socket.IO engine layer)
socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') {
    // The server closed us on purpose (e.g. this account logged in elsewhere):
    // Socket.IO won't retry, so don't show "Reconnecting…" forever.
    if (state.gameState !== 'SETUP') showServerError('Disconnected', 'This account was opened somewhere else, or the server closed the connection.');
    return;
  }
  if (state.gameState !== 'SETUP' && reason !== 'io client disconnect') {
    showReconnecting('Connection lost — reconnecting…');
  }
});

socket.io.on('reconnect', () => {
  // Re-send the game reconnect token so the server gives us our faction back
  // (in the lobby, during spawn selection or mid-match).
  const savedToken = sessionStorage.getItem('reconnectToken');
  if (savedToken && state.gameState !== 'SETUP') {
    showReconnecting('Rejoining your match…');
    socket.emit('reconnect-to-game', { token: savedToken });
  } else {
    hideReconnecting();
  }
});

socket.io.on('reconnect_attempt', (attempt) => {
  if (state.gameState !== 'SETUP') showReconnecting(`Connection lost — reconnecting (attempt ${attempt})…`);
});

socket.io.on('reconnect_failed', () => {
  showServerError('Server Unreachable', 'Could not reconnect after multiple attempts. Please return to the menu and try again.');
});

// The room's map size (Mega Battles use a bigger map): reallocate the local
// map and the renderer's textures before anything is painted into them.
function useRoomMapSize(width, height) {
  const w = width || MAP_SIZES.standard.width;
  const h = height || MAP_SIZES.standard.height;
  if (setMapSize(w, h) && window.renderer) window.renderer.resizeMap();
}

export function initNetwork() {
  // ── Progression for logged-in players (server/game/progression.js) ──
  // The server owns their XP: it pushes the profile on connect and the scored
  // result when their match ends. A first login offers this browser's guest
  // XP for a one-time import (the server validates it).
  setServerMode(isLoggedIn());
  socket.on('progression-profile', ({ profile, canImport } = {}) => {
    setServerMode(true);
    setServerProfile(profile);
    renderProgressCards();
    if (canImport) {
      const local = loadLocalProfile();
      if (local.games > 0) socket.emit('progression-import', local);
    }
  });

  const savedToken = sessionStorage.getItem('reconnectToken');
  if (savedToken) {
    console.log('[RECONNECT] Sending token:', savedToken);
    socket.emit('reconnect-to-game', { token: savedToken });
  }

  document.getElementById('btnReconnectLeave')?.addEventListener('click', () => quitAndReload());

  socket.on('reconnect-success', ({ factionId, nickname, inMatch, phase }) => {
    statsFlowing = false;
    state.playerFaction = factionId;
    state.playerNickname = nickname;
    hideReconnecting();
    lastServerMsgAt = performance.now();
    if (inMatch === false) {
      // Still before the match: the lobby (init-config just showed the
      // waiting screen) or spawn selection (spawn-selection-start follows).
      state.gameState = phase === 'SPAWN_SELECTION' ? 'SPAWN_SELECTION' : 'LOBBY_WAIT';
      document.getElementById('homeScreen').style.display = 'none';
      return;
    }
    state.gameState = 'PLAYING';

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

    // The full map, buildings and stats follow in `sim-full`.
    showMatchHud();

    updateDevDashboard();
  });

  // The server could not place us in a match (no capacity). The menu was
  // hidden when we asked, so bring it back instead of leaving a blank screen.
  socket.on('matchmaking-failed', ({ message } = {}) => {
    state.gameState = 'SETUP';
    const home = document.getElementById('homeScreen');
    if (home) { home.style.display = 'flex'; home.style.opacity = '1'; }
    // Leaving the ranked queue view also stops its timer.
    const queue = document.getElementById('homeStateRankedQueue');
    if (queue && queue.style.display !== 'none') document.getElementById('btn-leave-ranked')?.click();
    showToast(message || 'Could not start a match. Please try again.', 'error');
  });

  socket.on('reconnect-failed', ({ reason, winnerName } = {}) => {
    sessionStorage.removeItem('reconnectToken');
    const wasInGame = state.gameState !== 'SETUP';
    state.gameState = 'SETUP';
    hideReconnecting();
    if (wasInGame) {
      // We were in a match on this page: say what happened, then a clean menu.
      showServerError(
        reason === 'ended' ? 'Match Over' : 'Match Unavailable',
        reason === 'ended'
          ? `The match ended while you were disconnected${winnerName ? ` — ${winnerName} won` : ''}.`
          : 'You were away too long, so your place in the match is gone.',
      );
      const btn = document.getElementById('btnServerErrorReturn');
      if (btn) btn.innerText = 'Main Menu';
    } else {
      document.getElementById('homeScreen').style.display = 'flex';
      if (reason === 'ended') showToast(`Your last match ended while you were away${winnerName ? ` — ${winnerName} won` : ''}.`, 'info');
    }
  });

  // Another player's connection: reconnecting / back / bot playing / left.
  socket.on('player-connection', ({ factionId, state: st, bot } = {}) => {
    if (factionId === parseInt(state.playerFaction) || state.gameState !== 'PLAYING') return;
    const text = {
      reconnecting: 'is reconnecting…',
      back: 'is back',
      away: bot ? 'lost connection — a bot plays for now' : 'lost connection — their land stands idle',
      left: bot ? 'left the match — a bot takes over' : 'left the match',
    }[st];
    // (The leaderboard shows 📡 / 🤖 next to the name from the slot flags.)
    if (text) addFeedLine(st === 'back' ? '📶' : st === 'reconnecting' ? '📡' : '🤖', factionId, ` ${text}`);
  });

  // Simulation crash — room was terminated server-side (Tier 1 onError callback)
  socket.on('server-error', ({ message } = {}) => {
    sessionStorage.removeItem('reconnectToken');
    state.gameState = 'SETUP';
    showServerError('Game Error', message || 'The game server encountered an error. Please return to the menu.');
  });

  socket.on('player-count-update', () => {});

  socket.on('init-config', (config) => {
    state.activePlayerSlots = config.activePlayerSlots;
    state.currentPreset = config.currentPreset;
    if (config.reconnectGraceSec) state.reconnectGraceSec = config.reconnectGraceSec;
    // Repaint terrain to the room's map (covers the reconnect path, where the
    // client may have painted the default map at startup). Safe pre-match: only
    // terrain bits change and owner bits are still all-neutral.
    useRoomMapSize(config.mapWidth, config.mapHeight);
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
      } else if (config.isRankedMatch) {
        title.innerText = 'Ranked Match · get ready';
      } else if (config.isQuickPlay) {
        title.innerText = config.maxPlayers > 20 ? `Mega Battle Matchmaking · ${config.maxPlayers} commanders` : 'Quick Game Matchmaking';
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

  socket.on('ranked-queue-update', ({ count, range } = {}) => {
    const lblPlayers = document.getElementById('lblRankedPlayers');
    if (!lblPlayers) return;
    const who = count > 1 ? `${count} players in the queue` : 'Searching for opponents…';
    const span = range ? ` · rating ±${range}` : ' · any rating';
    lblPlayers.innerText = who + span;
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

  socket.on('start-match-now', ({ centroids } = {}) => {
    statsFlowing = false;
    state.gameState = 'PLAYING';

    // Zoom in on our own land — the spawn we picked, or where the server put
    // us if we didn't pick one. (Left at the whole-map zoom, the map fits the
    // screen and the camera keys have nowhere to move it.)
    const picked = state.spawnSelections && state.spawnSelections[state.playerFaction];
    const placed = (centroids || state.factionCentroids || {})[state.playerFaction];
    if (window.renderer && picked) centerCamera(picked.row, picked.col);
    else if (window.renderer && placed) centerCamera(placed.r, placed.c);
    // A text field from the menu may still hold the focus; game keys go to the map.
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    
    const killFeed = document.getElementById('killFeed');
    if (killFeed) killFeed.innerHTML = '';
    showMatchHud();

    updateDevDashboard();
  });

  socket.on('spawn-selection-start', (data) => {
    state.gameState = 'SPAWN_SELECTION';
    if (data && data.safeZoneRadius) state.safeZoneRadius = data.safeZoneRadius;

    // Repaint the local terrain to the room's map before the spawn canvas shows,
    // so players pick spawns on the correct landmass. Falls back to the preset
    // received in init-config.
    const mapId = (data && data.mapId) || state.currentPreset;
    useRoomMapSize(data && data.mapWidth, data && data.mapHeight);
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

  socket.on('gold-seized', ({ fromId, toId, gold, kind }) => {
    // Only treasury plunder goes in the feed; salvage is too frequent.
    if (kind === 'plunder' && gold >= 1) addFeedLine('💰', toId, `plundered ${fmtInt(gold)} gold from`, fromId);
  });

  socket.on('blitz-started', ({ factionId }) => {
    if (factionId !== parseInt(state.playerFaction)) addFeedLine('⚡', factionId, 'launched a Blitz');
  });

  socket.on('player-eliminated', ({ factionId, killerId }) => {
    addKillFeedEntry(factionId, killerId);
    state.eliminatedFactions.add(factionId);
  });

  // `game-over` (and the player's own elimination) are handled by matchFeel.js,
  // which shows the recap screen with placement, XP and the play-again flow.

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
      detailDiv.textContent = `Map: ${MAP_LABELS[room.preset] || room.preset} | Players: ${room.currentPlayers}/${room.maxPlayers}`;
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

  // Owner changes, ~20×/s.
  socket.on('sim-delta', (buf) => {
    const t0 = state.debug ? performance.now() : 0;
    const changed = applyOwnerDelta(buf);
    // Owner bits changed; newly-conquered cells inside a tower radius gain
    // (and cells lost out of it drop) tier 10 — only the changed cells.
    resyncZonesForCells(changed, state.buildings);
    if (state.debug) {
      const ms = performance.now() - t0;
      state.lastApplyMs = ms;
      state.avgApplyMs = state.avgApplyMs === 0 ? ms : state.avgApplyMs * 0.9 + ms * 0.1;
    }
  });

  // Per-player numbers, ~5×/s.
  socket.on('sim-stats', (buf) => applyStats(decodeStats(buf)));

  // Everything at once, for a client that (re)joined a running match.
  socket.on('sim-full', ({ owners, buildings, stats }) => {
    applyOwnerRuns(owners);
    clearAllBuildingBits();
    const now = performance.now();
    state.buildings = (buildings || []).map((b) => ({
      ...b,
      // Back-date the start so the progress bar shows the real time left.
      builtAt: b.constructing ? now - (b.buildMs - b.remainingMs) : now,
    }));
    for (const b of state.buildings) {
      if (b.type === 'defense' && !b.constructing) {
        applyDefenseBuilding(b.row, b.col, b.radius ?? BUILDING_RADIUS, b.defTier ?? 10, b.factionId);
      }
    }
    if (stats) {
      const decoded = decodeStats(stats);
      applyStats(decoded);
      // A reload lands on the whole-map view: bring the camera home.
      const me = decoded.players[parseInt(state.playerFaction)];
      if (me && me.cells > 0 && window.renderer) centerCamera(me.row, me.col);
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
    // Only completed defense towers ever stamped a zone. Every other building
    // type, and a tower still under construction, stamped nothing — clearing
    // would wipe an overlapping completed fort's tier until the next resync.
    const stampedZone = b && !b.constructing && b.type === 'defense';
    state.buildings = state.buildings.filter(b => !(b.row === row && b.col === col));
    if (stampedZone) {
      removeDefenseBuilding(row, col, radius);
      // An overlapping fort of the same owner keeps its zone (rare event, so
      // re-deriving every zone here is fine).
      resyncBuildingZones(state.buildings);
    }
  });

  // A building's synergy links or anti-air interceptors changed.
  socket.on('building-updated', ({ row, col, links, charges }) => {
    const b = state.buildings.find(x => x.row === row && x.col === col);
    if (!b) return;
    b.links = links;
    if (b.type === 'antiair') b.charges = charges;
  });

  socket.on('building-owner-changed', ({ row, col, factionId }) => {
    // A building was fully conquered — recolor its icon and update its owner.
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

  socket.on('missile-intercepted', ({ sourceRow, sourceCol, targetRow, targetCol, batteryRow, batteryCol }) => {
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
    showToast(rejectMessage(type), 'error');
  });
}

// ── Per-player stats → HUD, leaderboard, labels, game-feel ──────────────────
// Every number here comes straight from the sim (see decodeStats); the client
// no longer re-derives economy values from mirrored constants.
const setText = (id, text) => {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
};

function applyStats({ landCells, dominationShare, bountyFid, players }) {
  state.bountyFid = bountyFid || 0;
  // Labels at each territory centroid, and the shader's per-faction opacity
  // (troops per cell, normalised so 25/cell is fully opaque).
  const centroids = {};
  if (!state.factionOpacity || state.factionOpacity.length < players.length) {
    state.factionOpacity = new Float32Array(players.length);
  }
  const opacity = state.factionOpacity;
  for (let f = 1; f < players.length; f++) {
    const p = players[f];
    opacity[f] = p.cells > 0 ? Math.min(p.troops / p.cells / 25, 1) : 0;
    if (p.cells > 0) {
      // Troops shown on the map include those out on attack.
      centroids[f] = { row: p.row, col: p.col, troops: Math.floor(p.total), cells: p.cells };
    }
  }
  state.factionCentroids = centroids;

  updateLeaderboard(players);

  const fid = parseInt(state.playerFaction);
  const me = players[fid];
  if (!me) return;

  // --- Top bar ---
  const total = Math.floor(me.total);
  state.playerTroops = total;
  state.playerMaxPop = Math.round(me.maxPop);
  const fill = me.maxPop > 0 ? me.total / me.maxPop : 0;
  setText('lblMyTroops', fmtInt(total));
  setText('lblMyMaxPop', fmtInt(me.maxPop));
  const lblAttacking = document.getElementById('lblMyAttacking');
  if (lblAttacking) {
    lblAttacking.textContent = fmtInt(me.attacking);
    lblAttacking.style.color = me.attacking >= 1 ? '#ff9800' : '#aaa';
  }
  setText('lblMyFill', `${Math.round(fill * 100)}%`);
  const lblGrowth = document.getElementById('lblMyGrowth');
  if (lblGrowth) {
    lblGrowth.textContent = `+${fmtInt(Math.round(me.growth))}/s`;
    // Green while growth is still accelerating, red once past the peak fill.
    lblGrowth.style.color = fill < GROWTH_PEAK_RATIO ? '#28a745' : '#dc3545';
  }
  setText('lblMyCells', fmtInt(me.cells));
  state.playerKills = Math.floor(me.kills);
  setText('lblMyKills', window.formatAbbreviation ? window.formatAbbreviation(me.kills) : fmtInt(me.kills));

  // --- Bottom bar ---
  state.prices = me.prices;
  // Stats arrive 5×/s; keep the absolute deadline so the bar counts down smoothly.
  const now = performance.now();
  state.blitzActiveUntil = now + me.blitzActive * 1000;
  state.blitzReadyAt = now + me.blitzCooldown * 1000;
  state.playerGold = Math.floor(me.gold);
  setText('lblMyGold', fmtInt(me.gold));
  setText('lblMyGoldRate', `+${fmtInt(Math.round(me.income))}/s`);
  updateBuildBar();

  // --- Game-feel layer (rank callouts, under-attack alerts, milestones) ---
  const board = state.leaderboardData.filter(lb => !lb.isEliminated);
  let landLeaderFid = 0;
  let landLeaderCells = 0;
  for (let f = 1; f < players.length; f++) {
    if (players[f].cells > landLeaderCells) { landLeaderCells = players[f].cells; landLeaderFid = f; }
  }
  onSnapshotStats({
    cells: me.cells,
    gold: state.playerGold,
    rank: board.findIndex(lb => lb.fid === fid) + 1,
    alive: board.length,
    leaderFid: board.length ? board[0].fid : 0,
    landCells,
    dominationShare,
    landLeaderFid,
    landLeaderCells,
    bountyFid: state.bountyFid,
    bountyEarned: me.bountyEarned,
  });
}

const LEADERBOARD_ROWS = 10;

// Score = gold spent + kills + troops (incl. on attack) + land.
function updateLeaderboard(players) {
  const data = state.leaderboardData || (state.leaderboardData = []);
  data.length = 0;
  for (let f = 1; f < players.length; f++) {
    const p = players[f];
    const isEliminated = state.eliminatedFactions.has(f);
    if (!p.alive && !isEliminated) continue; // unused slot
    const score = Math.floor(p.goldSpent) + Math.floor(p.kills) + Math.floor(p.total) + p.cells;
    data.push({ fid: f, score, isEliminated });
  }
  data.sort((a, b) => b.score - a.score);

  const now = performance.now();
  if (state.lastLeaderboardRender && now - state.lastLeaderboardRender < 500) return;
  state.lastLeaderboardRender = now;
  const list = document.getElementById('leaderboardList');
  if (!list) return;
  const myFid = parseInt(state.playerFaction);
  // Top LEADERBOARD_ROWS, plus your own row (with its real rank) if you are
  // further down — a 20+ player list does not fit next to the map.
  const shown = data.map((lb, index) => ({ lb, index }))
    .filter(({ lb, index }) => index < LEADERBOARD_ROWS || lb.fid === myFid);
  list.innerHTML = shown.map(({ lb, index }) => {
    const color = factionHexColors[lb.fid] || '#fff';
    const isMe = lb.fid === myFid;
    const slot = state.activePlayerSlots ? state.activePlayerSlots[lb.fid] : null;
    const name = isMe ? 'You' : escapeHtml(slot && slot.nickname ? slot.nickname : `Player ${lb.fid}`);
    const score = window.formatAbbreviation ? window.formatAbbreviation(lb.score) : fmtInt(lb.score);
    const nameStyle = lb.isEliminated ? 'text-decoration: line-through; opacity: 0.5;' : '';
    const bounty = lb.fid === state.bountyFid ? '<span class="leaderboard-bounty" title="Bounty: their land is 25% cheaper to take and pays gold">🎯</span>' : '';
    const conn = !slot || isMe ? ''
      : slot.disconnected ? '<span class="leaderboard-conn" title="Reconnecting…">📡</span>'
        : slot.away ? (slot.isBot ? '<span class="leaderboard-conn" title="Disconnected — a bot plays until they return">🤖</span>'
          : '<span class="leaderboard-conn" title="Disconnected — their land stands idle">💤</span>')
          : slot.left ? (slot.isBot ? '<span class="leaderboard-conn" title="Left the match — a bot plays">🤖</span>'
            : '<span class="leaderboard-conn" title="Left the match">🏳️</span>') : '';
    // Guild wars: show each player's side.
    const side = state.isGuildWar && state.guildA && state.guildB
      ? `<span style="font-size:10px; color:${lb.fid <= state.teamSize ? '#ffc107' : '#ff6b6b'};">[${escapeHtml(lb.fid <= state.teamSize ? state.guildA.tag : state.guildB.tag)}]</span>` : '';
    const gap = index >= LEADERBOARD_ROWS ? '<div class="leaderboard-gap">⋯</div>' : '';
    return `${gap}
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 4px; background: ${isMe ? 'rgba(255,255,255,0.1)' : 'transparent'}; border-radius: 4px;">
        <div style="display: flex; align-items: center; gap: 6px; overflow: hidden;">
          <span style="font-size: 10px; color: #888; min-width: 14px; text-align: right;">${index + 1}.</span>
          <div style="width: 10px; height: 10px; border-radius: 50%; background-color: ${color}; border: 1px solid #000;"></div>${side}
          <span style="font-size: 12px; color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100px; ${nameStyle}">${name}</span>${conn}${bounty}
        </div>
        <span style="font-size: 13px; font-weight: bold; color: ${lb.isEliminated ? '#888' : '#ffc107'};">${score}</span>
      </div>`;
  }).join('');
}
