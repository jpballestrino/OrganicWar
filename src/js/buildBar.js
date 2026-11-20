// The build bar (bottom HUD): buttons, hotkeys, click placement, affordability
// and reject messages for every purchasable action. Everything is driven by the
// BUILD_ACTIONS table in constants.js, so adding or re-pricing an action is a
// one-line change there instead of edits in the template, key handler, click
// handler, snapshot handler and toast messages.

import { isTyping } from './typing.js';
import { state } from './state.js';
import { BUILD_ACTIONS, SILO_RANGE, fmtInt } from './constants.js';
import { getCellOwner, isCellVisible } from './simBridge.js';
import { showToast } from './guildUI.js';
import { playSfx } from './sfx.js';

const ACTION_BY_MODE = Object.fromEntries(BUILD_ACTIONS.map(a => [a.mode, a]));
const ACTION_BY_KEY = Object.fromEntries(BUILD_ACTIONS.map(a => [a.key, a]));
const ACTION_BY_INPUT = Object.fromEntries(BUILD_ACTIONS.map(a => [a.input, a]));

let emitInput = () => {};
let buttons = [];   // [{ action, el, costEl, countEl }]

const myFaction = () => parseInt(state.playerFaction);
const myBuildings = () => {
  const fid = myFaction();
  return state.buildings.filter(b => b.factionId === fid);
};

// What the player pays right now for `action` (the sim's live, escalating
// price once stats have arrived; the base price before that).
export function actionCost(action) {
  const live = state.prices && action.priceKey ? state.prices[action.priceKey] : undefined;
  return Number.isFinite(live) ? live : action.cost;
}

// Seconds until Blitz can be used again (0 = ready), and seconds of it left.
const blitzCooldown = () => Math.max(0, (state.blitzReadyAt - performance.now()) / 1000);
const blitzActive = () => Math.max(0, (state.blitzActiveUntil - performance.now()) / 1000);

// Why `action` can't be started right now, or null if it can.
function blockedReason(action) {
  if (action.mode === 'blitz') {
    const wait = blitzCooldown();
    return wait > 0.05 ? `Blitz is recharging — ready in ${Math.ceil(wait)}s.` : null;
  }
  if (action.mode === 'missile') {
    const silos = myBuildings().filter(b => b.type === 'silo');
    if (silos.length === 0) return 'Build a Missile Silo first (key 4).';
    if (silos.every(b => b.constructing)) return 'Your Missile Silo is still under construction.';
  }
  const cost = actionCost(action);
  if (state.playerGold < cost) {
    return `Not enough gold — ${action.name} costs ${fmtInt(cost)}.`;
  }
  return null;
}

// Enter (or leave) an action's placement/targeting mode. Hotkeys and button
// clicks both come through here, so they behave identically.
function toggleMode(action) {
  if (state.gameState !== 'PLAYING' || state.isSpectating) return;
  if (action.instant) {
    const reason = blockedReason(action);
    if (reason) {
      showToast(reason, 'error');
      playSfx('error');
      return;
    }
    // Optimistic: the next sim-stats confirms (or corrects) the timers.
    state.blitzReadyAt = performance.now() + 51000;
    state.blitzActiveUntil = performance.now() + 6000;
    emitInput({ type: action.input });
    return;
  }
  if (state.activePurchaseMode === action.mode) {
    state.activePurchaseMode = null;
    return;
  }
  const reason = blockedReason(action);
  if (reason) {
    showToast(reason, 'error');
    playSfx('error');
    return;
  }
  playSfx('select');
  state.activePurchaseMode = action.mode;
}

// Leave any placement/targeting mode. Returns true if one was active.
export function cancelBuildMode() {
  if (!state.activePurchaseMode) return false;
  state.activePurchaseMode = null;
  return true;
}

