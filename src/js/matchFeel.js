// "Game feel" layer: everything that makes a match read as an event rather than
// a spreadsheet — announcer banners, sound cues, under-attack warnings, rank
// tracking, the end-of-match recap (placement, XP, missions) and the
// spectate / play-again flow. Purely presentational: it listens to the same
// socket events as network.js and never sends game inputs.

import { state } from './state.js';
import { playSfx } from './sfx.js';
import { applyMatchResult, loadProfile, isServerMode, setServerProfile, renderProgressCards } from './progression.js';
import { escapeHtml } from './escape.js';
import { showToast } from './guildUI.js';
import { getCellOwner } from './simBridge.js';
import { DEFENSE_BUILDING_COST, SILO_BUILDING_COST } from './constants.js';

const AUTO_QUICK_PLAY_KEY = 'ow_auto_quick_play';
// A fair share of a 20-player map is ~63k land (everyone passes 50k in the first
// 30s), so milestones start above that: each one marks a real power spike.
// Bigger rooms have a smaller fair share, so the milestones scale with it.
const LAND_MILESTONES_20 = [100000, 250000, 500000, 1000000];
const landMilestones = () => {
  const scale = Math.min(1, 20 / Math.max(1, match.total || 20));
  return LAND_MILESTONES_20.map(m => Math.round(m * scale / 5000) * 5000);
};
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
    bountyFid: 0,
    bountyAnnouncedAt: {},
    // Logged-in players: the server's XP result (progression-result), and the
    // options the recap was last shown with, so it can be re-rendered.
    pendingProgress: null,
    endOpts: null,
    bountyEarnedShown: 0,
    lastBountyToastAt: 0,
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
    // domination (hold a share of all land to win)
    dominationShare: 0,
    dominationWarnedFid: 0,
    suddenDeath: false,
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
    <div id="controlsHint" style="display:none;">
      <span><kbd>Click</kbd> attack / expand</span>
      <span><kbd>Right-click</kbd> cancel attack</span>
      <span><kbd>Space</kbd> recall all</span>
      <span><kbd>1</kbd> Blitz</span>
      <span><kbd>Drag</kbd> or <kbd>WASD</kbd> move</span>
      <span><kbd>Wheel</kbd> zoom</span>
      <span><kbd>Shift</kbd>+<kbd>Wheel</kbd> attack %</span>
    </div>
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

// Bounty on a runaway leader: announce when it is placed (on you or a rival)
// and show what you have earned from it, at most every few seconds.
function announceBounty(bountyFid, earned) {
  if (!match.active || match.settled) return;
  const me = myFid();
  if (bountyFid !== match.bountyFid) {
    match.bountyFid = bountyFid;
    // Rivals gang up fast, so a bounty can lapse and return within seconds:
    // announce the same target at most once every 30 s.
    const now = performance.now();
    const last = match.bountyAnnouncedAt[bountyFid] || 0;
    if (!bountyFid || now - last < 30000) return;
    match.bountyAnnouncedAt[bountyFid] = now;
    if (bountyFid === me) {
      announce('Bounty on your head', 'Rivals pay less to take your land and earn gold for it', 'red', 'alarm');
    } else if (bountyFid) {
      announce(`Bounty on ${factionName(bountyFid)}`, 'Their land is 25% cheaper to take and pays gold', 'gold', 'go');
    }
  }
  const now = performance.now();
  const gain = earned - (match.bountyEarnedShown || 0);
  if (gain >= 250 && now - (match.lastBountyToastAt || 0) > 4000) {
    match.bountyEarnedShown = earned;
    match.lastBountyToastAt = now;
    showToast(`Bounty +${Math.floor(gain).toLocaleString('en-US')} gold`, 'success');
  }
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

  // New commanders get the controls on screen for the opening of the match.
  const hint = document.getElementById('controlsHint');
  if (hint) {
    const isNew = (loadProfile()?.games ?? 0) < 3;
    hint.style.display = isNew ? 'flex' : 'none';
    if (isNew) setTimeout(() => { hint.style.display = 'none'; }, 30000);
  }
}

function playAgain() {
  // Remember which queue (standard / mega) to rejoin after the reload.
  try { sessionStorage.setItem(AUTO_QUICK_PLAY_KEY, state.quickMode === 'mega' ? 'mega' : 'standard'); } catch (_) { /* storage blocked */ }
  quitFn();
}

