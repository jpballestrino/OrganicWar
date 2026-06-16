import { state } from './state.js';

import { socket, quitAndReload } from './network.js';
import { ROWS, COLS } from './constants.js';

export function getFactionName(id) {
  if (state.activePlayerSlots[id]) {return state.activePlayerSlots[id].nickname;}
  const names = { 
    1: 'Blue Force', 2: 'Red Bot', 3: 'Orange Bot', 4: 'Purple Bot', 5: 'Teal Bot',
    6: 'Yellow Bot', 7: 'Slate Bot', 8: 'Pink Bot', 9: 'Mint Bot', 10: 'Cyan Bot',
    11: 'Crimson Bot', 12: 'Lilac Bot', 13: 'Rose Bot', 14: 'Coral Bot', 15: 'Aqua Bot',
    16: 'Mustard Bot', 17: 'Periwinkle Bot', 18: 'Silver Bot', 19: 'Salmon Bot', 20: 'Indigo Bot',
  };
  return names[id] || `Faction ${id} Bot`;
}

export function isNearWater(r, c) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      let nr = r + dr;
      let nc = c + dc;
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
        if (state.terrain[nr] && state.terrain[nr][nc] === 3) {
          return true;
        }
      }
    }
  }
  return false;
}

export function spawnAtCoordinates(r, c) {
  socket.emit('spawn-player', { r, c, factionId: state.playerFaction, doctrine: state.selectedDoctrine });
}

export function startSpectatorMode() {
  state.gameState = 'SPECTATING';
  state.playerFaction = null;
  const shopPanel = document.getElementById('shopPanel');
  if (shopPanel) {shopPanel.style.display = 'none';}
  const bottomHUD = document.getElementById('bottomHUD');
  if (bottomHUD) {bottomHUD.style.display = 'none';}
  const minimapPanel = document.getElementById('minimapPanel');
  if (minimapPanel) {minimapPanel.style.display = 'none';}
    
  let exitBtn = document.getElementById('exitSpectatorBtn');
  if (!exitBtn) {
    exitBtn = document.createElement('button');
    exitBtn.id = 'exitSpectatorBtn';
    exitBtn.className = 'action-btn';
    exitBtn.style.left = '15px';
    exitBtn.style.right = 'auto';
    exitBtn.style.display = 'flex';
    exitBtn.innerHTML = '🚪 Quit to Setup';
    exitBtn.onclick = () => quitAndReload();
    const container = document.getElementById('canvasContainer') || document.body;
    container.appendChild(exitBtn);
  } else {
    exitBtn.style.display = 'flex';
  }
}

export function unflattenGrid(buffer, rows, cols) {
  let flat = new Uint8Array(buffer);
  let grid = new Array(rows);
  for (let r = 0; r < rows; r++) {
    grid[r] = flat.slice(r * cols, (r + 1) * cols);
  }
  return grid;
}

export function formatNumber(num) {
  num = Math.floor(num || 0);
  if (num < 1000) {return num.toString();}
  if (num < 10000) {return parseFloat((num / 1000).toFixed(1)) + 'k';}
  if (num < 1000000) {return Math.floor(num / 1000) + 'k';}
  if (num < 10000000) {return parseFloat((num / 1000000).toFixed(1)) + 'kk';}
  return Math.floor(num / 1000000) + 'kk';
}
