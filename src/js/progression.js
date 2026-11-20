// Persistent commander progression: XP, levels, rank titles, day streak and
// three daily missions. A motivation layer only — it never affects the sim.
//
// Two homes for the profile, one scoring rule:
//   * guests     — localStorage (`ow_profile_v1`), scored in the browser by
//                  applyMatchResult();
//   * logged in  — the server's `user_progression` table, scored on the server
//                  from its own match bookkeeping (server/game/progression.js)
//                  and pushed to the client (setServerProfile). The browser
//                  never computes or uploads a logged-in player's XP.
// The pure core (normalizeProfile / scoreMatch / dayKey) is imported by both,
// so XP and missions are identical wherever they are scored.

import { QUICK_PLAY_PLAYERS, MEGA_PLAY_PLAYERS, MAX_FACTIONS, MAP_SIZES } from './constants.js';

const MAX_PLAYERS_PER_MATCH = MAX_FACTIONS;

const KEY = 'ow_profile_v1';

// ── Room-size scaling ────────────────────────────────────────────────────────
// Everything below is calibrated for a standard 20-player battle. In a bigger
// room (Mega Battle: 64) each commander's share of the map is smaller and every
// placement is harder, so results are converted to their standard-battle
// equivalent before XP and missions are scored:
//   land      × scale   (a fair share of a 64-player map ≈ one of a 20-player map)
//   placement ÷ scale   (top 16 of 64 ≈ top 5 of 20)
//   victory   × scale   (beating 63 rivals is ~3× rarer than beating 19)
// Placement, elimination and survival XP need no scaling: placement XP is
// already a fraction of the field, and a match lasts as long either way.
const CALIBRATION_PLAYERS = QUICK_PLAY_PLAYERS;
export function fieldScale(totalPlayers) {
  return Math.max(1, (totalPlayers || CALIBRATION_PLAYERS) / CALIBRATION_PLAYERS);
}
// Land is also scaled by the map's size: Mega Battles play on a bigger map
// (MAP_SIZES.mega), so the same share of the land is more cells there.
const STANDARD_MAP_CELLS = MAP_SIZES.standard.width * MAP_SIZES.standard.height;
export function landScale(totalPlayers, mapCells = STANDARD_MAP_CELLS) {
  return fieldScale(totalPlayers) * STANDARD_MAP_CELLS / (mapCells || STANDARD_MAP_CELLS);
}
const VICTORY_XP = 150;

const RANKS = [
  [1, 'Recruit'], [3, 'Private'], [6, 'Sergeant'], [10, 'Lieutenant'], [15, 'Captain'],
  [20, 'Major'], [27, 'Colonel'], [35, 'General'], [45, 'Warlord'], [60, 'Emperor'],
];

// Goals and XP are calibrated against headless 20-bot matches (bigger rooms are
// converted to standard-battle equivalents — see "Room-size scaling" above) (Europe and North
// America, ~1.26M land cells): a fair share is ~63k land, the map is fully
// claimed within ~45s, half the field is gone by 1.5-5 min and a match lasts
// 7-10 min. So 150k land is roughly a top-5 empire and 3 minutes is roughly
// outliving half the lobby. Re-measure if map size, player count or pacing change.
//
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
  { id: 'land150k', text: 'Hold 150,000 land in one battle', stat: 'peakCells',   kind: 'max',    goal: 150000, xp: 120 },
  { id: 'survive3', text: 'Survive 3 minutes in a battle',  stat: 'survivedSec',  kind: 'max',    goal: 180,   xp: 60 },
  { id: 'lead',     text: 'Hold 1st place during a battle', stat: 'tookLead',     kind: 'sum',    goal: 1,     xp: 120 },
];