// The Quick Battle mode to rejoin ('standard' | 'mega'), once per page load,
// if the previous page asked for an instant requeue; otherwise null.
export function consumeAutoQuickPlay() {
  try {
    const mode = sessionStorage.getItem(AUTO_QUICK_PLAY_KEY);
    if (mode) {
      sessionStorage.removeItem(AUTO_QUICK_PLAY_KEY);
      return mode === 'mega' ? 'mega' : 'standard'; // '1' from older pages = standard
    }
  } catch (_) { /* storage blocked */ }
  return null;
}

// Lock in the result exactly once (own elimination or game over, whichever
// comes first), award XP, and show the recap.
function settle({ won, placement, survivedSec, killerId = 0, final = false, winner = null, byDomination = false }) {
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
  // Guests score in the browser; a logged-in player's XP is scored by the
  // server, which sends it as `progression-result` (possibly already here).
  const progress = isServerMode() ? match.pendingProgress : applyMatchResult(outcome);
  match.result = { ...outcome, killerName: killerId ? factionName(killerId) : '', progress };

  state.activePurchaseMode = null;
  playSfx(won ? 'victory' : 'defeat');
  showEndScreen(match.result, { final, winner, animate: true, byDomination });
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
  const hint = document.getElementById('controlsHint');
  if (hint) hint.style.display = 'none';
}

