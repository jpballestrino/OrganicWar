import crypto from 'crypto';
import { recordMatch, updateUserStats, updateUserElo, updateGuildMatchStats, findGuildById } from '../database.js';
import { log } from '../utils/logger.js';
import { activeRooms, guildWarQueue, rankedQueue } from './state.js';
import { io } from '../server.js';
import { RoomSim } from './simulationRunner.js';
import { randomMapId } from '../../src/js/mapGen.js';
import { MAX_FACTIONS, safeZoneRadiusFor, MAP_SIZES, mapSizeFor } from '../../src/js/constants.js';
import { roomRefusal } from './capacity.js';
import { awardMatchXp } from './progression.js';
import { placeSpawns } from './spawns.js';
import { isLandAt } from './terrainCache.js';

// How unpicked spawns are placed ('spread' or 'random'; see spawns.js).
const SPAWN_MODE = process.env.SPAWN_MODE || 'spread';
import { planRankedMatches, rankedEloDeltas, ratingWindow, RANKED_FIELD, RANKED_MIN_HUMANS } from './ranked.js';

// Random "adjective + noun" call-sign generator for bot factions.
const BOT_ADJECTIVES = [
  'Iron', 'Crimson', 'Shadow', 'Golden', 'Silent', 'Savage', 'Frost', 'Storm',
  'Obsidian', 'Azure', 'Vermillion', 'Rogue', 'Phantom', 'Ember', 'Granite', 'Onyx',
];
const BOT_NOUNS = [
  'Legion', 'Vanguard', 'Talons', 'Wolves', 'Phantoms', 'Empire', 'Order', 'Reach',
  'Dominion', 'Sentinels', 'Horde', 'Syndicate', 'Coalition', 'Marauders', 'Wardens', 'Pact',
];
function randomBotName() {
  const a = BOT_ADJECTIVES[Math.floor(Math.random() * BOT_ADJECTIVES.length)];
  const n = BOT_NOUNS[Math.floor(Math.random() * BOT_NOUNS.length)];
  return `${a} ${n}`;
}

// --- Mock Simulation Engine ---
class MockSimulation {
  constructor(maxFactions = MAX_FACTIONS) {
    this.ROWS = 100;
    this.COLS = 100;
    this.factions = Array.from({ length: maxFactions }, (_, i) => i + 1);
    this.terrain = new Uint8Array(this.ROWS * this.COLS);
    this.map = new Uint8Array(this.ROWS * this.COLS);
    this.structuresMap = new Map();
    this.factionCentroids = {};
    this.troops = {};
    this.gold = {};
    this.alliances = {};
    this.doctrines = {};
    this.playerPeakCells = {};
    this.playerKills = {};
    this.shopCosts = {
      factory: 180,
      city: 250,
      defense: 120,
      silo: 200,
      missile: 350,
      port: 250,
      artillery: 400,
    };
    this.activeAttacks = [];
    this.activeExplosions = [];
    
    this.factions.forEach(f => {
      this.troops[f] = 200;
      this.gold[f] = 100;
      this.playerPeakCells[f] = 10;
      this.playerKills[f] = 2;
    });
  }

  initSimulation() {
    // Minimal mock setup
  }

  isNearWater() {
    return false;
  }

  forceSpawnPlayer(fid, r, c) {
    this.factionCentroids[fid] = { r, c };
  }

  wipeFactionSpawn(fid) {
    delete this.factionCentroids[fid];
  }

  getFactionCellsArray(fid) {
    return this.factionCentroids[fid] ? [this.factionCentroids[fid].r * this.COLS + this.factionCentroids[fid].c] : [];
  }

  initializeCircularNucleus(r, c, fid) {
    this.factionCentroids[fid] = { r, c };
  }

  analyzeMapTopologyAndEnclaves() {
    // No-op
  }

  destroy() {
    // No-op
  }
}

// ── Bad connections and quitting ─────────────────────────────────────────────
// A player whose connection drops mid-match keeps their faction, idle, for
// RECONNECT_GRACE_SECONDS ("reconnecting"); after that a bot plays it ("away")
// until they come back — they can reclaim it from the bot for the rest of the
// match. Quitting from the menu hands the faction to a bot at once ("left")
// and is final. Everyone in the room is told through `player-connection`
// {factionId, nickname, state: 'reconnecting' | 'back' | 'away' | 'left'}.
export const RECONNECT_GRACE_SECONDS = Math.max(3, parseInt(process.env.RECONNECT_GRACE_SECONDS, 10) || 30);
// How long a room whose only humans are away (bots playing for them) keeps
// running so they can come back. After that it is closed.
export const AWAY_KEEP_SECONDS = Math.max(10, parseInt(process.env.AWAY_KEEP_SECONDS, 10) || 120);
// Reconnect tokens of finished matches, so a player returning after the end is
// told the match ended rather than "session expired". token → {winnerName, at}
const endedMatches = new Map();
const ENDED_KEEP_MS = 10 * 60 * 1000;