// Calendar day (YYYY-MM-DD) of `nowMs` for a player whose clock is
// `tzOffsetMin` minutes behind UTC (Date#getTimezoneOffset). Day streaks and
// daily missions follow the PLAYER's midnight, also when the server scores.
export function dayKey(nowMs = Date.now(), tzOffsetMin = new Date(nowMs).getTimezoneOffset()) {
  const d = new Date(nowMs - tzOffsetMin * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
const todayKey = () => dayKey();
const yesterdayKey = () => dayKey(Date.now() - 86400000);

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

export function defaultProfile() {
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

// Fill defaults and roll today's missions over if `day` is a new day. Pure:
// returns a new object. Used for profiles from localStorage and the server.
export function normalizeProfile(raw, day) {
  const profile = { ...defaultProfile(), ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!Array.isArray(profile.missions)) profile.missions = [];
  if (profile.missionDay !== day) {
    profile.missionDay = day;
    profile.missions = pickMissions(day);
  }
  return profile;
}

// ── Where the displayed profile comes from ───────────────────────────────────
// For a logged-in player the server pushes the profile (`progression-profile`)
// and match results (`progression-result`); until it arrives there is none.
let serverProfile = null;
let serverMode = false;

export function setServerMode(on) { serverMode = !!on; if (!on) serverProfile = null; }
export function isServerMode() { return serverMode; }
export function setServerProfile(profile) { serverProfile = profile; }

function save(profile) {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch (_) { /* storage blocked */ }
}

// The guest profile stored in this browser (normalized for today).
export function loadLocalProfile() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { /* corrupt or blocked */ }
  const profile = normalizeProfile(raw, todayKey());
  if (!raw || raw.missionDay !== profile.missionDay) save(profile);
  return profile;
}

// The profile to show: the server's for a logged-in player, else the local one.
export function loadProfile() {
  if (serverMode) return serverProfile ? normalizeProfile(serverProfile, todayKey()) : null;
  return loadLocalProfile();
}

// Sanity check for importing a browser's guest profile into an account the
// first time it logs in (the server has no profile for it yet). localStorage
// is editable, so anything a real player couldn't have earned is refused.
export const MAX_XP_PER_MATCH = 2000;
export function validateImport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const int = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
  const games = int(raw.games, 100000);
  const xp = int(raw.xp, 100000 * MAX_XP_PER_MATCH);
  const wins = int(raw.wins, 100000);
  const eliminations = int(raw.eliminations, 100000 * MAX_PLAYERS_PER_MATCH);
  if (games === null || xp === null || wins === null || eliminations === null) return null;
  if (games === 0 || xp > games * MAX_XP_PER_MATCH || wins > games || eliminations > games * MAX_PLAYERS_PER_MATCH) return null;
  const bestPlacement = int(raw.bestPlacement, MAX_PLAYERS_PER_MATCH) ?? 0;
  const dayStreak = int(raw.dayStreak, 10000) ?? 0;
  const lastPlayDay = typeof raw.lastPlayDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastPlayDay) ? raw.lastPlayDay : '';
  // Missions are not imported: today's are rolled fresh on the server.
  return { xp, games, wins, eliminations, bestPlacement, dayStreak, lastPlayDay };
}

// Missions joined with their static definitions, for rendering.
// What a room-size-dependent mission asks of a Mega Battle, e.g.
// "top 16 in Mega Battle" — or '' for missions that don't depend on room size.
export function megaTarget(def) {
  const scale = fieldScale(MEGA_PLAY_PLAYERS);
  if (def.stat === 'placement') return `top ${Math.floor(def.goal * scale)} in Mega Battle`;
  if (def.stat === 'peakCells') {
    const megaCells = MAP_SIZES.mega.width * MAP_SIZES.mega.height;
    return `${(Math.round(def.goal / landScale(MEGA_PLAY_PLAYERS, megaCells) / 1000) * 1000).toLocaleString('en-US')} in Mega Battle`;
  }
  return '';
}

export function missionViews(profile) {
  return profile.missions
    .map(m => {
      const def = MISSION_POOL.find(d => d.id === m.id);
      return def ? { ...def, progress: m.progress, done: m.done, mega: megaTarget(def) } : null;
    })
    .filter(Boolean);
}

