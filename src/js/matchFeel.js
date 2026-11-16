// "Game feel" layer: everything that makes a match read as an event rather than
// a spreadsheet — announcer banners, sound cues, under-attack warnings, rank
// tracking, the end-of-match recap (placement, XP, missions) and the
// spectate / play-again flow. Purely presentational: it listens to the same
// socket events as network.js and never sends game inputs.

import { state } from './state.js';
import { playSfx } from './sfx.js';
import { applyMatchResult } from './progression.js';
import { escapeHtml } from './escape.js';
import { showToast } from './guildUI.js';
import { getCellOwner } from './simBridge.js';
import { DEFENSE_BUILDING_COST, SILO_BUILDING_COST } from './constants.js';

const AUTO_QUICK_PLAY_KEY = 'ow_auto_quick_play';
// A fair share of a 20-player map is ~63k land (everyone passes 50k in the first
// 30s), so milestones start above that: each one marks a real power spike.
const LAND_MILESTONES = [100000, 250000, 500000, 1000000];
const ALIVE_CALLOUTS = {
  10: ['10 remain', 'The map is getting crowded'],
  5: ['Final 5', 'Every border is a front line'],
  3: ['Final 3', 'One mistake ends it'],
  2: ['Showdown', 'One rival left — finish it'],
};

let quitFn = () => location.reload();
let match = freshMatch();

function freshMatch() {
  return {
    active: false,
    settled: false,
    startedAt: 0,
    total: 0,
    alive: 0,
    eliminations: 0,
    towers: 0,
    missiles: 0,
    peakCells: 0,
    tookLead: false,
    firstBlood: false,
    // rank tracking (debounced so a flickering score doesn't spam banners)
    candidateRank: 0,
    candidateSince: 0,
    stableRank: 0,
    lastRankEval: 0,
    // under-attack detection
    cellSamples: [],
    lastSampleAt: 0,
    lastAlarmAt: 0,
    lastInboundAt: 0,
    // one-shot hints / milestones
    landMilestoneIdx: 0,
    hintedTower: false,
    hintedSilo: false,
    result: null,
  };
}

const myFid = () => parseInt(state.playerFaction) || 0;

function factionName(fid) {
  if (fid === myFid()) return 'You';
  const slot = state.activePlayerSlots ? state.activePlayerSlots[fid] : null;
  return slot && slot.nickname ? slot.nickname : `Player ${fid}`;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Announcer banner ─────────────────────────────────────────────────────────
const bannerQueue = [];
let bannerBusy = false;

function ensureFeelDom() {
  const area = document.getElementById('gameArea');
  if (!area || document.getElementById('announceBanner')) return;
  area.insertAdjacentHTML('beforeend', `
    <div id="dangerVignette"></div>
    <div id="announceBanner"><div class="ann-title"></div><div class="ann-sub"></div></div>
    <div id="spectateBar" style="display:none;">
      <span class="spectate-label">👁 Spectating</span>
      <button id="btnSpectateResults" class="feel-btn feel-btn-ghost">Results</button>
      <button id="btnSpectatePlayAgain" class="feel-btn feel-btn-primary">Play Again</button>
    </div>`);
  document.getElementById('btnSpectatePlayAgain').onclick = playAgain;
  document.getElementById('btnSpectateResults').onclick = () => {
    if (match.result) showEndScreen(match.result, { final: false });
  };
}

function announce(title, sub = '', tone = 'gold', sfx = null) {
  bannerQueue.push({ title, sub, tone, sfx });
  if (bannerQueue.length > 4) bannerQueue.splice(0, bannerQueue.length - 4);
  if (!bannerBusy) nextBanner();
}

function nextBanner() {
  const item = bannerQueue.shift();
  const el = document.getElementById('announceBanner');
  if (!item || !el) { bannerBusy = false; return; }
  bannerBusy = true;
  el.querySelector('.ann-title').textContent = item.title;
  el.querySelector('.ann-sub').textContent = item.sub;
  el.className = `tone-${item.tone}`;
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('show');
  if (item.sfx) playSfx(item.sfx);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(nextBanner, 250);
  }, 2100);
}

