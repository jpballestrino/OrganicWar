// Server-side XP for logged-in players, against the in-memory test database.
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../migrate.js';
import { prepareStatements, createUser, getProgression } from '../database.js';
import { awardMatchXp, importGuestProfile, loadUserProfile } from './progression.js';

let userId;
beforeAll(() => {
  runMigrations();
  prepareStatements();
  userId = createUser('xp_tester', 'xp@test.local', 'hash', 'XP Tester').id;
});

// Minimal stand-ins for Socket.IO: one connected socket that records emits.
function fakeIo() {
  const sent = [];
  const socket = { id: 'S1', userId, tzOffset: 0, emit: (event, payload) => sent.push({ event, payload }) };
  return { io: { sockets: { sockets: new Map([['S1', socket]]) } }, socket, sent };
}
function fakeRoom(humans) {
  const activePlayerSlots = {};
  for (let f = 1; f <= 20; f++) activePlayerSlots[f] = { socketId: null, nickname: `Bot ${f}`, isBot: true };
  for (const [fid, h] of Object.entries(humans)) activePlayerSlots[fid] = { socketId: h.socketId ?? null, nickname: 'P' };
  return { maxPlayers: 20, activePlayerSlots, humanPlayers: Object.fromEntries(Object.entries(humans).map(([f, h]) => [f, { ...h }])) };
}

describe('server-side match XP', () => {
  it('scores a logged-in player once, stores it and pushes the result', () => {
    const { io, sent } = fakeIo();
    const room = fakeRoom({ 3: { userId, isGuest: false, status: 'playing', socketId: 'S1' } });
    const outcome = { won: true, placement: 1, eliminations: 2, peakCells: 120000, survivedSec: 240, towers: 3, missiles: 1, tookLead: true };

    const r = awardMatchXp(io, room, 3, outcome);
    expect(r.lines.find(l => l.label === 'Victory').xp).toBe(150);
    expect(r.lines.find(l => l.label === 'Eliminations ×2').xp).toBe(80);
    const stored = getProgression(userId);
    expect(stored.xp).toBe(r.totalXp);
    expect(stored.games).toBe(1);
    expect(stored.wins).toBe(1);
    expect(sent.map(s => s.event)).toEqual(['progression-result']);

    // The same match can't pay twice (elimination + game over, or a retry).
    expect(awardMatchXp(io, room, 3, outcome)).toBeNull();
    expect(getProgression(userId).games).toBe(1);
  });

  it('skips guests and players who abandoned the match', () => {
    const { io } = fakeIo();
    const room = fakeRoom({
      4: { userId: null, isGuest: true, status: 'playing' },
      5: { userId, isGuest: false, status: 'abandoned' },
    });
    expect(awardMatchXp(io, room, 4, { placement: 2 })).toBeNull();
    expect(awardMatchXp(io, room, 5, { placement: 2 })).toBeNull();
    expect(getProgression(userId).games).toBe(1);
  });

  it('still saves XP for a player whose socket is gone', () => {
    const { io } = fakeIo();
    const room = fakeRoom({ 6: { userId, isGuest: false, status: 'playing', socketId: null } });
    expect(awardMatchXp(io, room, 6, { placement: 7 })).not.toBeNull();
    expect(getProgression(userId).games).toBe(2);
  });
});

describe('guest profile import', () => {
  it('imports once into an empty account, never over an existing one', () => {
    const newId = createUser('importer', 'imp@test.local', 'hash', 'Importer').id;
    const { socket, sent } = fakeIo();
    socket.userId = newId;
    expect(loadUserProfile(newId, 0).exists).toBe(false);

    importGuestProfile(socket, { xp: 900, games: 3, wins: 1, eliminations: 2, bestPlacement: 1 });
    expect(getProgression(newId)).toMatchObject({ xp: 900, games: 3, wins: 1 });
    expect(sent.at(-1)).toMatchObject({ event: 'progression-profile', payload: { canImport: false } });

    importGuestProfile(socket, { xp: 5000, games: 10, wins: 2, eliminations: 4 });
    expect(getProgression(newId).xp).toBe(900); // unchanged
  });

  it('refuses an implausible profile and stores nothing', () => {
    const newId = createUser('cheater', 'cheat@test.local', 'hash', 'Cheater').id;
    const { socket } = fakeIo();
    socket.userId = newId;
    importGuestProfile(socket, { xp: 10_000_000, games: 1, wins: 1, eliminations: 0 });
    expect(getProgression(newId)).toBeNull();
  });
});
