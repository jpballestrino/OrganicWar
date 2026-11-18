// Ranked matches: who plays whom, and how ratings change. Pure functions, so
// they can be tested without a server (server/game/ranked.test.js).
//
// Matchmaking: the queue is grouped by rating. Each player accepts opponents
// within a window that widens the longer they wait (RANKED_WINDOW_BASE + rate
// × seconds, unlimited after RANKED_WINDOW_OPEN_AFTER_S). A group starts as
// soon as it has RANKED_MAX_HUMANS players, or RANKED_MIN_HUMANS once its
// longest-waiting player has waited RANKED_GATHER_S (so a pair isn't started
// the instant they meet if others are about to join). The match is a normal
// RANKED_FIELD-faction battle: bots fill the empty factions, and only the
// humans' order counts for rating.
//
// Rating: pairwise Elo between the humans of a match — each pair is scored as
// a win / loss / draw by final placement, with the usual expected score from
// the rating difference — scaled by K / (humans − 1), so a match moves a
// player by at most about K whatever the room size. Zero-sum.

export const RANKED_MIN_HUMANS = 2;
export const RANKED_MAX_HUMANS = 8;
export const RANKED_FIELD = 20;
export const RANKED_GATHER_S = 15;
export const RANKED_WINDOW_BASE = 100;
export const RANKED_WINDOW_PER_S = 10;
export const RANKED_WINDOW_OPEN_AFTER_S = 90;
export const RANKED_K = 40;

// Rating range a queued player accepts after waiting `waitedS` seconds.
export function ratingWindow(waitedS) {
  if (waitedS >= RANKED_WINDOW_OPEN_AFTER_S) return Infinity;
  return RANKED_WINDOW_BASE + RANKED_WINDOW_PER_S * Math.max(0, waitedS);
}

// queue: [{ elo, joinedAt, ... }] (any extra fields are passed through).
// Returns the groups to start now (each an array of queue entries, best-
// matched first). Entries not returned stay queued.
export function planRankedMatches(queue, now = Date.now()) {
  const waiting = [...queue].sort((a, b) => a.joinedAt - b.joinedAt);
  const taken = new Set();
  const groups = [];
  for (const anchor of waiting) {
    if (taken.has(anchor)) continue;
    const waitedS = (e) => (now - e.joinedAt) / 1000;
    const fits = (e) => Math.abs((e.elo || 1000) - (anchor.elo || 1000))
      <= Math.max(ratingWindow(waitedS(anchor)), ratingWindow(waitedS(e)));
    const others = waiting
      .filter((e) => e !== anchor && !taken.has(e) && fits(e))
      .sort((a, b) => Math.abs(a.elo - anchor.elo) - Math.abs(b.elo - anchor.elo) || a.joinedAt - b.joinedAt)
      .slice(0, RANKED_MAX_HUMANS - 1);
    const group = [anchor, ...others];
    const ready = group.length >= RANKED_MAX_HUMANS
      || (group.length >= RANKED_MIN_HUMANS && waitedS(anchor) >= RANKED_GATHER_S);
    if (ready) {
      group.forEach((e) => taken.add(e));
      groups.push(group);
    }
  }
  return groups;
}

// players: [{ fid, elo, place }] — place 1 = best; equal places are a draw.
// Returns { [fid]: integer rating change }.
export function rankedEloDeltas(players, K = RANKED_K) {
  const n = players.length;
  const out = {};
  if (n < 2) { players.forEach((p) => { out[p.fid] = 0; }); return out; }
  for (const a of players) {
    let sum = 0;
    for (const b of players) {
      if (a === b) continue;
      const expected = 1 / (1 + Math.pow(10, ((b.elo || 1000) - (a.elo || 1000)) / 400));
      const actual = a.place < b.place ? 1 : a.place > b.place ? 0 : 0.5;
      sum += actual - expected;
    }
    out[a.fid] = Math.round((K / (n - 1)) * sum);
  }
  return out;
}
