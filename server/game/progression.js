// Server-side progression (XP, levels, streaks, daily missions) for logged-in
// players. The browser never computes or uploads their XP: the server scores
// each match from its OWN numbers (the sim worker's bookkeeping) with the same
// pure rules the guest client uses (scoreMatch in src/js/progression.js), stores
// the profile in `user_progression`, and pushes it to the player:
//   progression-profile  { profile, canImport }  — on connect / after an import
//   progression-result   { lines, totalXp, before, after, leveledUp, missions,
//                          profile }             — when the player's match ends
// Guests keep the localStorage profile and the in-browser scoring.

import { getProgression, saveProgression, insertProgressionIfMissing } from '../database.js';
import { normalizeProfile, scoreMatch, dayKey, validateImport } from '../../src/js/progression.js';
import { log } from '../utils/logger.js';

// The player's UTC offset (Date#getTimezoneOffset minutes), sent in the socket
// handshake so streaks and daily missions roll over at THEIR midnight.
export function parseTzOffset(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= -840 && n <= 840 ? n : 0;
}

function days(tzOffsetMin, nowMs = Date.now()) {
  return { day: dayKey(nowMs, tzOffsetMin), yesterday: dayKey(nowMs - 86400000, tzOffsetMin) };
}

// The user's profile, normalized for today (missions rolled over). Returns
// { profile, exists } — exists=false means the account has no profile yet.
export function loadUserProfile(userId, tzOffsetMin) {
  const stored = getProgression(userId);
  const profile = normalizeProfile(stored, days(tzOffsetMin).day);
  profile.tzOffsetMin = tzOffsetMin;
  return { profile, exists: !!stored };
}

// Push the stored profile to a freshly connected (logged-in) socket.
export function sendProfile(socket) {
  if (!socket.userId) return;
  try {
    const { profile, exists } = loadUserProfile(socket.userId, socket.tzOffset || 0);
    socket.emit('progression-profile', { profile, canImport: !exists });
  } catch (err) {
    log('error', `[Progression] load failed for user ${socket.userId}:`, err.message);
  }
}

// One-time import of a browser's guest profile into an account that has none:
// the first time a player logs in, the XP they earned as a guest comes along.
// localStorage is editable, so validateImport refuses anything implausible.
export function importGuestProfile(socket, raw) {
  if (!socket.userId) return;
  const clean = validateImport(raw);
  if (clean) {
    const profile = normalizeProfile(clean, days(socket.tzOffset || 0).day);
    if (insertProgressionIfMissing(socket.userId, profile)) {
      log('info', `[Progression] imported guest profile for user ${socket.userId} (${clean.xp} XP, ${clean.games} games)`);
    }
  }
  sendProfile(socket);
}

/**
 * Score one finished match for one human player and store it. Called when the
 * faction is eliminated and, for everyone still standing, at game over —
 * exactly once per player per match (room.humanPlayers[fid].xpAwarded).
 *
 * outcome: { won, placement, survivedSec, peakCells, eliminations, towers,
 *            missiles, tookLead } — all from the server's own bookkeeping.
 * Returns the scoring result, or null if nothing was awarded (guest, already
 * awarded, or the player abandoned the match).
 */
export function awardMatchXp(io, room, fid, outcome) {
  const human = room.humanPlayers && room.humanPlayers[fid];
  if (!human || !human.userId || human.xpAwarded || human.status === 'abandoned') return null;
  human.xpAwarded = true;

  const slot = room.activePlayerSlots[fid];
  const socket = slot && slot.socketId ? io.sockets.sockets.get(slot.socketId) : null;
  try {
    const stored = getProgression(human.userId);
    // The connected socket knows the player's timezone; otherwise use the one
    // saved with the profile last time.
    const tz = socket ? (socket.tzOffset || 0) : parseTzOffset(stored && stored.tzOffsetMin);
    const totalPlayers = Object.values(room.activePlayerSlots).filter(Boolean).length || room.maxPlayers;
    const result = scoreMatch(stored, {
      won: !!outcome.won,
      placement: outcome.placement,
      totalPlayers,
      eliminations: outcome.eliminations || 0,
      peakCells: outcome.peakCells || 0,
      survivedSec: outcome.survivedSec || 0,
      towers: outcome.towers || 0,
      missiles: outcome.missiles || 0,
      tookLead: !!outcome.tookLead,
      mapCells: (room.mapWidth || 0) * (room.mapHeight || 0) || undefined,
    }, days(tz));
    result.profile.tzOffsetMin = tz;
    saveProgression(human.userId, result.profile);
    if (socket) socket.emit('progression-result', result);
    return result;
  } catch (err) {
    human.xpAwarded = false; // let a later call retry
    log('error', `[Progression] award failed for user ${human.userId}:`, err.message);
    return null;
  }
}