function emitConnection(room, fid, state) {
  const slot = room.activePlayerSlots[fid];
  io.to(room.id).emit('player-connection', { factionId: parseInt(fid), nickname: slot ? slot.nickname : '', state, bot: !!(slot && slot.isBot) });
}

// Guild wars have no bots: a player who quits or drops leaves their faction
// idle (a bot could attack its own team).
const botsAllowed = (room) => !room.isGuildWar;

function syncBots(room) {
  if (!room.simReal) return;
  const botFactions = [];
  for (let fid = 1; fid <= room.maxPlayers; fid++) {
    if (room.activePlayerSlots[fid] && room.activePlayerSlots[fid].isBot) botFactions.push(fid);
  }
  room.simReal.setBotFactions(botFactions);
}

export function checkRoomGC(room) {
  const slots = Object.values(room.activePlayerSlots).filter(Boolean);
  // Humans still playing (not bots, not away, not gone).
  const hasHumans = slots.some(s => !s.isBot && !s.away && !s.left);
  const now = Date.now();
  // Humans who are away (a bot plays for them) may still come back.
  const awayUntil = Math.max(0, ...slots.filter(s => s.away).map(s => s.awaySince + AWAY_KEEP_SECONDS * 1000));
  if (!hasHumans && awayUntil > now && activeRooms[room.id]) {
    if (room.gcTimeout) { clearTimeout(room.gcTimeout); }
    room.gcTimeout = setTimeout(() => { room.gcTimeout = null; checkRoomGC(room); }, awayUntil - now + 50);
    return;
  }
  if (!hasHumans) {
    if (room.gcTimeout) { clearTimeout(room.gcTimeout); }
    if (room.countdownInterval) { clearInterval(room.countdownInterval); }
    if (room.sim && room.sim.destroy) { room.sim.destroy(); }
    if (room.simReal) { room.simReal.destroy(); room.simReal = null; }
    rememberEnded(room, null);
    delete activeRooms[room.id];
    updateLobbyList();
    log('info', `[GC] Room ${room.id} deleted instantly — no players`);
  } else {
    if (room.gcTimeout) {
      clearTimeout(room.gcTimeout);
      room.gcTimeout = null;
    }
  }
}

function rememberEnded(room, winnerName) {
  const now = Date.now();
  for (const [t, v] of endedMatches) if (now - v.at > ENDED_KEEP_MS) endedMatches.delete(t);
  if (!room.matchStarted) return;
  for (const t of room.reconnectTokens.keys()) {
    if (!endedMatches.has(t)) endedMatches.set(t, { winnerName, at: now });
  }
}

// Why a reconnect token no longer leads to a match: 'ended' (the match is
// over) or 'expired' (unknown / the player quit).
export function endedMatchFor(token) {
  const v = endedMatches.get(token);
  return v && Date.now() - v.at < ENDED_KEEP_MS ? v : null;
}

// The faction a reconnecting socket takes back: idle during the grace period,
// or from the bot that played it while the player was away.
export function reclaimSlot(room, fid) {
  const slot = room.activePlayerSlots[fid];
  if (room.disconnectTimers[fid]) {
    clearTimeout(room.disconnectTimers[fid]);
    delete room.disconnectTimers[fid];
  }
  const wasAway = !!slot.away;
  const wasDisconnected = !!slot.disconnected;
  slot.disconnected = false;
  if (wasAway) {
    slot.isBot = false;
    delete slot.away;
    delete slot.awaySince;
    syncBots(room);
  }
  if (room.matchStarted && (wasAway || wasDisconnected)) emitConnection(room, fid, 'back');
  checkRoomGC(room); // cancels a pending "nobody left" GC
}

export function handlePlayerDisconnect(room, socketId, immediate = false) {
  for (let f in room.activePlayerSlots) {
    const slot = room.activePlayerSlots[f];
    if (!slot || slot.socketId !== socketId) continue;
    if (room.disconnectTimers[f]) { clearTimeout(room.disconnectTimers[f]); delete room.disconnectTimers[f]; }

    if (immediate) {
      // Quit from the menu: final.
      if (room.matchStarted && room.simReal) {
        slot.socketId = null;
        slot.isBot = botsAllowed(room);
        delete slot.disconnected;
        delete slot.away;
        slot.left = true;
        syncBots(room);
        if (!(room.humanPlayers[f] && room.humanPlayers[f].eliminated)) emitConnection(room, f, 'left');
        io.to(room.id).emit('slots-update', room.activePlayerSlots);
      } else {
        room.activePlayerSlots[f] = null;
      }
      // Quitting mid-match counts as abandoning it; leaving after your
      // faction was eliminated is just going back to the menu.
      if (room.humanPlayers && room.humanPlayers[f] && !room.humanPlayers[f].eliminated) {
        room.humanPlayers[f].status = 'abandoned';
      }
      for (let [t, data] of room.reconnectTokens.entries()) {
        if (data.factionId === parseInt(f)) { room.reconnectTokens.delete(t); }
      }
      checkRoomGC(room);
      continue;
    }

    // Connection lost: hold the faction for the grace period.
    slot.disconnected = true;
    if (room.matchStarted && room.simReal) emitConnection(room, f, 'reconnecting');
    room.disconnectTimers[f] = setTimeout(() => {
      delete room.disconnectTimers[f];
      const s = room.activePlayerSlots[f];
      if (!s || !s.disconnected || !activeRooms[room.id]) return;
      if (room.matchStarted && room.simReal) {
        // A bot plays until the player comes back (their token stays valid).
        s.socketId = null;
        s.isBot = botsAllowed(room);
        s.away = true;
        s.awaySince = Date.now();
        delete s.disconnected;
        syncBots(room);
        emitConnection(room, f, 'away');
      } else {
        room.activePlayerSlots[f] = null;
        for (let [t, data] of room.reconnectTokens.entries()) {
          if (data.factionId === parseInt(f)) { room.reconnectTokens.delete(t); }
        }
      }
      io.to(room.id).emit('slots-update', room.activePlayerSlots);
      updateLobbyList();
      checkRoomGC(room);
    }, RECONNECT_GRACE_SECONDS * 1000);
  }
}