// A left click on the map while a build mode is active. Returns true if the
// click was consumed (so the caller must not also treat it as an attack order).
export function handleBuildClick(targetCell) {
  const action = ACTION_BY_MODE[state.activePurchaseMode];
  if (!action) return false;

  if (action.mode === 'missile') {
    // A missile must be aimed at an enemy cell. Clicking your own land or
    // nature is ignored without a message and keeps targeting mode on.
    // Under the fog the owner isn't known: a silo sees everything it can hit,
    // so a fogged cell is out of every silo's range anyway.
    if (!isCellVisible(targetCell)) return true;
    const owner = getCellOwner(targetCell);
    if (owner <= 0 || owner === myFaction()) return true;
  }

  // The server re-verifies everything; this only avoids a pointless round trip.
  const reason = blockedReason(action);
  if (reason) {
    showToast(reason, 'error');
    state.activePurchaseMode = null;
    return true;
  }
  emitInput({ type: action.input, payload: { targetCell } });
  state.activePurchaseMode = null;
  return true;
}

// Message for a `build-rejected` event from the server.
export function rejectMessage(inputType) {
  const action = ACTION_BY_INPUT[inputType];
  if (!action) return 'That action was rejected by the server.';
  const cost = fmtInt(actionCost(action));
  if (action.mode === 'missile') {
    return `Can't fire — the target must be within ${SILO_RANGE} cells of one of your ready silos (2s reload each), and a missile costs ${cost} gold.`;
  }
  return `Can't build a ${action.name} here — you need ${cost} gold and must own the whole 8×8 area, clear of other buildings.`;
}

// Draw the placement / targeting overlay for the active mode.
export function drawBuildPreview(renderer, ctx) {
  const action = ACTION_BY_MODE[state.activePurchaseMode];
  if (!action) return;
  const { r, c } = state.hoveredCell;
  if (action.mode === 'missile') {
    renderer.drawMissileTargeting(ctx, state.buildings, myFaction(), r, c);
  } else if (r >= 0) {
    renderer[action.preview](ctx, r, c);
    renderer.drawLinkPreview(ctx, action.type, r, c, state.buildings, myFaction());
  }
}

// Per-frame: highlight the button of the active mode, and count Blitz down.
export function syncBuildBarActive() {
  for (const b of buttons) {
    if (b.action.mode === 'blitz') {
      const active = blitzActive();
      const wait = blitzCooldown();
      const text = active > 0.05 ? `Active ${Math.ceil(active)}s` : wait > 0.05 ? `${Math.ceil(wait)}s` : 'Ready';
      if (b.costEl.textContent !== text) b.costEl.textContent = text;
      b.el.classList.toggle('active', active > 0.05);
      b.el.classList.toggle('disabled', active <= 0.05 && wait > 0.05);
      continue;
    }
    b.el.classList.toggle('active', state.activePurchaseMode === b.action.mode);
  }
}

// Per-snapshot: grey out what can't be afforded and refresh the owned counts.
export function updateBuildBar() {
  const mine = myBuildings();
  for (const b of buttons) {
    const { action } = b;
    if (action.instant) continue; // Blitz is updated every frame
    const cost = actionCost(action);
    let disabled = state.playerGold < cost;
    if (action.mode === 'missile') {
      disabled = disabled || !mine.some(x => x.type === 'silo' && !x.constructing);
    }
    b.el.classList.toggle('disabled', disabled);
    b.el.setAttribute('aria-disabled', disabled ? 'true' : 'false');

    const costText = `${fmtInt(cost)}g`;
    if (b.costEl.textContent !== costText) b.costEl.textContent = costText;

    if (action.type) {
      const n = mine.filter(x => x.type === action.type).length;
      b.countEl.hidden = n === 0;
      const countText = String(n);
      if (b.countEl.textContent !== countText) b.countEl.textContent = countText;
    }
  }
}

export function initBuildBar({ emit }) {
  emitInput = emit;
  buttons = [];
  document.querySelectorAll('.build-option[data-mode]').forEach((el) => {
    const action = ACTION_BY_MODE[el.dataset.mode];
    if (!action) return;
    buttons.push({
      action, el,
      costEl: el.querySelector('.build-cost'),
      countEl: el.querySelector('.build-count'),
    });
    el.addEventListener('click', () => {
      toggleMode(action);
      el.blur(); // keep Space / Enter from re-triggering the button mid-battle
    });
  });

  window.addEventListener('keydown', (e) => {
    const action = ACTION_BY_KEY[e.key];
    if (!action || e.ctrlKey || e.metaKey || e.altKey) return;
    if (state.gameState !== 'PLAYING') return;
    if (isTyping()) return;
    e.preventDefault();
    toggleMode(action);
  });
}