/**
 * Score one finished match against a profile. Pure: returns a new profile.
 * match: { placement, totalPlayers, won, eliminations, peakCells, survivedSec,
 *          towers, missiles, tookLead, mapCells (the map's width × height) }
 * day / yesterday: the player's calendar days (dayKey) for streaks and missions.
 * Returns { lines: [{label, xp}], totalXp, before, after, leveledUp, missions, profile }.
 */
export function scoreMatch(rawProfile, match, { day = todayKey(), yesterday = yesterdayKey() } = {}) {
  const profile = normalizeProfile(rawProfile, day);
  profile.missions = profile.missions.map(m => ({ ...m }));
  const before = levelInfo(profile.xp);
  const lines = [];
  // Round first, so a line that would read "+0" is left out.
  const add = (label, xp) => { const v = Math.round(xp); if (v > 0) lines.push({ label, xp: v }); };

  const total = Math.max(2, match.totalPlayers || 2);
  const placement = Math.min(total, Math.max(1, match.placement || total));

  const scale = fieldScale(total);
  // Standard-battle equivalents (see "Room-size scaling" above).
  const equivLand = (match.peakCells || 0) * landScale(total, match.mapCells);
  const equivPlacement = Math.ceil(placement / scale);

  add('Battle fought', 20);
  add(`Placed #${placement} of ${total}`, ((total - placement) / (total - 1)) * 100);
  if (match.won) add(scale > 1 ? `Victory over ${total - 1} rivals` : 'Victory', VICTORY_XP * scale);
  add(`Eliminations ×${match.eliminations || 0}`, (match.eliminations || 0) * 40);
  // 1 XP per 5,000 (equivalent) peak land: ~12 for a fair share, capped at 80.
  add('Territory held', Math.min(80, equivLand / 5000));
  // 4 XP per minute, capped at 10 minutes (about a full match).
  add('Time survived', Math.min(40, ((match.survivedSec || 0) / 60) * 4));

  // Day streak: consecutive calendar days with at least one battle.
  if (profile.lastPlayDay !== day) {
    profile.dayStreak = profile.lastPlayDay === yesterday ? profile.dayStreak + 1 : 1;
    profile.lastPlayDay = day;
    add('First battle of the day', 50);
    if (profile.dayStreak > 1) add(`${profile.dayStreak}-day streak`, Math.min(50, profile.dayStreak * 10));
  }

  // Daily missions.
  const stats = {
    games: 1,
    wins: match.won ? 1 : 0,
    eliminations: match.eliminations || 0,
    placement: equivPlacement,
    towers: match.towers || 0,
    missiles: match.missiles || 0,
    peakCells: equivLand,
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

  const after = levelInfo(profile.xp);
  return {
    lines, totalXp, before, after,
    leveledUp: after.level > before.level,
    missions: missionViews(profile),
    profile,
  };
}

// Guest path: score a match against this browser's profile and store it.
export function applyMatchResult(match) {
  const result = scoreMatch(loadLocalProfile(), match);
  save(result.profile);
  return result;
}

// Compact home-screen card: level, XP bar, day streak and today's missions.
export function progressCardHtml() {
  const profile = loadProfile();
  if (!profile) {
    // Logged in, waiting for the server's copy (sent on connect).
    return '<div class="pc-loading">Loading your progress…</div>';
  }
  const info = levelInfo(profile.xp);
  const streakActive = profile.lastPlayDay === todayKey() || profile.lastPlayDay === yesterdayKey();
  const streak = streakActive ? profile.dayStreak : 0;

  const missions = missionViews(profile).map(m => {
    const shown = m.kind === 'atMost' ? (m.done ? 1 : 0) : m.progress;
    const goal = m.kind === 'atMost' ? 1 : m.goal;
    const count = goal > 1 && goal <= 20 ? ` <span class="pc-mission-count">${shown}/${goal}</span>` : '';
    return `
      <div class="pc-mission ${m.done ? 'done' : ''}">
        <span class="pc-mission-check">${m.done ? '✔' : '○'}</span>
        <span class="pc-mission-text">${m.text}${count}${m.mega ? ` <span class="pc-mission-mega">· ${m.mega}</span>` : ''}</span>
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