function buildRoomObject({ roomId, name, sim, maxPlayers, preset, isQuickPlay, isRankedMatch, isGuildWar, extra }) {
  let activePlayerSlots = {};
  for (let i = 1; i <= maxPlayers; i++) {
    activePlayerSlots[i] = null;
  }

  return {
    id: roomId,
    name,
    sim,
    activePlayerSlots,
    reconnectTokens: new Map(),
    disconnectTimers: {},
    pendingAlliances: [],
    humanPlayers: {},
    matchStarted: false,
    phase: 'LOBBY',
    spawnSelections: new Map(),
    preset: preset || 'north_america',
    maxPlayers,
    // Map size: big rooms (Mega Battles) play on the bigger map, with safe
    // zones scaled to it (constants.js MAP_SIZES / mapSizeFor).
    mapSize: mapSizeFor(maxPlayers),
    mapWidth: MAP_SIZES[mapSizeFor(maxPlayers)].width,
    mapHeight: MAP_SIZES[mapSizeFor(maxPlayers)].height,
    safeZoneRadius: Math.round(safeZoneRadiusFor(maxPlayers) * MAP_SIZES[mapSizeFor(maxPlayers)].width / MAP_SIZES.standard.width),
    isQuickPlay: isQuickPlay || false,
    isRankedMatch: isRankedMatch || false,
    isGuildWar: isGuildWar || false,
    isOpen: true,
    gameOverHandled: false,
    createdAt: Date.now(),
    ...(extra || {}),
  };
}

function generateUniqueRoomId() {
  let roomId;
  let attempts = 0;
  do {
    roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    attempts++;
    if (attempts > 100) {
      roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
      break;
    }
  } while (activeRooms[roomId]);
  return roomId;
}

export function buildLobbyList() {
  return Object.values(activeRooms)
    .filter(r => r.isOpen && !r.isQuickPlay)
    .map(r => ({
      id: r.id,
      name: r.name,
      currentPlayers: Object.values(r.activePlayerSlots).filter(s => s !== null).length,
      maxPlayers: r.maxPlayers,
      preset: r.preset,
      isQuickPlay: r.isQuickPlay,
    }));
}

export function createRoom(name = 'Game', preset = 'north_america', maxPlayers = 20, isQuickPlay = false) {
  const refusal = roomRefusal();
  if (refusal) {
    log('warn', `[Room] Refused to create room: ${refusal}`);
    return null;
  }
  maxPlayers = Math.max(2, Math.min(MAX_FACTIONS, maxPlayers | 0));

  const roomId = generateUniqueRoomId();
  const sim = new MockSimulation(maxPlayers);

  // Force random map for Quick Play regardless of passed preset
  if (isQuickPlay) {
    preset = randomMapId(mapSizeFor(maxPlayers));
  }

  const room = buildRoomObject({
    roomId, name, sim, maxPlayers, preset, isQuickPlay,
  });

  activeRooms[roomId] = room;
  sim.initSimulation(preset);

  if (isQuickPlay) {
    // A Mega Battle waits a little longer for humans before bots fill in.
    let ticks = maxPlayers > 20 ? 10 : 5;

    room.countdownInterval = setInterval(() => {
      ticks--;
      io.to(roomId).emit('waiting-tick', ticks);

      let isFull = Object.values(room.activePlayerSlots).every(s => s !== null);

      if (ticks <= 0 || isFull) {
        clearInterval(room.countdownInterval);
        startSpawnSelection(room);
      }
    }, 1000);
  }

  return room;
}