function showEndScreen(result, { final = false, winner = null, animate = false, byDomination = false } = {}) {
  match.endOpts = { final, winner, byDomination };
  const container = document.getElementById('gameArea') || document.body;
  const old = document.getElementById('matchEndOverlay');
  if (old) old.remove();

  // If we already lost and are spectating, the final whistle just reports the winner.
  const spectatorFinal = final && !animate;
  let title, tone, sub;
  const how = byDomination ? 'dominated' : 'conquered';
  if (result.won) {
    title = 'Victory'; tone = 'win';
    sub = byDomination ? 'You dominated the map, Commander.' : 'The map is yours, Commander.';
  } else if (spectatorFinal) {
    title = 'Match over'; tone = 'lose';
    sub = winner ? `${factionName(winner)} ${how} the map.` : 'The war has ended.';
  } else if (final) {
    title = 'Defeat'; tone = 'lose';
    sub = winner ? `${factionName(winner)} ${how} the map.` : 'The war has ended.';
  } else {
    title = 'Eliminated'; tone = 'lose';
    sub = result.killerName ? `Your empire fell to ${result.killerName}.` : 'Your empire has fallen.';
  }

  // A logged-in player's XP is scored by the server: until progression-result
  // arrives (normally within a moment) the XP part of the card is a placeholder.
  const p = result.progress;
  const xpLines = p ? p.lines.map(l => `
    <div class="end-xp-line"><span>${escapeHtml(l.label)}</span><span>+${l.xp}</span></div>`).join('') : '';
  const missions = p ? p.missions.map(m => `
    <div class="pc-mission ${m.done ? 'done' : ''}">
      <span class="pc-mission-check">${m.done ? '✔' : '○'}</span>
      <span class="pc-mission-text">${escapeHtml(m.text)}</span>
      <span class="pc-mission-xp">+${m.xp} XP</span>
    </div>`).join('') : '';
  const progressHtml = p ? `
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
      </div>` : `
      <div class="end-xp end-xp-pending" id="endXpPending">Saving XP to your account…</div>`;

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

${progressHtml}

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

  if (!p) {
    // If the server's result never comes (connection trouble), say where the
    // XP went rather than leave "saving…" up forever.
    setTimeout(() => {
      const box = document.getElementById('endXpPending');
      if (box) box.textContent = 'Your XP is saved to your account and will show on your profile.';
    }, 10000);
    return;
  }
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
// stats: { cells, gold, rank, alive, leaderFid, landCells, dominationShare,
//          landLeaderFid, landLeaderCells }
export function onSnapshotStats({ cells, gold, rank, alive, leaderFid, landCells = 0, dominationShare = 0, landLeaderFid = 0, landLeaderCells = 0, bountyFid = 0, bountyEarned = 0 }) {
  announceBounty(bountyFid, bountyEarned);
  if (!match.active || match.settled) return;
  const now = performance.now();
  match.alive = alive;
  // The domination target shrinks late in the match; call out each drop.
  if (match.dominationShare > 0 && dominationShare > 0 && dominationShare < match.dominationShare - 0.001) {
    const goal = Math.round(dominationShare * 100);
    if (!match.suddenDeath) {
      match.suddenDeath = true;
      announce('Sudden death', `The domination target is falling — ${goal}% of the land wins now`, 'red', 'alarm');
    } else {
      playSfx('tick');
    }
    const line = document.getElementById('lblDomination');
    if (line) {
      line.classList.remove('pulse');
      void line.offsetWidth;
      line.classList.add('pulse');
    }
  }
  match.dominationShare = dominationShare;
  if (cells > match.peakCells) match.peakCells = cells;

  // Rank chip in the leaderboard header.
  const chip = document.getElementById('lblMyRank');
  if (chip) chip.textContent = rank > 0 ? `#${rank} · ${alive} alive` : `${alive} alive`;

  // Domination race: your share and the biggest empire's share of all land,
  // against the share that wins outright.
  const dom = document.getElementById('lblDomination');
  if (dom) {
    if (landCells > 0 && dominationShare > 0) {
      const pct = (n) => Math.floor((n / landCells) * 100);
      const goal = Math.round(dominationShare * 100);
      const me = myFid();
      dom.textContent = landLeaderFid === me
        ? `You hold ${pct(cells)}% · ${goal}% wins`
        : `You ${pct(cells)}% · Top ${pct(landLeaderCells)}% · ${goal}% wins`;
      dom.classList.toggle('danger', landLeaderFid !== me && landLeaderCells / landCells >= dominationShare - 0.15);

      // One warning per contender once they are within 15 points of winning.
      if (landLeaderFid && landLeaderCells / landCells >= dominationShare - 0.15
          && match.dominationWarnedFid !== landLeaderFid) {
        match.dominationWarnedFid = landLeaderFid;
        if (landLeaderFid === me) {
          announce('Domination in reach', `Hold ${goal}% of the land to win the war`, 'gold', 'rankUp');
        } else {
          flashDanger();
          announce(`${factionName(landLeaderFid)} nears domination`, `They win at ${goal}% of the land — cut them down`, 'red', 'alarm');
        }
      }
    } else {
      dom.textContent = '';
    }
  }

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
  const milestones = landMilestones();
  while (match.landMilestoneIdx < milestones.length && cells >= milestones[match.landMilestoneIdx]) {
    const reached = milestones[match.landMilestoneIdx++];
    if (cells < (milestones[match.landMilestoneIdx] ?? Infinity)) {
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
    announce('Conquer the map', `${match.total} commanders · hold most of the land or be the last standing`, 'gold', 'go');
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

  socket.on('game-over', ({ winner, stats, byDomination } = {}) => {
    const me = myFid();
    state.gameState = 'END_GAME';
    const bar = document.getElementById('spectateBar');
    if (bar) bar.style.display = 'none';

    if (match.settled && match.result) {
      // Already eliminated earlier: just report how the war ended.
      showEndScreen(match.result, { final: true, winner, byDomination });
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
      byDomination,
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

  // A logged-in player's XP for this match, scored and saved by the server.
  socket.on('progression-result', (result = {}) => {
    if (result.profile) { setServerProfile(result.profile); renderProgressCards(); }
    if (!match.result) { match.pendingProgress = result; return; }
    if (match.result.progress) return;
    match.result.progress = result;
    // Fill the recap in place if it is on screen (not while spectating).
    if (document.getElementById('matchEndOverlay')) {
      showEndScreen(match.result, { ...match.endOpts, animate: true });
    }
  });

  socket.on('gold-seized', ({ toId, gold, kind } = {}) => {
    if (!match.active || toId !== myFid()) return;
    if (kind === 'plunder') {
      announce(`Plunder +${Math.floor(gold).toLocaleString('en-US')} gold`, 'You took their whole treasury', 'gold', 'complete');
    } else {
      showToast(`Salvage +${Math.floor(gold).toLocaleString('en-US')} gold from a razed tower`, 'success');
    }
  });

  socket.on('blitz-started', ({ factionId } = {}) => {
    if (match.active && factionId === myFid()) announce('Blitz!', 'Your fronts surge for 6 seconds', 'gold', 'go');
  });

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