function flashDanger() {
  const v = document.getElementById('dangerVignette');
  if (!v) return;
  v.classList.remove('on');
  void v.offsetWidth;
  v.classList.add('on');
}

function shakeScreen() {
  if (state.lowGraphics) return;
  const c = document.getElementById('canvasContainer');
  if (!c) return;
  c.classList.remove('shake');
  void c.offsetWidth;
  c.classList.add('shake');
  setTimeout(() => c.classList.remove('shake'), 400);
}

function isOnScreen(row, col) {
  const r = window.renderer;
  if (!r) return false;
  const p = r.worldToScreen(col, row);
  return p.x >= 0 && p.y >= 0 && p.x <= window.innerWidth && p.y <= window.innerHeight;
}

// ── Match lifecycle ──────────────────────────────────────────────────────────
function beginMatch() {
  ensureFeelDom();
  document.body.classList.add('in-match');
  match = freshMatch();
  match.active = true;
  match.startedAt = performance.now();
  match.total = Object.values(state.activePlayerSlots || {}).filter(Boolean).length;
  match.alive = match.total;
  state.isSpectating = false;
  const bar = document.getElementById('spectateBar');
  if (bar) bar.style.display = 'none';
  const old = document.getElementById('matchEndOverlay');
  if (old) old.remove();
}

function playAgain() {
  try { sessionStorage.setItem(AUTO_QUICK_PLAY_KEY, '1'); } catch (_) { /* storage blocked */ }
  quitFn();
}

// True once per page load if the previous page asked for an instant requeue.
export function consumeAutoQuickPlay() {
  try {
    if (sessionStorage.getItem(AUTO_QUICK_PLAY_KEY) === '1') {
      sessionStorage.removeItem(AUTO_QUICK_PLAY_KEY);
      return true;
    }
  } catch (_) { /* storage blocked */ }
  return false;
}

// Lock in the result exactly once (own elimination or game over, whichever
// comes first), award XP, and show the recap.
function settle({ won, placement, survivedSec, killerId = 0, final = false, winner = null }) {
  if (match.settled) return;
  match.settled = true;

  const elapsed = (performance.now() - match.startedAt) / 1000;
  const total = Math.max(2, match.total || 2);
  const outcome = {
    won,
    placement: Math.min(total, Math.max(1, placement || total)),
    totalPlayers: total,
    eliminations: match.eliminations,
    peakCells: match.peakCells,
    survivedSec: Math.round(survivedSec ?? elapsed),
    towers: match.towers,
    missiles: match.missiles,
    tookLead: match.tookLead,
  };
  const progress = applyMatchResult(outcome);
  match.result = { ...outcome, killerName: killerId ? factionName(killerId) : '', progress };

  state.activePurchaseMode = null;
  playSfx(won ? 'victory' : 'defeat');
  showEndScreen(match.result, { final, winner, animate: true });
}

