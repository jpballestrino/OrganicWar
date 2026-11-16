// Persistent commander progression: XP, levels, rank titles, day streak and
// three daily missions. Stored in localStorage so it works for guests too — it
// is a motivation layer only and never affects the authoritative simulation.

const KEY = 'ow_profile_v1';

const RANKS = [
  [1, 'Recruit'], [3, 'Private'], [6, 'Sergeant'], [10, 'Lieutenant'], [15, 'Captain'],
  [20, 'Major'], [27, 'Colonel'], [35, 'General'], [45, 'Warlord'], [60, 'Emperor'],
];

// kind 'sum': progress accumulates across the day's matches.
// kind 'max': the goal must be reached within a single match.
// kind 'atMost': the stat must be at or below the goal in a single match.
const MISSION_POOL = [
  { id: 'play3',    text: 'Play 3 battles',                 stat: 'games',        kind: 'sum',    goal: 3,     xp: 90 },
  { id: 'elim1',    text: 'Eliminate a rival',              stat: 'eliminations', kind: 'sum',    goal: 1,     xp: 80 },
  { id: 'elim3',    text: 'Eliminate 3 rivals',             stat: 'eliminations', kind: 'sum',    goal: 3,     xp: 160 },
  { id: 'top5',     text: 'Finish in the top 5',            stat: 'placement',    kind: 'atMost', goal: 5,     xp: 100 },
  { id: 'top3',     text: 'Finish in the top 3',            stat: 'placement',    kind: 'atMost', goal: 3,     xp: 150 },
  { id: 'win',      text: 'Win a battle',                   stat: 'wins',         kind: 'sum',    goal: 1,     xp: 250 },
  { id: 'towers3',  text: 'Build 3 Defense Towers',         stat: 'towers',       kind: 'sum',    goal: 3,     xp: 60 },
  { id: 'missile2', text: 'Fire 2 missiles',                stat: 'missiles',     kind: 'sum',    goal: 2,     xp: 110 },
  { id: 'land25k',  text: 'Hold 25,000 land in one battle', stat: 'peakCells',    kind: 'max',    goal: 25000, xp: 100 },
  { id: 'survive5', text: 'Survive 5 minutes in a battle',  stat: 'survivedSec',  kind: 'max',    goal: 300,   xp: 60 },
  { id: 'lead',     text: 'Hold 1st place during a battle', stat: 'tookLead',     kind: 'sum',    goal: 1,     xp: 120 },
];

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Total XP needed to *reach* a level: 0, 100, 300, 600, 1000 …
export function xpForLevel(level) { return 50 * level * (level - 1); }

export function levelFromXp(xp) {
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * Math.max(0, xp)) / 50)) / 2));
}

export function rankTitle(level) {
  let title = RANKS[0][1];
  for (const [minLevel, name] of RANKS) { if (level >= minLevel) title = name; }
  return title;
}

// Level, title and progress through the current level for a given XP total.
export function levelInfo(xp) {
  const level = levelFromXp(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return {
    level,
    title: rankTitle(level),
    into: xp - base,
    span: next - base,
    pct: Math.min(100, Math.round(((xp - base) / (next - base)) * 100)),
  };
}

function defaultProfile() {
  return {
    xp: 0, games: 0, wins: 0, eliminations: 0, bestPlacement: 0,
    lastPlayDay: '', dayStreak: 0,
    missionDay: '', missions: [],
  };
}

// Deterministic per-day pick so the three missions are stable across reloads.
function pickMissions(day) {
  let seed = 0;
  for (const ch of day) { seed = (seed * 31 + ch.charCodeAt(0)) >>> 0; }
  const pool = MISSION_POOL.slice();
  const picked = [];
  while (picked.length < 3 && pool.length) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const m = pool.splice(seed % pool.length, 1)[0];
    // Avoid two missions tracking the same stat (e.g. top 5 and top 3).
    if (picked.some(p => p.stat === m.stat)) continue;
    picked.push(m);
  }
  return picked.map(m => ({ id: m.id, progress: 0, done: false }));
}

function save(profile) {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch (_) { /* storage blocked */ }
}

export function loadProfile() {
  let profile = defaultProfile();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) profile = { ...profile, ...JSON.parse(raw) };
  } catch (_) { /* corrupt or blocked storage — start fresh */ }
  if (!Array.isArray(profile.missions)) profile.missions = [];

  const today = todayKey();
  if (profile.missionDay !== today) {
    profile.missionDay = today;
    profile.missions = pickMissions(today);
    save(profile);
  }
  return profile;
}

// Missions joined with their static definitions, for rendering.
export function missionViews(profile) {
  return profile.missions
    .map(m => {
      const def = MISSION_POOL.find(d => d.id === m.id);
      return def ? { ...def, progress: m.progress, done: m.done } : null;
    })
    .filter(Boolean);
}

/**
 * Apply one finished match to the profile.
 * match: { placement, totalPlayers, won, eliminations, peakCells, survivedSec,
 *          towers, missiles, tookLead }
 * Returns { lines: [{label, xp}], totalXp, before, after, leveledUp, missions, profile }.
 */