export function createRankedRoom(players) {
  const refusal = roomRefusal();
  if (refusal) {
    log('warn', `[Room] Refused ranked room: ${refusal}`);
    for (const p of players) {
      p.socket.emit('matchmaking-failed', { message: 'Servers are full right now. Please try again in a minute.' });
    }
    return null;
  }

  const roomId = generateUniqueRoomId();
  // A normal-size battle (bots fill the other factions); only the humans'
  // order counts for rating.
  const maxPlayers = Math.max(RANKED_FIELD, players.length);
  const sim = new MockSimulation(maxPlayers);
  const mapId = randomMapId();

  const room = buildRoomObject({
    roomId, name: 'Ranked Match', sim, maxPlayers, preset: mapId,
    isRankedMatch: true,
  });
  room.isOpen = false; // never listed in, or joinable from, the public lobby

  activeRooms[roomId] = room;
  sim.initSimulation(mapId);

  for (let i = 0; i < players.length; i++) {
    let p = players[i];
    let fid = i + 1;

    room.activePlayerSlots[fid] = {
      socketId: p.socket.id,
      nickname: p.socket.displayName || p.socket.username || 'Player',
      guildTag: p.socket.guildTag || null,
    };
    room.humanPlayers[fid] = { userId: p.socket.userId || null, isGuest: false, status: 'playing', elo: p.elo };

    p.socket.roomId = room.id;
    p.socket.join(room.id);

    sendInitConfig(p.socket, room);

    const token = crypto.randomUUID();
    room.reconnectTokens.set(token, { roomId: room.id, factionId: fid, nickname: room.activePlayerSlots[fid].nickname });
    p.socket.emit('join-success', { factionId: fid, nickname: room.activePlayerSlots[fid].nickname, isQuickPlay: false, isRankedMatch: true, reconnectToken: token });
    p.socket.emit('ranked-match-found', { roomId, humans: players.length });
  }

  io.to(room.id).emit('slots-update', room.activePlayerSlots);

  let ticks = 5; // they already waited in the queue
  io.to(room.id).emit('waiting-tick', ticks);
  room.countdownInterval = setInterval(() => {
    ticks--;
    io.to(room.id).emit('waiting-tick', ticks);

    if (ticks <= 0) {
      clearInterval(room.countdownInterval);
      startSpawnSelection(room);
    }
  }, 1000);

  return room;
}

// Players leave the queue when they disconnect, leave it, or enter any other
// room; the matchmaker (every 5 s and on each join) starts every group that is
// ready — see server/game/ranked.js.
export function leaveRankedQueue(socket) {
  const idx = rankedQueue.findIndex(p => p.socket.id === socket.id);
  if (idx === -1) return false;
  rankedQueue.splice(idx, 1);
  sendRankedQueueStatus();
  return true;
}

export function sendRankedQueueStatus(now = Date.now()) {
  for (const p of rankedQueue) {
    const w = ratingWindow((now - p.joinedAt) / 1000);
    p.socket.emit('ranked-queue-update', {
      count: rankedQueue.length, required: RANKED_MIN_HUMANS,
      range: Number.isFinite(w) ? Math.round(w) : null,
    });
  }
}

export function matchmakeRanked(now = Date.now()) {
  // Drop entries whose socket went away (entering another room already
  // removes a player from the queue).
  for (let i = rankedQueue.length - 1; i >= 0; i--) {
    if (!rankedQueue[i].socket.connected) rankedQueue.splice(i, 1);
  }
  for (const group of planRankedMatches(rankedQueue, now)) {
    for (const p of group) rankedQueue.splice(rankedQueue.indexOf(p), 1);
    const room = createRankedRoom(group);
    if (room) log('info', `Ranked match created with ${group.length} players (ratings ${group.map(p => p.elo).join(', ')}). Room: ${room.id}`);
  }
  sendRankedQueueStatus(now);
}

export function createGuildWarRoom(guildA, guildB, teamSize) {
  const refusal = roomRefusal();
  if (refusal) {
    log('warn', `[Room] Refused guild war room: ${refusal}`);
    io.to(`guild:${guildA.id}`).emit('notification', { message: 'Server is full. Please try again later.', type: 'error' });
    io.to(`guild:${guildB.id}`).emit('notification', { message: 'Server is full. Please try again later.', type: 'error' });
    return null;
  }

  const roomId = generateUniqueRoomId();
  const maxPlayers = teamSize * 2;
  const sim = new MockSimulation(maxPlayers);

  const room = buildRoomObject({
    roomId,
    name: `Guild War: [${guildA.tag}] vs [${guildB.tag}]`,
    sim, maxPlayers, preset: 'north_america',
    isGuildWar: true,
    extra: { guildA, guildB, teamSize },
  });

  room.isOpen = false; // only members of the two guilds can join (join-room)
  activeRooms[roomId] = room;
  sim.initSimulation('north_america');

  io.to(`guild:${guildA.id}`).emit('guild-war-matched', { roomId, opponent: guildB, teamSize, musterSec: GUILD_WAR_MUSTER_SECONDS });
  io.to(`guild:${guildB.id}`).emit('guild-war-matched', { roomId, opponent: guildA, teamSize, musterSec: GUILD_WAR_MUSTER_SECONDS });

  // Members have GUILD_WAR_MUSTER_SECONDS to take their slots. A full roster
  // starts at once (join-faction); at the deadline the war starts with
  // whoever came if both guilds have someone there, or is called off.
  let left = GUILD_WAR_MUSTER_SECONDS;
  room.musterInterval = setInterval(() => {
    left--;
    if (room.countdownInterval || room.matchStarted || !activeRooms[room.id]) {
      clearInterval(room.musterInterval);
      return;
    }
    io.to(room.id).emit('waiting-tick', left);
    if (left > 0) return;
    clearInterval(room.musterInterval);
    const present = (lo, hi) => Object.entries(room.activePlayerSlots)
      .some(([f, sl]) => sl && !sl.isBot && Number(f) >= lo && Number(f) <= hi);
    if (present(1, teamSize) && present(teamSize + 1, teamSize * 2)) {
      startGuildWarCountdown(room);
    } else {
      cancelGuildWar(room, 'Not enough members joined in time. The war was called off (no rating change).');
    }
  }, 1000);

  return room;
}

