// Competitive statistics: rankings and profile numbers (server/database.js),
// against the in-memory test database.
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from './migrate.js';
import {
  prepareStatements, createUser, createGuild, recordMatch, updateGuildMatchStats, db,
  getRankedPlayersPage, getGuildRankingsPage, getCompetitiveStats,
} from './database.js';

let ids;
beforeAll(() => {
  runMigrations();
  prepareStatements();
  const mk = (name, elo) => {
    const u = createUser(`st_${name}`, `${name}@stats.test`, 'hash', `St ${name}`);
    db.prepare('UPDATE users SET elo_rating = ? WHERE id = ?').run(elo, u.id);
    return u.id;
  };
  ids = { ann: mk('ann', 1100), ben: mk('ben', 1040), cat: mk('cat', 1300), dan: mk('dan', 900) };
  const ranked = (uid, humanPlace, humans, eloDelta, eloAfter) => recordMatch('R', uid, 1, humanPlace === 1 ? 'win' : 'loss',
    { mode: 'ranked', placement: humanPlace * 3, players: 20, humanPlace, humans, eloDelta, eloAfter, kills: 10, cells: 1000 });
  ranked(ids.ann, 1, 2, 20, 1120); ranked(ids.ann, 2, 2, -20, 1100);
  ranked(ids.ben, 2, 2, -20, 1040);
  ranked(ids.cat, 1, 4, 30, 1300);
  // dan only plays casual games
  recordMatch('Q', ids.dan, 2, 'loss', { mode: 'quick', placement: 7, players: 20, humanPlace: 1, humans: 1, kills: 5, cells: 500 });
  recordMatch('Q', ids.ann, 3, 'win', { mode: 'quick', placement: 1, players: 20, humanPlace: 1, humans: 1, kills: 99, cells: 9000 });
});

describe('player rankings', () => {
  it('list only players who played ranked, by rating, with their record', () => {
    const { rows, total } = getRankedPlayersPage('', 1, 20);
    const mine = rows.filter((r) => r.username.startsWith('st_'));
    expect(mine.map((r) => r.username)).toEqual(['st_cat', 'st_ann', 'st_ben']);
    expect(total).toBeGreaterThanOrEqual(3);
    const ann = mine.find((r) => r.username === 'st_ann');
    expect(ann).toMatchObject({ ranked_games: 2, ranked_wins: 1, avg_place: 1.5, peak_rating: 1120 });
  });

  it('keep the global position when searching', () => {
    const all = getRankedPlayersPage('', 1, 50).rows;
    const { rows } = getRankedPlayersPage('st_ben', 1, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0].position).toBe(all.find((r) => r.username === 'st_ben').position);
    expect(rows[0].position).toBeGreaterThan(1);
  });
});

describe('guild rankings', () => {
  it('put guilds that fought wars first, by rating, then the unrated ones', () => {
    const g1 = createGuild('Stat Rated Low', 'SRL', '', ids.ann, '#ffc107', 1);
    const g2 = createGuild('Stat Rated High', 'SRH', '', ids.ben, '#ffc107', 1);
    createGuild('Stat Unrated', 'SUN', '', ids.cat, '#ffc107', 1);
    updateGuildMatchStats(g2.id, true, 25);
    updateGuildMatchStats(g1.id, false, -25);
    const rows = getGuildRankingsPage('Stat', 1, 20).rows;
    expect(rows.map((r) => r.tag)).toEqual(['SRH', 'SRL', 'SUN']);
    expect(rows[0]).toMatchObject({ wars: 1, total_guild_wins: 1, position: 1 });
    expect(rows[2].position).toBeNull();
  });
});

describe('profile stats', () => {
  it('separate ranked numbers from all-mode numbers', () => {
    const s = getCompetitiveStats(ids.ann);
    expect(s.ranked).toMatchObject({ ranked_games: 2, ranked_wins: 1, peak_rating: 1120 });
    expect(s.ranked.position).toBeGreaterThan(0);
    expect(s.ranked.ranked_players).toBeGreaterThanOrEqual(3);
    expect(s.overall).toMatchObject({ placed_games: 3, top3: 2, best_placement: 1, best_kills: 99, best_land: 9000 });
    expect(s.form[0]).toMatchObject({ mode: 'quick', placement: 1 });
    expect(s.byMode.find((m) => m.mode === 'ranked')).toMatchObject({ games: 2 });
  });

  it('a player who never played ranked has no ranked block', () => {
    expect(getCompetitiveStats(ids.dan).ranked).toBeNull();
  });
});