function enterSpectate() {
  const overlay = document.getElementById('matchEndOverlay');
  if (overlay) overlay.remove();
  state.isSpectating = true;
  for (const id of ['gameHUD', 'gameEconomyHUD']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  const bar = document.getElementById('spectateBar');
  if (bar) bar.style.display = 'flex';
}

function showEndScreen(result, { final = false, winner = null, animate = false } = {}) {
  const container = document.getElementById('gameArea') || document.body;
  const old = document.getElementById('matchEndOverlay');
  if (old) old.remove();

  // If we already lost and are spectating, the final whistle just reports the winner.
  const spectatorFinal = final && !animate;
  let title, tone, sub;
  if (result.won) {
    title = 'Victory'; tone = 'win'; sub = 'The map is yours, Commander.';
  } else if (spectatorFinal) {
    title = 'Match over'; tone = 'lose';
    sub = winner ? `${factionName(winner)} conquered the map.` : 'The war has ended.';
  } else {
    title = final ? 'Defeat' : 'Eliminated'; tone = 'lose';
    sub = result.killerName ? `Your empire fell to ${result.killerName}.` : 'Your empire has fallen.';
  }

  const p = result.progress;
  const xpLines = p.lines.map(l => `
    <div class="end-xp-line"><span>${escapeHtml(l.label)}</span><span>+${l.xp}</span></div>`).join('');
  const missions = p.missions.map(m => `
    <div class="pc-mission ${m.done ? 'done' : ''}">
      <span class="pc-mission-check">${m.done ? '✔' : '○'}</span>
      <span class="pc-mission-text">${escapeHtml(m.text)}</span>
      <span class="pc-mission-xp">+${m.xp} XP</span>
    </div>`).join('');

  const overlay = document.createElement('div');
  overlay.id = 'matchEndOverlay';
  overlay.className = `end-${tone}`;
  overlay.innerHTML = `
    <div class="end-card">
      <div class="end-title">${title}</div>
      <div class="end-sub">${escapeHtml(sub)}</div>

      <div class="end-placement">
        <span class="end-placement-rank">#${result.placement}</span>
        <span class="end-placement-of">of ${result.totalPlayers}</span>
      </div>

      <div class="end-stats">
        <div class="end-stat"><b>${result.eliminations}</b><span>Eliminations</span></div>
        <div class="end-stat"><b>${result.peakCells.toLocaleString()}</b><span>Peak land</span></div>
        <div class="end-stat"><b>${fmtTime(result.survivedSec)}</b><span>Survived</span></div>
        <div class="end-stat"><b>${result.missiles}</b><span>Missiles</span></div>
      </div>

      <div class="end-xp">
        ${xpLines}
        <div class="end-xp-line end-xp-total"><span>Total</span><span>+${p.totalXp} XP</span></div>
      </div>

      <div class="end-level">
        <div class="end-level-row">
          <span id="endLevelLabel">Level ${p.before.level} · ${p.before.title}</span>
          <span id="endLevelUp" class="end-level-up" style="visibility:hidden;">LEVEL UP!</span>
        </div>
        <div class="pc-bar"><div id="endLevelFill" class="pc-bar-fill" style="width:${animate ? p.before.pct : p.after.pct}%"></div></div>
      </div>

      <div class="end-missions">
        <div class="pc-missions-label">Daily missions</div>
        ${missions}
      </div>

      <div class="end-buttons">
        <button id="btnEndPlayAgain" class="feel-btn feel-btn-primary feel-btn-big">Play Again <kbd>Enter</kbd></button>
        ${final ? '' : '<button id="btnEndSpectate" class="feel-btn feel-btn-ghost">Spectate</button>'}
        <button id="btnEndMenu" class="feel-btn feel-btn-ghost">Main Menu</button>
      </div>
    </div>`;
  container.appendChild(overlay);

  overlay.querySelector('#btnEndPlayAgain').onclick = playAgain;
  overlay.querySelector('#btnEndMenu').onclick = () => quitFn();
  const btnSpectate = overlay.querySelector('#btnEndSpectate');
  if (btnSpectate) btnSpectate.onclick = enterSpectate;

  const setLevelLabel = (info) => {
    const lbl = document.getElementById('endLevelLabel');
    if (lbl) lbl.textContent = `Level ${info.level} · ${info.title}`;
  };

  if (!animate) { setLevelLabel(p.after); return; }

  // Animate the XP bar: fill, and on a level-up roll over into the new level.
  const fill = () => document.getElementById('endLevelFill');
  setTimeout(() => {
    const bar = fill();
    if (!bar) return;
    if (!p.leveledUp) { bar.style.width = `${p.after.pct}%`; return; }
    bar.style.width = '100%';
    setTimeout(() => {
      const bar2 = fill();
      if (!bar2) return;
      bar2.style.transition = 'none';
      bar2.style.width = '0%';
      void bar2.offsetWidth;
      bar2.style.transition = '';
      bar2.style.width = `${p.after.pct}%`;
      setLevelLabel(p.after);
      const up = document.getElementById('endLevelUp');
      if (up) up.style.visibility = 'visible';
      playSfx('levelUp');
    }, 900);
  }, 500);
}

// ── Per-snapshot stats (called from network.js) ──────────────────────────────
// stats: { cells, gold, rank, alive, leaderFid }
export function onSnapshotStats({ cells, gold, rank, alive, leaderFid }) {
  if (!match.active || match.settled) return;
  const now = performance.now();
  match.alive = alive;
  if (cells > match.peakCells) match.peakCells = cells;

  // Rank chip in the leaderboard header.
  const chip = document.getElementById('lblMyRank');
  if (chip) chip.textContent = rank > 0 ? `#${rank} · ${alive} alive` : `${alive} alive`;

  // Under attack: land fell sharply over the last ~2 seconds.
  if (now - match.lastSampleAt >= 500) {
    match.lastSampleAt = now;
    match.cellSamples.push({ t: now, cells });
    while (match.cellSamples.length && now - match.cellSamples[0].t > 2500) match.cellSamples.shift();
    const oldest = match.cellSamples[0];
    if (oldest && now - oldest.t >= 1500) {
      const drop = oldest.cells - cells;
      // Measured: an empire in full collapse loses ~2% of its land per 2s, and
      // ordinary border skirmishing nets out near zero — so 1% is a real push.
      if (drop >= Math.max(150, oldest.cells * 0.01) && now - match.lastAlarmAt > 12000) {
        match.lastAlarmAt = now;
        flashDanger();
        announce('Under attack', 'Your borders are collapsing — reinforce or counter', 'red', 'alarm');
      }
    }
  }

  // Rank changes, debounced: a rank must hold for 3s before it counts.
  if (now - match.lastRankEval >= 1000 && now - match.startedAt > 20000 && rank > 0) {
    match.lastRankEval = now;
    if (rank !== match.candidateRank) {
      match.candidateRank = rank;
      match.candidateSince = now;
    } else if (rank !== match.stableRank && now - match.candidateSince >= 3000) {
      const prev = match.stableRank;
      match.stableRank = rank;
      if (prev) {
        if (rank === 1) {
          match.tookLead = true;
          announce('You took the lead', 'Everyone is coming for you now', 'gold', 'rankUp');
        } else if (rank <= 3 && prev > 3) {
          announce('Top 3', `You climbed to #${rank}`, 'gold', 'rankUp');
        } else if (prev === 1 && rank > 1) {
          announce('Lead lost', `${factionName(leaderFid)} is now #1`, 'red', 'fallen');
        }
      } else if (rank === 1) {
        match.tookLead = true;
      }
    }
  }

  // Land milestones.
  while (match.landMilestoneIdx < LAND_MILESTONES.length && cells >= LAND_MILESTONES[match.landMilestoneIdx]) {
    const reached = LAND_MILESTONES[match.landMilestoneIdx++];
    if (cells < (LAND_MILESTONES[match.landMilestoneIdx] ?? Infinity)) {
      showToast(`🏴 ${reached.toLocaleString()} land — your empire is growing`, 'success');
      playSfx('milestone');
    }
  }

  // One-time nudges toward the build menu, the moment each option is affordable.
  if (!match.hintedTower && gold >= DEFENSE_BUILDING_COST) {
    match.hintedTower = true;
    if (match.towers === 0) showToast('💰 You can afford a Defense Tower — press 3 and click your land', 'info');
  }
  if (!match.hintedSilo && gold >= SILO_BUILDING_COST) {
    match.hintedSilo = true;
    showToast('🚀 Missile Silo affordable — press 4 to build, then 2 to fire', 'info');
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────
export function initMatchFeel({ socket, quit }) {
  if (quit) quitFn = quit;

  // From the first in-match screen on, toasts move to the bottom-right corner
  // (see feel.css) so they never cover the leaderboard. Cleared by the page
  // reload that every exit path goes through.
  socket.on('spawn-selection-start', () => document.body.classList.add('in-match'));

  socket.on('spawn-timer', (ticks) => {
    if (ticks > 0 && ticks <= 3) playSfx('tick');
  });

  socket.on('start-match-now', () => {
    beginMatch();
    announce('Conquer the map', `${match.total} commanders · click land to expand`, 'gold', 'go');
  });

  // A page reload mid-match skips start-match-now; pick the match up from here.
  socket.on('reconnect-success', () => {
    if (!match.active) beginMatch();
  });

  socket.on('player-eliminated', (p = {}) => {
    if (!match.active) return;
    const me = myFid();
    const aliveNow = typeof p.aliveCount === 'number' ? p.aliveCount : Math.max(1, match.alive - 1);

    if (p.factionId === me) {
      settle({ won: false, placement: p.placement || aliveNow + 1, survivedSec: p.survivedSec, killerId: p.killerId });
      return;
    }
    if (match.settled) return; // spectating — the kill feed is enough

    const name = factionName(p.factionId);
    if (p.killerId === me) {
      match.eliminations++;
      announce(`${name} eliminated`, 'You wiped them off the map · +40 XP', 'green', 'kill');
    } else {
      playSfx('fallen');
      if (!match.firstBlood) announce('First blood', `${name} has fallen`, 'red');
    }
    match.firstBlood = true;

    const callout = ALIVE_CALLOUTS[aliveNow];
    if (callout) announce(callout[0], callout[1], 'gold');
  });

  socket.on('game-over', ({ winner, stats } = {}) => {
    const me = myFid();
    state.gameState = 'END_GAME';
    const bar = document.getElementById('spectateBar');
    if (bar) bar.style.display = 'none';

    if (match.settled && match.result) {
      // Already eliminated earlier: just report how the war ended.
      showEndScreen(match.result, { final: true, winner });
      return;
    }
    if (!match.active) { ensureFeelDom(); match.active = true; match.startedAt = performance.now(); }

    const sameGuildTeam = state.isGuildWar && winner && state.teamSize > 0
      && (winner <= state.teamSize) === (me <= state.teamSize);
    const won = winner === me || !!sameGuildTeam;
    const mine = stats ? stats[me] : null;
    settle({
      won,
      placement: won ? 1 : ((mine && mine.placement) || Math.max(2, match.alive)),
      survivedSec: mine ? mine.survivedSec : undefined,
      final: true,
      winner,
    });
  });

  socket.on('building-placed', (b = {}) => {
    if (!match.active || b.factionId !== myFid()) return;
    playSfx('build');
    if (b.type === 'defense') match.towers++;
  });

  socket.on('building-completed', (b = {}) => {
    if (match.active && b.factionId === myFid()) playSfx('complete');
  });

  socket.on('build-rejected', () => playSfx('error'));

  socket.on('missile-intercepted', () => playSfx('intercept'));

  socket.on('missile-fired', ({ sourceRow, sourceCol, targetRow, targetCol, factionId } = {}) => {
    if (!match.active) return;
    const me = myFid();
    if (factionId === me) {
      match.missiles++;
      playSfx('launch');
    } else if (!match.settled && getCellOwner(targetRow * 1920 + targetCol) === me) {
      const now = performance.now();
      if (now - match.lastInboundAt > 5000) {
        match.lastInboundAt = now;
        flashDanger();
        announce('Missile inbound', `${factionName(factionId)} fired on your territory`, 'red', 'alarm');
      }
    }

    // network.js (registered first) has already queued this missile; watch it so
    // the impact sound and shake are skipped if anti-air shoots it down.
    const missile = [...state.activeMissiles].reverse().find(m =>
      m.sourceRow === sourceRow && m.sourceCol === sourceCol
      && m.targetRow === targetRow && m.targetCol === targetCol);
    const flightMs = missile ? missile.flightTimeMs : 0;
    setTimeout(() => {
      if (missile && missile.intercepted) return;
      if (isOnScreen(targetRow, targetCol)) {
        playSfx('boom');
        shakeScreen();
      } else {
        playSfx('boomFar');
      }
    }, flightMs);
  });

  // Enter = instant requeue from the recap screen.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.getElementById('matchEndOverlay')) {
      e.preventDefault();
      playAgain();
    }
  });
}