export const GUILD_WAR_MUSTER_SECONDS = Math.max(10, parseInt(process.env.GUILD_WAR_MUSTER_SECONDS, 10) || 60);

// 5-second countdown, then spawn selection (full roster, or the muster
// deadline with both guilds present).
export function startGuildWarCountdown(room) {
  if (room.countdownInterval || room.matchStarted) return;
  if (room.musterInterval) clearInterval(room.musterInterval);
  let ticks = 5;
  io.to(room.id).emit('custom-game-starting');
  io.to(room.id).emit('waiting-tick', ticks);
  room.countdownInterval = setInterval(() => {
    ticks--;
    io.to(room.id).emit('waiting-tick', ticks);
    if (ticks <= 0) {
      clearInterval(room.countdownInterval);
      startSpawnSelection(room);
    }
  }, 1000);
}

function cancelGuildWar(room, message) {
  for (const g of [room.guildA, room.guildB]) {
    io.to(`guild:${g.id}`).emit('notification', { message: `Guild War [${room.guildA.tag}] vs [${room.guildB.tag}]: ${message}`, type: 'error' });
  }
  io.to(room.id).emit('server-error', { message });
  if (room.countdownInterval) clearInterval(room.countdownInterval);
  delete activeRooms[room.id];
  updateLobbyList();
  log('info', `[Room ${room.id}] Guild war cancelled: ${message}`);
}

// Guild rating after a war: plain Elo between the two guilds (zero-sum).
export function guildEloDelta(winnerElo, loserElo, K = 32) {
  const expected = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  return Math.max(1, Math.round(K * (1 - expected)));
}

export function matchmakeGuildWars() {
  if (guildWarQueue.length < 2) { return; }

  for (let i = 0; i < guildWarQueue.length; i++) {
    for (let j = i + 1; j < guildWarQueue.length; j++) {
      let q1 = guildWarQueue[i];
      let q2 = guildWarQueue[j];

      // Same team size and close ratings; the accepted gap widens with the
      // longer wait (same rule as ranked).
      const waited = (Date.now() - Math.min(q1.queuedAt || Date.now(), q2.queuedAt || Date.now())) / 1000;
      if (q1.teamSize === q2.teamSize && q1.guildId !== q2.guildId
          && Math.abs(q1.eloRating - q2.eloRating) <= ratingWindow(waited) + 100) {
        guildWarQueue.splice(j, 1);
        guildWarQueue.splice(i, 1);

        let guildA = findGuildById(q1.guildId);
        let guildB = findGuildById(q2.guildId);

        if (guildA && guildB) {
          createGuildWarRoom(guildA, guildB, q1.teamSize);
          log('info', `Guild War Match created: [${guildA.tag}] vs [${guildB.tag}] (${q1.teamSize}v${q1.teamSize})`);
        }
        return;
      }
    }
  }
}

// Seconds players get to pick a spawn. The map is on screen for the first time
// here, so 5s was too short to read it; the phase ends early once every human
// has picked (see the select-spawn handler).
const SPAWN_SELECTION_SECONDS = 8;
// A faction holding this share of all land wins outright, so the match ends on
// a decisive moment instead of a long mop-up (or a fortified stalemate). Guild
// wars are team games and keep last-team-standing.
//
// The target shrinks as the match goes on ("sudden death") so games can't drag:
// it holds at `share` until `decayStartSec`, then drops by `decayStep` every
// `decayEverySec`, down to `floor`. Measured on 20-bot matches the leader holds
// about half the land by 3.5-4.5 min, so this ends a match around the 4-5 min
// mark without touching the opening or midgame.
const DOMINATION = {
  share: 0.65,
  decayStartSec: 180,
  decayEverySec: 30,
  decayStep: 0.05,
  floor: 0.40,
};
// Guild wars are two teams, whose land adds up quickly: a team must hold 75%
// of the map together, easing from 4:00 down to an outright majority.
const GUILD_WAR_DOMINATION = {
  share: 0.75,
  decayStartSec: 240,
  decayEverySec: 30,
  decayStep: 0.05,
  floor: 0.5,
};

