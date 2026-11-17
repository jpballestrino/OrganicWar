// XP and mission scoring across room sizes: a Mega Battle (64 players) result
// must be worth what the equivalent standard (20-player) result is worth.
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMatchResult, fieldScale, megaTarget, loadProfile } from './progression.js';

// progression.js keeps the profile in localStorage; give each test a fresh one.
beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
});

// XP from one match, excluding once-a-day bonuses and missions (which depend on
// the day's profile, not on the match).
function matchXp(match) {
  loadProfile(); // creates today's profile
  // Play one throwaway battle first so "first battle of the day" is used up.
  applyMatchResult({ placement: 10, totalPlayers: 20 });
  const result = applyMatchResult(match);
  return Object.fromEntries(result.lines.filter(l => !l.label.startsWith('Mission')).map(l => [l.label, l.xp]));
}

describe('room-size scaling', () => {
  it('scales by the player count relative to 20, never below 1', () => {
    expect(fieldScale(20)).toBe(1);
    expect(fieldScale(10)).toBe(1);
    expect(fieldScale(64)).toBeCloseTo(3.2);
  });

  it('a fair share of a Mega map earns the territory XP of a fair share of a standard map', () => {
    const standard = matchXp({ placement: 10, totalPlayers: 20, peakCells: 63000 });
    const mega = matchXp({ placement: 32, totalPlayers: 64, peakCells: 63000 / 3.2 });
    expect(mega['Territory held']).toBe(standard['Territory held']);
  });

  it('a Mega victory pays proportionally more, so its expected value matches', () => {
    const standard = matchXp({ placement: 1, totalPlayers: 20, won: true });
    const mega = matchXp({ placement: 1, totalPlayers: 64, won: true });
    expect(standard.Victory).toBe(150);
    expect(mega['Victory over 63 rivals']).toBe(480);
    // Placement XP is already a fraction of the field: 1st pays 100 in both.
    expect(standard['Placed #1 of 20']).toBe(100);
    expect(mega['Placed #1 of 64']).toBe(100);
  });

  it('a standard battle scores exactly as before', () => {
    const xp = matchXp({ placement: 5, totalPlayers: 20, eliminations: 2, peakCells: 150000, survivedSec: 300 });
    expect(xp).toEqual({
      'Battle fought': 20,
      'Placed #5 of 20': 79,
      'Eliminations ×2': 80,
      'Territory held': 30,
      'Time survived': 20,
    });
  });
});

describe('daily missions in a Mega Battle', () => {
  // Force today's missions to the ones under test.
  function withMissions(ids) {
    const p = loadProfile();
    p.missions = ids.map(id => ({ id, progress: 0, done: false }));
    localStorage.setItem('ow_profile_v1', JSON.stringify(p));
  }
  const done = (result, id) => result.profile.missions.find(m => m.id === id).done;

  it('top 16 of 64 completes "Finish in the top 5"; 17th does not', () => {
    withMissions(['top5']);
    expect(done(applyMatchResult({ placement: 17, totalPlayers: 64 }), 'top5')).toBe(false);
    expect(done(applyMatchResult({ placement: 16, totalPlayers: 64 }), 'top5')).toBe(true);
  });

  it('47k land in a Mega Battle completes "Hold 150,000 land"', () => {
    withMissions(['land150k']);
    expect(done(applyMatchResult({ placement: 30, totalPlayers: 64, peakCells: 40000 }), 'land150k')).toBe(false);
    expect(done(applyMatchResult({ placement: 30, totalPlayers: 64, peakCells: 47000 }), 'land150k')).toBe(true);
  });

  it('standard battles still need the full goal', () => {
    withMissions(['top5', 'land150k']);
    const r = applyMatchResult({ placement: 6, totalPlayers: 20, peakCells: 140000 });
    expect(done(r, 'top5')).toBe(false);
    expect(done(r, 'land150k')).toBe(false);
  });

  it('mission cards state the Mega target', () => {
    expect(megaTarget({ stat: 'placement', goal: 5 })).toBe('top 16 in Mega Battle');
    expect(megaTarget({ stat: 'placement', goal: 3 })).toBe('top 9 in Mega Battle');
    expect(megaTarget({ stat: 'peakCells', goal: 150000 })).toBe('47,000 in Mega Battle');
    expect(megaTarget({ stat: 'wins', goal: 1 })).toBe('');
  });
});
