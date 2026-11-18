// Ranked matchmaking and rating (server/game/ranked.js).
import { describe, it, expect } from 'vitest';
import {
  planRankedMatches, rankedEloDeltas, ratingWindow,
  RANKED_GATHER_S, RANKED_MAX_HUMANS, RANKED_WINDOW_OPEN_AFTER_S,
} from './ranked.js';

const NOW = 1_000_000;
const q = (elo, waitedS, id = `${elo}/${waitedS}`) => ({ id, elo, joinedAt: NOW - waitedS * 1000 });
const ids = (groups) => groups.map((g) => g.map((e) => e.id).sort());

describe('ranked matchmaking', () => {
  it('waits for more players before starting a pair that just met', () => {
    expect(planRankedMatches([q(1000, 3), q(1010, 1)], NOW)).toEqual([]);
    expect(ids(planRankedMatches([q(1000, RANKED_GATHER_S), q(1010, 1)], NOW))).toEqual([['1000/15', '1010/1']]);
  });

  it('never matches a lone player', () => {
    expect(planRankedMatches([q(1000, 600)], NOW)).toEqual([]);
  });

  it('pairs players of similar rating, not just the first two in line', () => {
    const groups = planRankedMatches([q(1000, 20, 'a'), q(1600, 19, 'b'), q(1020, 18, 'c'), q(1590, 17, 'd')], NOW);
    expect(ids(groups)).toEqual([['a', 'c'], ['b', 'd']]);
  });

  it('keeps far-apart players waiting until their range has widened enough', () => {
    expect(planRankedMatches([q(1000, 20), q(1600, 20)], NOW)).toEqual([]);
    expect(planRankedMatches([q(1000, RANKED_WINDOW_OPEN_AFTER_S), q(1600, 20)], NOW)).toHaveLength(1);
    expect(ratingWindow(0)).toBeLessThan(ratingWindow(30));
  });

  it('starts at once with a full group, and caps the group size', () => {
    const many = Array.from({ length: RANKED_MAX_HUMANS + 3 }, (_, i) => q(1000 + i, 1, `p${i}`));
    const groups = planRankedMatches(many, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(RANKED_MAX_HUMANS);
  });
});

describe('ranked rating', () => {
  it('is zero-sum and rewards the better placement', () => {
    const d = rankedEloDeltas([{ fid: 1, elo: 1000, place: 1 }, { fid: 2, elo: 1000, place: 2 }]);
    expect(d[1]).toBe(20);
    expect(d[2]).toBe(-20);
  });

  it('an upset moves ratings more than an expected result', () => {
    const upset = rankedEloDeltas([{ fid: 1, elo: 1000, place: 1 }, { fid: 2, elo: 1400, place: 2 }]);
    const expected = rankedEloDeltas([{ fid: 1, elo: 1400, place: 1 }, { fid: 2, elo: 1000, place: 2 }]);
    expect(upset[1]).toBeGreaterThan(expected[1]);
    expect(expected[1]).toBeGreaterThan(0);
  });

  it('in bigger matches the middle places land in between and the change stays bounded', () => {
    const players = [1, 2, 3, 4, 5, 6, 7, 8].map((place) => ({ fid: place, elo: 1200, place }));
    const d = rankedEloDeltas(players);
    expect(d[1]).toBe(20);
    expect(d[8]).toBe(-20);
    for (let p = 1; p < 8; p++) expect(d[p]).toBeGreaterThan(d[p + 1]);
    expect(Object.values(d).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('a single human gets no change', () => {
    expect(rankedEloDeltas([{ fid: 3, elo: 1000, place: 1 }])).toEqual({ 3: 0 });
  });
});