export function startSpawnSelection(room) {
  room.isOpen = false;
  room.phase = 'SPAWN_SELECTION';
  
  // mapId (= room.preset) lets the client repaint the correct terrain before
  // players pick spawns — this is the first screen that renders the map canvas.
  io.to(room.id).emit('spawn-selection-start', {
    duration: SPAWN_SELECTION_SECONDS, mapId: room.preset, safeZoneRadius: room.safeZoneRadius,
    mapWidth: room.mapWidth, mapHeight: room.mapHeight,
  });
  log('info', `[Room ${room.id}] Entering spawn selection phase (map: ${room.preset})`);

  updateLobbyList();

  let ticks = SPAWN_SELECTION_SECONDS;
  room.spawnTicksLeft = ticks; // for players who reconnect mid-selection
  io.to(room.id).emit('spawn-timer', ticks);

  room.countdownInterval = setInterval(() => {
    ticks--;
    room.spawnTicksLeft = ticks;
    io.to(room.id).emit('spawn-timer', ticks);

    // finalizeSpawns may already have run early (all humans picked).
    if (ticks <= 0 || room.phase !== 'SPAWN_SELECTION') {
      clearInterval(room.countdownInterval);
      if (room.phase === 'SPAWN_SELECTION') { finalizeSpawns(room); }
    }
  }, 1000);
}

export function finalizeSpawns(room) {
  if (room.phase !== 'SPAWN_SELECTION') { return; }
  room.phase = 'PLAYING';
  if (room.spawnEarlyTimer) { clearTimeout(room.spawnEarlyTimer); room.spawnEarlyTimer = null; }

  // Fill empty slots with bots given varied random call-sign names.
  const usedNames = new Set(
    Object.values(room.activePlayerSlots).filter(Boolean).map(s => s.nickname)
  );
  for (let fid = 1; fid <= room.maxPlayers; fid++) {
    // Guild wars are guild against guild: no bots; a missing member's
    // faction simply isn't in the match.
    if (room.activePlayerSlots[fid] === null && !room.isGuildWar) {
      let botName = randomBotName();
      // Avoid duplicate names within the room.
      let guard = 0;
      while (usedNames.has(botName) && guard++ < 20) { botName = randomBotName(); }
      usedNames.add(botName);
      room.activePlayerSlots[fid] = { socketId: null, nickname: botName, isBot: true };
    }
  }
  
  // Factions that didn't pick a spot (bots, idle humans) are placed by
  // server/game/spawns.js, away from the spots already taken.
  const missing = [];
  for (let fid = 1; fid <= room.maxPlayers; fid++) {
    if (!room.activePlayerSlots[fid]) continue; // empty guild-war slot
    if (!room.spawnSelections.has(fid)) missing.push(fid);
  }
  const placed = placeSpawns({
    taken: [...room.spawnSelections.values()],
    count: missing.length,
    mapId: room.preset,
    width: room.mapWidth,
    height: room.mapHeight,
    safeRadius: room.safeZoneRadius,
    mode: SPAWN_MODE,
    isLand: (row, col) => isLandAt(room.preset, room.mapSize, row, col),
  });
  missing.forEach((fid, i) => room.spawnSelections.set(fid, placed[i]));

  // Convert spawn selections to centroids map
  let centroids = {};
  for (let [fid, pos] of room.spawnSelections.entries()) {
    centroids[fid] = { r: pos.row, c: pos.col };
    // For mock sim compatibility temporarily
    if (room.sim && room.sim.factionCentroids) {
      room.sim.factionCentroids[fid] = { r: pos.row, c: pos.col };
    }
  }

  io.to(room.id).emit('spawns-finalized', { centroids, slots: room.activePlayerSlots });
  startMatchNow(room);
}

export function startMatchNow(room) {
  room.matchStarted = true;

  if (room.isGuildWar) {
    for (let i = 1; i <= room.teamSize; i++) {
      room.sim.alliances[i] = room.guildA.id;
    }
    for (let i = room.teamSize + 1; i <= room.teamSize * 2; i++) {
      room.sim.alliances[i] = room.guildB.id;
    }
  }

  try {
    room.simReal = new RoomSim(room.id, room.maxPlayers, io, {
      mapId: room.preset,
      mapSize: room.mapSize,
      // Guild wars: teams (no friendly fire; a team wins together, by last
      // team standing or by holding the domination share together).
      domination: room.isGuildWar ? GUILD_WAR_DOMINATION : DOMINATION,
      teams: room.isGuildWar ? { ...room.sim.alliances } : null,
      onGameOver: (winnerId, stats, byDomination) => handleGameOver(room, winnerId, stats, byDomination),
      // XP for a logged-in player whose faction was just eliminated.
      onPlayerEliminated: (p) => {
        // Leaving after being eliminated is not quitting (see handlePlayerDisconnect).
        if (room.humanPlayers[p.factionId]) room.humanPlayers[p.factionId].eliminated = true;
        awardMatchXp(io, room, p.factionId, { ...p, won: false });
      },
      onError: (message) => {
        log('error', `[Room ${room.id}] Simulation crashed: ${message}`);
        io.to(room.id).emit('server-error', { message: 'The game simulation crashed. Please return to the main menu.' });
        delete activeRooms[room.id];
      },
      onReady: () => {
        for (let [fid, pos] of room.spawnSelections.entries()) {
          room.simReal.spawnFaction(fid, pos.row, pos.col);
        }
        // Hand the sim the list of bot-controlled factions so it drives them.
        const botFactions = [];
        for (let fid = 1; fid <= room.maxPlayers; fid++) {
          if (room.activePlayerSlots[fid] && room.activePlayerSlots[fid].isBot) {
            botFactions.push(fid);
          }
        }
        room.simReal.setBotFactions(botFactions);

        // Tell the clients the simulation is finally booted and running.
        io.to(room.id).emit('start-match-now', { centroids: room.sim.factionCentroids });
        log('info', `[Room ${room.id}] Match started. (${Object.keys(room.activePlayerSlots).length} slots)`);
      }
    });
  } catch (err) {
    log('error', `[Room ${room.id}] Failed to start server sim`, err.message);
  }
}

