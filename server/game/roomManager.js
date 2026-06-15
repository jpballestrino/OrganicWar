import crypto from 'crypto';
import { recordMatch, updateUserStats, updateUserElo, updateGuildMatchStats, findGuildById } from '../database.js';
import { log } from '../utils/logger.js';
import { activeRooms, guildWarQueue, rankedQueue, userSocketMap } from './state.js';
import { io } from '../server.js';
import { RoomSim } from './simulationRunner.js';
import { terrainAt, TERRAIN } from '../../src/js/mapGen.js';

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
  constructor(maxFactions = 20) {
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

  initSimulation(preset) {
    // Minimal mock setup
  }

  isNearWater(r, c, dist) {
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

  initializeCircularNucleus(r, c, fid, radius) {
    this.factionCentroids[fid] = { r, c };
  }

  analyzeMapTopologyAndEnclaves(immediate) {
    // No-op
  }

  destroy() {
    // No-op
  }
}

export function checkRoomGC(room) {
  const hasHumans = Object.values(room.activePlayerSlots).some(s => s !== null);
  if (!hasHumans) {
    if (room.gcTimeout) { clearTimeout(room.gcTimeout); }
    if (room.countdownInterval) { clearInterval(room.countdownInterval); }
    if (room.sim && room.sim.destroy) { room.sim.destroy(); }
    if (room.simReal) { room.simReal.destroy(); room.simReal = null; }
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

export function handlePlayerDisconnect(room, socketId, immediate = false) {
  for (let f in room.activePlayerSlots) {
    if (room.activePlayerSlots[f] && room.activePlayerSlots[f].socketId === socketId) {
      if (immediate) {
        if (room.disconnectTimers[f]) { clearTimeout(room.disconnectTimers[f]); }
        room.activePlayerSlots[f] = null;
        if (room.humanPlayers && room.humanPlayers[f]) {
          room.humanPlayers[f].status = 'abandoned';
        }
        for (let [t, data] of room.reconnectTokens.entries()) {
          if (data.factionId === parseInt(f)) { room.reconnectTokens.delete(t); }
        }
        checkRoomGC(room);
      } else {
        room.activePlayerSlots[f].disconnected = true;
        room.disconnectTimers[f] = setTimeout(() => {
          if (room.activePlayerSlots[f] && room.activePlayerSlots[f].disconnected) {
            room.activePlayerSlots[f] = null;
            io.to(room.id).emit('slots-update', room.activePlayerSlots);
            for (let [t, data] of room.reconnectTokens.entries()) {
              if (data.factionId === parseInt(f)) {
                room.reconnectTokens.delete(t);
              }
            }
            updateLobbyList();
            checkRoomGC(room);
          }
        }, 60000);
      }
    }
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
  const roomId = generateUniqueRoomId();
  const sim = new MockSimulation(maxPlayers);

  const room = buildRoomObject({
    roomId, name, sim, maxPlayers, preset, isQuickPlay,
  });

  activeRooms[roomId] = room;
  sim.initSimulation(preset);

  if (isQuickPlay) {
    let ticks = 5;

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
  const roomId = generateUniqueRoomId();
  const maxPlayers = players.length;
  const sim = new MockSimulation(maxPlayers);

  const room = buildRoomObject({
    roomId, name: 'Ranked Match', sim, maxPlayers, preset: 'north_america',
    isRankedMatch: true,
  });

  activeRooms[roomId] = room;
  sim.initSimulation('north_america');

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
    p.socket.emit('ranked-match-found', { roomId });
  }

  io.to(room.id).emit('slots-update', room.activePlayerSlots);

  let ticks = 15;
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

export function matchmakeRanked(force = false) {
  const REQUIRED_PLAYERS = force ? Math.max(1, rankedQueue.length) : 2;

  while (rankedQueue.length >= REQUIRED_PLAYERS && rankedQueue.length > 0) {
    let matchPlayers = rankedQueue.splice(0, REQUIRED_PLAYERS);
    let room = createRankedRoom(matchPlayers);
    log('info', `Ranked Match created with ${REQUIRED_PLAYERS} players. Room: ${room.id}`);

    for (let p of rankedQueue) {
      p.socket.emit('ranked-queue-update', { count: rankedQueue.length, required: 2 });
    }
  }
}

export function createGuildWarRoom(guildA, guildB, teamSize) {
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

  activeRooms[roomId] = room;
  sim.initSimulation('north_america');

  io.to(`guild:${guildA.id}`).emit('guild-war-matched', { roomId, opponent: guildB, teamSize });
  io.to(`guild:${guildB.id}`).emit('guild-war-matched', { roomId, opponent: guildA, teamSize });

  return room;
}

export function matchmakeGuildWars() {
  if (guildWarQueue.length < 2) { return; }

  for (let i = 0; i < guildWarQueue.length; i++) {
    for (let j = i + 1; j < guildWarQueue.length; j++) {
      let q1 = guildWarQueue[i];
      let q2 = guildWarQueue[j];

      if (q1.teamSize === q2.teamSize && Math.abs(q1.eloRating - q2.eloRating) <= 200) {
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

export const SAFE_ZONE_RADIUS = 80;

export function startSpawnSelection(room) {
  room.isOpen = false;
  room.phase = 'SPAWN_SELECTION';
  
  io.to(room.id).emit('spawn-selection-start', { duration: 5 });
  log('info', `[Room ${room.id}] Entering spawn selection phase`);

  updateLobbyList();

  let ticks = 5;
  io.to(room.id).emit('spawn-timer', ticks);
  
  room.countdownInterval = setInterval(() => {
    ticks--;
    io.to(room.id).emit('spawn-timer', ticks);

    if (ticks <= 0) {
      clearInterval(room.countdownInterval);
      finalizeSpawns(room);
    }
  }, 1000);
}

export function finalizeSpawns(room) {
  room.phase = 'PLAYING';

  // Fill empty slots with bots given varied random call-sign names.
  const usedNames = new Set(
    Object.values(room.activePlayerSlots).filter(Boolean).map(s => s.nickname)
  );
  for (let fid = 1; fid <= room.maxPlayers; fid++) {
    if (room.activePlayerSlots[fid] === null) {
      let botName = randomBotName();
      // Avoid duplicate names within the room.
      let guard = 0;
      while (usedNames.has(botName) && guard++ < 20) { botName = randomBotName(); }
      usedNames.add(botName);
      room.activePlayerSlots[fid] = { socketId: null, nickname: botName, isBot: true };
    }
  }
  
  // Validate and pick random land cells outside all existing safe zones
  for (let fid = 1; fid <= room.maxPlayers; fid++) {
    if (!room.spawnSelections.has(fid)) {
      let valid = false;
      let attempts = 0;
      let row, col;
      while (!valid && attempts < 1000) {
        attempts++;
        row = Math.floor(Math.random() * 1080);
        col = Math.floor(Math.random() * 1920);
        
        let terrain = terrainAt(col / 1920, row / 1080);
        if (terrain === TERRAIN.WATER) continue;
        
        // Check safe zones
        let tooClose = false;
        for (let [otherFid, pos] of room.spawnSelections.entries()) {
          let distSq = (pos.row - row) ** 2 + (pos.col - col) ** 2;
          if (distSq < SAFE_ZONE_RADIUS * SAFE_ZONE_RADIUS) {
            tooClose = true;
            break;
          }
        }
        
        if (!tooClose) {
          valid = true;
        }
      }
      
      // Fallback if we couldn't find a spot (rare, but just in case)
      if (!valid) {
        row = Math.floor(Math.random() * 800) + 100;
        col = Math.floor(Math.random() * 1700) + 100;
      }
      
      room.spawnSelections.set(fid, { row, col });
    }
  }

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
      onGameOver: (winnerId) => handleGameOver(room, winnerId),
    });
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
  } catch (err) {
    log('error', `[Room ${room.id}] Failed to start server sim`, err.message);
  }

  io.to(room.id).emit('start-match-now', { centroids: room.sim.factionCentroids });
  log('info', `[Room ${room.id}] Match started. (${Object.keys(room.activePlayerSlots).length} slots)`);
}

export function updateLobbyList() {
  io.emit('rooms-list-update', buildLobbyList());
}

export function handleGameOver(room, winnerFaction) {
  if (room.gameOverHandled) { return; }
  room.gameOverHandled = true;

  room.reconnectTokens.clear();

  room.matchStarted = false;
  room.isOpen = false;
  if (room.countdownInterval) { clearInterval(room.countdownInterval); }
  if (room.simReal) {
    room.simReal.destroy();
    room.simReal = null;
  }

  let isAllianceWin = winnerFaction ? !!room.sim.alliances[winnerFaction] : false;

  io.to(room.id).emit('game-over', { winner: winnerFaction });

  if (room.isGuildWar && winnerFaction) {
    let winningGuild = winnerFaction <= room.teamSize ? room.guildA : room.guildB;
    let losingGuild = winnerFaction <= room.teamSize ? room.guildB : room.guildA;

    let eloDeltaWin = Math.floor(30 + (losingGuild.elo_rating - winningGuild.elo_rating) * 0.1);
    eloDeltaWin = Math.max(10, Math.min(50, eloDeltaWin));

    let eloDeltaLoss = Math.floor(-20 + (losingGuild.elo_rating - winningGuild.elo_rating) * 0.1);
    eloDeltaLoss = Math.max(-40, Math.min(-5, eloDeltaLoss));

    try {
      updateGuildMatchStats(winningGuild.id, true, eloDeltaWin);
      updateGuildMatchStats(losingGuild.id, false, eloDeltaLoss);
    } catch (e) { log('error', 'Guild match stats error', e); }

    for (let fid in room.humanPlayers) {
      if (room.humanPlayers[fid]) {
        room.humanPlayers[fid].isGuildMatch = true;
        room.humanPlayers[fid].guildId = (parseInt(fid) <= room.teamSize) ? room.guildA.id : room.guildB.id;
      }
    }
  }

  let totalHumans = Object.keys(room.humanPlayers || {}).length;
  let averageRoomElo = 1000;
  if (room.isRankedMatch && totalHumans > 0) {
    let totalElo = 0;
    for (let fid in room.humanPlayers) {
      totalElo += (room.humanPlayers[fid].elo || 1000);
    }
    averageRoomElo = totalElo / totalHumans;
  }

  for (let fid in room.humanPlayers) {
    let player = room.humanPlayers[fid];
    if (player.isGuest || !player.userId) { continue; }

    let result = 'loss';
    if (winnerFaction && (
      parseInt(fid) === winnerFaction ||
      (isAllianceWin && room.sim.alliances[parseInt(fid)] === room.sim.alliances[winnerFaction])
    )) {
      result = 'win';
      player.placement = 1;
    } else if (player.status === 'abandoned') {
      result = 'abandoned';
      player.placement = player.placement || totalHumans;
    } else {
      player.placement = player.placement || totalHumans;
    }

    // Default simulation statistics for profile ELO updates
    let stats = {
      cells: 45,
      kills: 12,
      gold: 500,
      duration: Math.floor((Date.now() - room.createdAt) / 1000),
      isGuildMatch: player.isGuildMatch || false,
      guildId: player.guildId || null,
    };

    try {
      recordMatch(room.id, player.userId, parseInt(fid), result, stats);

      let wins = result === 'win' ? 1 : 0;
      let losses = (result === 'loss' || result === 'abandoned') ? 1 : 0;
      updateUserStats(player.userId, { wins, losses, games: 1, cells: stats.cells, kills: stats.kills });

      if (room.isRankedMatch) {
        let expectedScore = 1 / (1 + Math.pow(10, (averageRoomElo - (player.elo || 1000)) / 400));
        let actualScore = (totalHumans - player.placement) / Math.max(1, totalHumans - 1);

        let K = 60;
        let eloDelta = Math.round(K * (actualScore - expectedScore));

        if (player.placement === 1 && eloDelta < 5) { eloDelta = 5; }
        if (player.placement === totalHumans && eloDelta > -5) { eloDelta = -5; }

        updateUserElo(player.userId, eloDelta);
      } else if (!room.isQuickPlay && totalHumans >= 2) {
        let eloDelta = result === 'win' ? 15 : -5;
        updateUserElo(player.userId, eloDelta);
      }
    } catch (e) {
      log('error', `[ERROR] Saving match stats for user ${player.userId}`, e.message);
    }
  }

  const hasHumans = Object.values(room.activePlayerSlots).some(s => s !== null);
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
    isHost: room.hostSocketId === socket.id,
  });
}