export function applyMatchResult(match) {
  const profile = loadProfile();
  const before = levelInfo(profile.xp);
  const lines = [];
  const add = (label, xp) => { if (xp > 0) lines.push({ label, xp: Math.round(xp) }); };

  const total = Math.max(2, match.totalPlayers || 2);
  const placement = Math.min(total, Math.max(1, match.placement || total));

  add('Battle fought', 20);
  add(`Placed #${placement} of ${total}`, ((total - placement) / (total - 1)) * 100);
  if (match.won) add('Victory', 150);
  add(`Eliminations ×${match.eliminations || 0}`, (match.eliminations || 0) * 40);
  add('Territory held', Math.min(80, (match.peakCells || 0) / 1500));
  add('Time survived', Math.min(40, ((match.survivedSec || 0) / 60) * 4));

  // Day streak: consecutive calendar days with at least one battle.
  const today = todayKey();
  if (profile.lastPlayDay !== today) {
    const yesterday = todayKey(new Date(Date.now() - 86400000));
    profile.dayStreak = profile.lastPlayDay === yesterday ? profile.dayStreak + 1 : 1;
    profile.lastPlayDay = today;
    add('First battle of the day', 50);
    if (profile.dayStreak > 1) add(`${profile.dayStreak}-day streak`, Math.min(50, profile.dayStreak * 10));
  }

  // Daily missions.
  const stats = {
    games: 1,
    wins: match.won ? 1 : 0,
    eliminations: match.eliminations || 0,
    placement,
    towers: match.towers || 0,
    missiles: match.missiles || 0,
    peakCells: match.peakCells || 0,
    survivedSec: match.survivedSec || 0,
    tookLead: match.tookLead ? 1 : 0,
  };
  for (const m of profile.missions) {
    if (m.done) continue;
    const def = MISSION_POOL.find(d => d.id === m.id);
    if (!def) continue;
    const value = stats[def.stat] || 0;
    if (def.kind === 'sum') {
      m.progress = Math.min(def.goal, m.progress + value);
      m.done = m.progress >= def.goal;
    } else if (def.kind === 'max') {
      m.progress = Math.min(def.goal, Math.max(m.progress, value));
      m.done = m.progress >= def.goal;
    } else if (value <= def.goal) { // atMost
      m.progress = def.goal;
      m.done = true;
    }
    if (m.done) add(`Mission: ${def.text}`, def.xp);
  }

  const totalXp = lines.reduce((sum, l) => sum + l.xp, 0);
  profile.xp += totalXp;
  profile.games += 1;
  if (match.won) profile.wins += 1;
  profile.eliminations += match.eliminations || 0;
  if (!profile.bestPlacement || placement < profile.bestPlacement) profile.bestPlacement = placement;
  save(profile);

  const after = levelInfo(profile.xp);
  return {
    lines, totalXp, before, after,
    leveledUp: after.level > before.level,
    missions: missionViews(profile),
    profile,
  };
}

// Compact home-screen card: level, XP bar, day streak and today's missions.
export function progressCardHtml() {
  const profile = loadProfile();
  const info = levelInfo(profile.xp);
  const streakActive = profile.lastPlayDay === todayKey()
    || profile.lastPlayDay === todayKey(new Date(Date.now() - 86400000));
  const streak = streakActive ? profile.dayStreak : 0;

  const missions = missionViews(profile).map(m => {
    const shown = m.kind === 'atMost' ? (m.done ? 1 : 0) : m.progress;
    const goal = m.kind === 'atMost' ? 1 : m.goal;
    const count = goal > 1 && goal <= 20 ? ` <span class="pc-mission-count">${shown}/${goal}</span>` : '';
    return `
      <div class="pc-mission ${m.done ? 'done' : ''}">
        <span class="pc-mission-check">${m.done ? '✔' : '○'}</span>
        <span class="pc-mission-text">${m.text}${count}</span>
        <span class="pc-mission-xp">+${m.xp} XP</span>
      </div>`;
  }).join('');

  const record = profile.games > 0
    ? `${profile.games} battles · ${profile.wins} wins · best #${profile.bestPlacement || '—'}`
    : 'Fight your first battle to start earning XP';

  return `
    <div class="pc-head">
      <div class="pc-level">${info.level}</div>
      <div class="pc-head-main">
        <div class="pc-title-row">
          <span class="pc-title">${info.title}</span>
          ${streak > 0 ? `<span class="pc-streak" title="Consecutive days played">🔥 ${streak}</span>` : ''}
        </div>
        <div class="pc-bar"><div class="pc-bar-fill" style="width:${info.pct}%"></div></div>
        <div class="pc-sub">${info.into} / ${info.span} XP · ${record}</div>
      </div>
    </div>
    <div class="pc-missions-label">Daily missions</div>
    ${missions}`;
}

export function renderProgressCards() {
  const html = progressCardHtml();
  document.querySelectorAll('.progress-card').forEach(el => { el.innerHTML = html; });
}