export function updateLobbyList() {
  io.emit('rooms-list-update', buildLobbyList());
}

export function handleGameOver(room, winnerFaction, matchStats = {}, byDomination = false) {
  if (room.gameOverHandled) { return; }
  room.gameOverHandled = true;

  // Players who are reconnecting / away when the match ends are told so when
  // they come back.
  const winnerSlot = room.activePlayerSlots[winnerFaction];
  rememberEnded(room, winnerSlot ? winnerSlot.nickname : null);
  for (const f in room.disconnectTimers) { clearTimeout(room.disconnectTimers[f]); }
  room.disconnectTimers = {};
  room.reconnectTokens.clear();

  room.matchStarted = false;
  room.isOpen = false;
  if (room.countdownInterval) { clearInterval(room.countdownInterval); }
  if (room.simReal) {
    room.simReal.destroy();
    room.simReal = null;
  }

  let isAllianceWin = winnerFaction ? !!room.sim.alliances[winnerFaction] : false;
  const sameTeam = (fid) => winnerFaction && (
    fid === winnerFaction
    || (isAllianceWin && room.sim.alliances[fid] === room.sim.alliances[winnerFaction]));

  io.to(room.id).emit('game-over', {
    winner: winnerFaction,
    stats: matchStats,
    byDomination,
    durationSec: Math.floor((Date.now() - room.createdAt) / 1000),
  });

  // XP for every logged-in player still in the match (the eliminated ones were
  // awarded at their elimination; awardMatchXp skips them and guests).
  for (const key of Object.keys(room.humanPlayers || {})) {
    const fid = parseInt(key);
    const s = matchStats[fid] || {};
    const won = !!sameTeam(fid);
    awardMatchXp(io, room, fid, { ...s, won, placement: won ? 1 : (s.placement || 2) });
  }

  if (room.isGuildWar && winnerFaction) {
    let winningGuild = winnerFaction <= room.teamSize ? room.guildA : room.guildB;
    let losingGuild = winnerFaction <= room.teamSize ? room.guildB : room.guildA;

    // Only the guilds' rating changes in a guild war (zero-sum Elo between the
    // two guilds); the players' own ranked rating is untouched.
    const delta = guildEloDelta(winningGuild.elo_rating || 1000, losingGuild.elo_rating || 1000);
    try {
      updateGuildMatchStats(winningGuild.id, true, delta);
      updateGuildMatchStats(losingGuild.id, false, -delta);
    } catch (e) { log('error', 'Guild match stats error', e); }
    const result = (g, d) => ({ guildId: g.id, tag: g.tag, eloBefore: g.elo_rating || 1000, eloDelta: d });
    io.to(room.id).emit('guild-war-result', {
      winner: result(winningGuild, delta), loser: result(losingGuild, -delta),
    });

    for (let fid in room.humanPlayers) {
      if (room.humanPlayers[fid]) {
        room.humanPlayers[fid].isGuildMatch = true;
        room.humanPlayers[fid].guildId = (parseInt(fid) <= room.teamSize) ? room.guildA.id : room.guildB.id;
      }
    }
  }

  let totalHumans = Object.keys(room.humanPlayers || {}).length;
  // Rank the humans against each other by how the sim placed them (1 = winner,
  // higher = eliminated earlier; 0/missing = unknown, ranked last). Previously
  // every non-winner got last place, so ranked ELO ignored how long you survived.
  const simPlacement = (fid) => {
    const p = matchStats[fid] && matchStats[fid].placement;
    return p > 0 ? p : Number.MAX_SAFE_INTEGER;
  };
  const matchMode = room.isRankedMatch ? 'ranked' : room.isGuildWar ? 'guild'
    : room.isQuickPlay ? (room.maxPlayers > 20 ? 'mega' : 'quick') : 'custom';
  const factionsInMatch = Object.values(room.activePlayerSlots).filter(Boolean).length;
  // Players who quit rank below everyone who stayed, whatever their bot did.
  const quit = (fid) => (room.humanPlayers[fid].status === 'abandoned' ? 1 : 0);
  Object.keys(room.humanPlayers || {})
    .sort((a, b) => quit(a) - quit(b)
      || (sameTeam(parseInt(b)) ? 1 : 0) - (sameTeam(parseInt(a)) ? 1 : 0)
      || simPlacement(a) - simPlacement(b))
    .forEach((fid, index) => { room.humanPlayers[fid].placement = index + 1; });

  // Ranked rating: pairwise Elo between the humans of this match (ranked.js).
  // Only ranked matches change a player's rating.
  let eloDeltas = {};
  if (room.isRankedMatch) {
    eloDeltas = rankedEloDeltas(Object.entries(room.humanPlayers)
      .filter(([, p]) => p.userId && !p.isGuest)
      .map(([fid, p]) => ({ fid, elo: p.elo || 1000, place: p.placement })));
  }

  for (let fid in room.humanPlayers) {
    let player = room.humanPlayers[fid];
    if (player.isGuest || !player.userId) { continue; }

    let result = 'loss';
    if (player.status === 'abandoned') {
      result = 'abandoned';
    } else if (sameTeam(parseInt(fid))) {
      result = 'win';
    }

    const playerStats = matchStats[fid] || { cells: 0, gold: 0, kills: 0 };
    // Quitters count as last, whatever their bot did after they left.
    const simPlace = player.status === 'abandoned' ? null
      : sameTeam(parseInt(fid)) ? 1 : (playerStats.placement > 0 ? playerStats.placement : null);
    const eloDelta = room.isRankedMatch ? (eloDeltas[fid] || 0) : 0;
    let stats = {
      cells: playerStats.cells,
      kills: playerStats.kills,
      gold: playerStats.gold,
      duration: Math.floor((Date.now() - room.createdAt) / 1000),
      isGuildMatch: player.isGuildMatch || false,
      guildId: player.guildId || null,
      // Competitive stats (profile, rankings).
      mode: matchMode,
      placement: simPlace || factionsInMatch,
      players: factionsInMatch,
      humanPlace: player.placement,
      humans: totalHumans,
      eloDelta,
      eloAfter: room.isRankedMatch ? Math.max(0, (player.elo || 1000) + eloDelta) : null,
    };

    try {
      recordMatch(room.id, player.userId, parseInt(fid), result, stats);

      let wins = result === 'win' ? 1 : 0;
      let losses = (result === 'loss' || result === 'abandoned') ? 1 : 0;
      updateUserStats(player.userId, { wins, losses, games: 1, cells: stats.cells, kills: stats.kills });

      if (room.isRankedMatch && eloDeltas[fid]) {
        updateUserElo(player.userId, eloDeltas[fid]);
        player.eloDelta = eloDeltas[fid];
      }
    } catch (e) {
      log('error', `[ERROR] Saving match stats for user ${player.userId}`, e.message);
    }
  }

  // Tell each ranked player their rating change (shown on the recap).
  if (room.isRankedMatch) {
    for (const fid in room.humanPlayers) {
      const p = room.humanPlayers[fid];
      const slot = room.activePlayerSlots[fid];
      const sock = slot && slot.socketId ? io.sockets.sockets.get(slot.socketId) : null;
      if (sock && p.userId) sock.emit('ranked-result', { eloBefore: p.elo || 1000, eloDelta: p.eloDelta || 0, place: p.placement, humans: totalHumans });
    }
  }

  const hasHumans = Object.values(room.activePlayerSlots).some(s => s !== null && !s.isBot);
  if (room.isQuickPlay && !hasHumans) {
    delete activeRooms[room.id];
    updateLobbyList();
    log('info', `[GC] Quick Play Room ${room.id} deleted instantly on game over — no players`);
  } else {
    room.gcTimeout = setTimeout(() => {
      delete activeRooms[room.id];
      updateLobbyList();
    }, 15000);
  }
}

export function sendInitConfig(socket, room) {
  const sim = room.sim;
  const terrainFlat = sim.terrain;
  const mapFlat = sim.map;

  socket.emit('init-config', {
    ROWS: sim.ROWS,
    COLS: sim.COLS,
    shopCosts: sim.shopCosts,
    terrainFlat: terrainFlat.buffer,
    mapFlat: mapFlat.buffer,
    activePlayerSlots: room.activePlayerSlots,
    savedMapsList: [],
    currentPreset: room.preset,
    maxPlayers: room.maxPlayers,
    isQuickPlay: room.isQuickPlay,
    // The client labels ranked / guild-war lobbies and recaps from these.
    isRankedMatch: !!room.isRankedMatch,
    isGuildWar: !!room.isGuildWar,
    guildA: room.guildA ? { id: room.guildA.id, tag: room.guildA.tag, name: room.guildA.name } : null,
    guildB: room.guildB ? { id: room.guildB.id, tag: room.guildB.tag, name: room.guildB.name } : null,
    teamSize: room.teamSize || 0,
    isHost: room.hostSocketId === socket.id,
    reconnectGraceSec: RECONNECT_GRACE_SECONDS,
    mapWidth: room.mapWidth,
    mapHeight: room.mapHeight,
  });
}
