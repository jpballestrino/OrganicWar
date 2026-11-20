import { activeRooms, guildWarQueue, rankedQueue, userSocketMap } from './state.js';
import { clientIp } from '../clientIp.js';
import { sendProfile, importGuestProfile, parseTzOffset } from './progression.js';
import { MAX_FACTIONS, QUICK_PLAY_PLAYERS, MEGA_PLAY_PLAYERS } from '../../src/js/constants.js';
import { handlePlayerDisconnect, reclaimSlot, leaveRankedQueue, startGuildWarCountdown, endedMatchFor, sendInitConfig, updateLobbyList, buildLobbyList, createGuildWarRoom, matchmakeRanked, handleGameOver, createRoom, startSpawnSelection, finalizeSpawns } from './roomManager.js';
import { randomMapId } from '../../src/js/mapGen.js';
import { isLandAt } from './terrainCache.js';
import { log } from '../utils/logger.js';
import { ipConnectionCounts } from '../server.js';
import { verifyToken } from '../auth.js';
import { findUserById, updateLastLogin, getUserProfile, findGuildById, findGuildByTag, addGuildMessage } from '../database.js';
import { joinGuildRoom } from './guildRooms.js';
import crypto from 'crypto';
import { z } from 'zod';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Filter = require('bad-words');
const profanityFilter = new Filter();

function sanitizeString(str) {
  if (typeof str !== 'string') {return '';}
  return str.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Normalizes a player-supplied nickname before it is stored on a slot and
// broadcast to other clients: strips angle brackets, trims, caps length, and
// falls back when empty. Clients additionally escape on render.
function cleanNickname(str, fallback) {
  if (typeof str !== 'string') { return fallback; }
  const cleaned = str.replace(/[<>]/g, '').trim().slice(0, 20);
  return cleaned.length > 0 ? cleaned : fallback;
}

function getFactionForSocket(room, socketId) {
  for (let f in room.activePlayerSlots) {
    if (room.activePlayerSlots[f] && room.activePlayerSlots[f].socketId === socketId) {
      return parseInt(f);
    }
  }
  return null;
}

const createRoomSchema = z.object({
  name: z.string().min(1).max(50),
  maxPlayers: z.coerce.number().int().min(2).max(MAX_FACTIONS),
  preset: z.enum(['north_america', 'europe', 'africa']).optional(),
  nickname: z.string().min(1).max(20).optional(),
});

// Guild-war challenges sent and not yet answered: "challengerId>targetId" →
// {teamSize, expiresAt}. The client shows a challenge for 60 s.
const WAR_CHALLENGE_TTL_MS = 65000;
const pendingWarChallenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingWarChallenges) if (v.expiresAt < now) pendingWarChallenges.delete(k);
}, 60000).unref();

const guildChatSchema = z.object({
  message: z.string().min(1).max(200),
});

export function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    const ip = clientIp(socket);
    const count = (ipConnectionCounts.get(ip) || 0) + 1;
    ipConnectionCounts.set(ip, count);
    if (count > 20) {
      log('warn', `[RateLimit] Disconnected ${ip} (connection rate exceeded: ${count})`);
      socket.disconnect(true);
      return;
    }

    // Per-connection input rate-limit state (shared across the connection lifetime).
    const inputRateLimits = {
      expand:        { lastMs: 0, minIntervalMs: 33   },  // ~30/s max
      cancel:        { lastMs: 0, minIntervalMs: 50   },
      blitz:         { lastMs: 0, minIntervalMs: 500  },
      cancel_front:  { lastMs: 0, minIntervalMs: 50   },
      build_defense: { lastMs: 0, minIntervalMs: 200 },
      build_silo:    { lastMs: 0, minIntervalMs: 200 },
      build_mine:    { lastMs: 0, minIntervalMs: 200 },
      build_antiair: { lastMs: 0, minIntervalMs: 200 },
      build_city:    { lastMs: 0, minIntervalMs: 200 },
      // Keep this small: WASM enforces 2s per-silo cooldown, so a global 2s
      // gate here would block a second ready silo from firing. 100ms is purely
      // anti-flood; legitimate multi-silo play fires at most once per 100ms.
      fire_missile:  { lastMs: 0, minIntervalMs: 100 },
    };
    
    let playerToken = socket.handshake.auth.token;
    let userId = null;
    let username = null;
    let guildId = null;
    let displayName = null;
    socket.lastChatTimestamp = 0;

    if (playerToken) {
      const payload = verifyToken(playerToken);
      if (payload) {
        userId = payload.userId;
        username = payload.username;
        const userObj = findUserById(userId);
        if (userObj) {
          guildId = userObj.guild_id;
          displayName = userObj.display_name;
        }
        if (userSocketMap.has(userId)) {
          const oldSocketId = userSocketMap.get(userId);
          const oldSocket = io.sockets.sockets.get(oldSocketId);
          if (oldSocket && oldSocket.id !== socket.id) {
            oldSocket.emit('notification', { message: 'Logged in from another location. Disconnecting...', type: 'error' });
            oldSocket.disconnect(true);
          }
        }
        userSocketMap.set(userId, socket.id);
        updateLastLogin(userId);
            
        if (guildId) {
          joinGuildRoom(io, socket, guildId, displayName);
        }
      } else {
        log('warn', `Invalid token provided by socket ${socket.id}`);
      }
    }
    
    socket.userId = userId;
    log('info', `Socket connected: ${socket.id} (User ID: ${socket.userId || 'guest'})`);

    // ---------- PROGRESSION (XP) ----------
    // Logged-in players' XP lives on the server (server/game/progression.js).
    // The handshake carries the player's UTC offset so daily missions and
    // streaks roll over at their own midnight.
    socket.tzOffset = parseTzOffset(socket.handshake.auth && socket.handshake.auth.tzOffset);
    if (socket.userId) sendProfile(socket);
    let importUsed = false;
    socket.on('progression-import', (raw) => {
      // Only useful once per account (the server ignores it if a profile
      // exists); one try per connection is plenty.
      if (importUsed || !socket.userId) return;
      importUsed = true;
      try { importGuestProfile(socket, raw); } catch (err) {
        log('error', `[Progression] import failed for user ${socket.userId}:`, err.message);
      }
    });

    // Whether this socket still plays in a room (lobby, spawn selection or a
    // running match). One match at a time: it must quit that one first, or a
    // later "quit" would apply to the wrong room.
    function holdsSlotInRoom() {
      const room = socket.roomId && activeRooms[socket.roomId];
      if (!room || room.gameOverHandled) return false;
      return Object.values(room.activePlayerSlots).some(sl => sl && sl.socketId === socket.id);
    }

    function getFreshGuildInfo() {
      if (!userId) {return { guildId: null, guildTag: null };}
      const userObj = findUserById(userId);
      if (!userObj) {return { guildId: null, guildTag: null };}
      const gId = userObj.guild_id;
      if (!gId) {return { guildId: null, guildTag: null };}
      const profile = getUserProfile(userObj.username);
      return { guildId: gId, guildTag: profile?.guild_tag || null };
    }

    socket.on('request-rooms', () => {
      try {
        socket.emit('rooms-list-update', buildLobbyList());
      } catch (err) {
        log('error', `[ERROR] request-rooms failed for socket ${socket.id}:`, err.message);
        socket.emit('notification', { message: 'Server error occurred', type: 'error' });
      }
    });

    socket.on('create-custom-room', (data) => {
      leaveRankedQueue(socket); // can't wait for ranked while playing another match
      if (holdsSlotInRoom()) {
        socket.emit('notification', { message: 'You are already in a match. Leave it first.', type: 'error' });
        return;
      }
      try {
        const parsed = createRoomSchema.safeParse(data);
        if (!parsed.success) {
          socket.emit('notification', { message: 'Invalid room settings.', type: 'error' });
          return;
        }
        const { name, maxPlayers, preset, nickname } = parsed.data;
        const safeName = sanitizeString(profanityFilter.clean(name));
        const freshGuild = getFreshGuildInfo();
        const effectiveNickname = cleanNickname(socket.displayName || nickname, 'Host');
        let room = createRoom(safeName, preset || 'north_america', parseInt(maxPlayers) || 5, false);
        if (!room) {
          socket.emit('matchmaking-failed', { message: 'Servers are full right now. Please try again in a minute.' });
          return;
        }
        room.hostSocketId = socket.id;
        socket.roomId = room.id;
        socket.join(room.id);

        let fid = 1;
        room.activePlayerSlots[fid] = {
          socketId: socket.id,
          nickname: effectiveNickname,
          guildTag: freshGuild.guildTag,
        };
        room.humanPlayers[fid] = { userId: socket.userId || null, isGuest: !socket.userId, status: 'playing' };
        socket.assignedFaction = fid;

        sendInitConfig(socket, room);
            
        const token = crypto.randomUUID();
        room.reconnectTokens.set(token, { roomId: room.id, factionId: fid, nickname: room.activePlayerSlots[fid].nickname });
        socket.emit('join-success', { factionId: fid, nickname: room.activePlayerSlots[fid].nickname, isQuickPlay: false, reconnectToken: token });
        io.to(room.id).emit('slots-update', room.activePlayerSlots);
            
        updateLobbyList();
      } catch (err) {
        log('error', `[ERROR] create-custom-room failed for socket ${socket.id}:`, err.message);
        socket.emit('notification', { message: 'Server error occurred', type: 'error' });
      }
    });

    socket.on('join-room', ({ roomId }) => {
      leaveRankedQueue(socket); // can't wait for ranked while playing another match
      if (holdsSlotInRoom()) {
        socket.emit('notification', { message: 'You are already in a match. Leave it first.', type: 'error' });
        return;
      }
      try {
        if (typeof roomId !== 'string' || roomId.length > 10) {return;}
        let room = activeRooms[roomId];
        const guildMember = room && room.isGuildWar && !room.countdownInterval && !room.matchStarted
          && [room.guildA.id, room.guildB.id].includes(getFreshGuildInfo().guildId);
        if (!room || (!room.isOpen && !guildMember)) {
          socket.emit('notification', { message: 'Room not found or is closed.', type: 'error' });
          return;
        }
            
        if (room.gcTimeout) {
          clearTimeout(room.gcTimeout);
          room.gcTimeout = null;
        }
            
        if (Object.values(room.activePlayerSlots).every(s => s !== null)) {
          socket.emit('notification', { message: 'Room is full.', type: 'error' });
          return;
        }

        socket.roomId = room.id;
        socket.join(room.id);
        sendInitConfig(socket, room);
        updateLobbyList();
        // Guild war: take the first free slot on your guild's side at once.
        if (guildMember) {
          const lo = getFreshGuildInfo().guildId === room.guildA.id ? 1 : room.teamSize + 1;
          for (let f = lo; f < lo + room.teamSize; f++) {
            if (room.activePlayerSlots[f] === null) { joinFaction({ factionId: f }); break; }
          }
        }
      } catch (err) {
        log('error', `[ERROR] join-room failed for socket ${socket.id}:`, err.message);
        socket.emit('notification', { message: 'Server error occurred', type: 'error' });
      }
    });

    socket.on('quick-play', ({ nickname, mode } = {}) => {
      leaveRankedQueue(socket); // can't wait for ranked while playing another match
      if (holdsSlotInRoom()) {
        socket.emit('notification', { message: 'You are already in a match. Leave it first.', type: 'error' });
        return;
      }
      if (socket.displayName) { nickname = socket.displayName; }
      try {
        // Two Quick Battle queues: standard (20) and Mega (64). Each fills its
        // own rooms; empty slots become bots when the countdown ends.
        const size = mode === 'mega' ? MEGA_PLAY_PLAYERS : QUICK_PLAY_PLAYERS;
        let room = Object.values(activeRooms)
          .find(r => r.isQuickPlay && r.isOpen && !r.gcTimeout && r.maxPlayers === size);
        if (!room) {
          room = createRoom(mode === 'mega' ? 'Mega Battle' : 'Quick Game', randomMapId(), size, true);
          if (!room) {
            // The client hid the menu when it asked; this brings it back.
            socket.emit('matchmaking-failed', { message: 'Servers are full right now. Please try again in a minute.' });
            return;
          }
        }
            
        let availableSlots = [];
        for (let fid of room.sim.factions) {
          if (room.activePlayerSlots[fid] === null) { availableSlots.push(fid); }
        }
            
        if (availableSlots.length === 0) {
          socket.emit('notification', { message: 'Room is full.', type: 'error' });
          return;
        }
            
        let chosenFid = availableSlots[Math.floor(Math.random() * availableSlots.length)];
        const freshGuild = getFreshGuildInfo();

        room.activePlayerSlots[chosenFid] = {
          socketId: socket.id,
          nickname: cleanNickname(nickname, 'Player'),
          guildTag: freshGuild.guildTag,
        };
        room.humanPlayers[chosenFid] = { userId: socket.userId || null, isGuest: !socket.userId, status: 'playing' };
            
        if (!room.matchStarted) {
          room.sim.wipeFactionSpawn(chosenFid);
        }
            
        socket.roomId = room.id;
        socket.join(room.id);
        sendInitConfig(socket, room);
            
        socket.assignedFaction = chosenFid;
        const token = crypto.randomUUID();
        room.reconnectTokens.set(token, { roomId: room.id, factionId: chosenFid, nickname: room.activePlayerSlots[chosenFid].nickname });
        socket.emit('join-success', { factionId: chosenFid, nickname: room.activePlayerSlots[chosenFid].nickname, isQuickPlay: room.isQuickPlay, reconnectToken: token });
        io.to(room.id).emit('slots-update', room.activePlayerSlots);
        updateLobbyList();
      } catch (err) {
        log('error', `[ERROR] quick-play failed for socket ${socket.id}:`, err.message);
        socket.emit('notification', { message: 'Server error occurred', type: 'error' });
      }
    });

    socket.on('start-custom-game', () => {
      try {
        let room = activeRooms[socket.roomId];
        if (!room || room.isQuickPlay || room.countdownInterval || room.matchStarted) { return; }
        
        if (room.hostSocketId && socket.id !== room.hostSocketId) {
          socket.emit('notification', { message: 'Only the host can start the game.', type: 'error' });
          return;
        }
            
        let ticks = 5;
        io.to(room.id).emit('custom-game-starting');
        io.to(room.id).emit('waiting-tick', ticks);
            
        for (let fid of room.sim.factions) {
          if (room.activePlayerSlots[fid] === null) {
            let spawnR = Math.floor(Math.random() * 80) + 10;
            let spawnC = Math.floor(Math.random() * 80) + 10;
            room.sim.forceSpawnPlayer(fid, spawnR, spawnC);
          }
        }
            
        room.countdownInterval = setInterval(() => {
          ticks--;
          io.to(room.id).emit('waiting-tick', ticks);
                
          if (ticks <= 0) {
            clearInterval(room.countdownInterval);
            startSpawnSelection(room);
          }
        }, 1000);
      } catch (err) {
        log('error', `[ERROR] start-custom-game failed for socket ${socket.id}:`, err.message);
        socket.emit('notification', { message: 'Server error occurred', type: 'error' });
      }
    });

    socket.on('join-faction', (data) => joinFaction(data || {}));
    function joinFaction({ factionId, nickname, doctrine }) {
      if (socket.displayName) { nickname = socket.displayName; }
      try {
        let room = activeRooms[socket.roomId];
        if (!room) { return; }
        let sim = room.sim;
        const freshGuild = getFreshGuildInfo();
            
        let fid = parseInt(factionId);
        if (isNaN(fid) || !sim.factions.includes(fid)) {
          socket.emit('notification', { message: 'Invalid faction selection.', type: 'error' });
          return;
        }
            
        if (room.isGuildWar) {
          let userGuildTag = freshGuild.guildTag;
          let isGuildA = userGuildTag === room.guildA.tag;
          let isGuildB = userGuildTag === room.guildB.tag;
                
          if (!isGuildA && !isGuildB) {
            socket.emit('notification', { message: 'You are not in the participating guilds.', type: 'error' });
            return;
          }
                
          let minFid = isGuildA ? 1 : room.teamSize + 1;
          let maxFid = isGuildA ? room.teamSize : room.teamSize * 2;
                
          if (fid < minFid || fid > maxFid) {
            socket.emit('notification', { message: 'You must select a slot assigned to your guild.', type: 'error' });
            return;
          }
        }

        if (room.activePlayerSlots[fid] !== null && room.activePlayerSlots[fid].socketId !== socket.id) {
          socket.emit('notification', { message: 'Faction slot is already taken!', type: 'error' });
          return;
        }

        for (let f in room.activePlayerSlots) {
          if (room.activePlayerSlots[f] && room.activePlayerSlots[f].socketId === socket.id) {
            room.activePlayerSlots[f] = null;
          }
        }

        room.activePlayerSlots[fid] = {
          socketId: socket.id,
          nickname: cleanNickname(nickname, `Player ${fid}`),
          guildTag: freshGuild.guildTag,
        };
        room.humanPlayers[fid] = { userId: socket.userId || null, isGuest: !socket.userId, status: 'playing' };
        sim.doctrines[fid] = doctrine || 'balanced';

        socket.assignedFaction = fid;
        const token = crypto.randomUUID();
        room.reconnectTokens.set(token, { roomId: room.id, factionId: fid, nickname: room.activePlayerSlots[fid].nickname });
        socket.emit('join-success', { factionId: fid, nickname: room.activePlayerSlots[fid].nickname, isQuickPlay: room.isQuickPlay, reconnectToken: token });
        io.to(room.id).emit('slots-update', room.activePlayerSlots);
        log('info', `[Room ${room.id}] Faction ${fid} claimed by ${socket.id} (${nickname})`);
        updateLobbyList();
            
        // Full roster: the war starts now (otherwise at the muster deadline).
        if (room.isGuildWar && !room.countdownInterval && !room.matchStarted
            && Object.values(room.activePlayerSlots).every(s => s !== null)) {
          startGuildWarCountdown(room);
        }
      } catch (err) {
        log('error', `[ERROR] join-faction failed for socket ${socket.id}:`, err.message);
        socket.emit('notification', { message: 'Server error occurred', type: 'error' });
      }
    }

    socket.on('select-spawn', ({ row, col }) => {
      try {
        const room = activeRooms[socket.roomId];
        if (!room || room.phase !== 'SPAWN_SELECTION') return;
        
        const fid = getFactionForSocket(room, socket.id);
        if (!fid) return;

        // Ensure within bounds
        if (typeof row !== 'number' || typeof col !== 'number') return;
        if (!Number.isFinite(row) || !Number.isFinite(col)) return;
        row = Math.floor(row);
        col = Math.floor(col);
        if (row < 0 || row >= room.mapHeight || col < 0 || col >= room.mapWidth) return;

        // A spawn on water claims no cells, leaving the player dead on arrival.
        if (!isLandAt(room.preset, room.mapSize, row, col)) {
          socket.emit('spawn-rejected', 'You cannot deploy on water. Pick a land cell.');
          return;
        }

        // Check if another player is too close
        for (let [otherFid, pos] of room.spawnSelections.entries()) {
          if (otherFid === fid) continue;
          let distSq = (pos.row - row) ** 2 + (pos.col - col) ** 2;
          if (distSq < room.safeZoneRadius * room.safeZoneRadius) {
            socket.emit('spawn-rejected', 'Too close to another player\'s safe zone.');
            return;
          }
        }

        room.spawnSelections.set(fid, { row, col });

        // Broadcast the updated selections to everyone
        let selectionsObj = {};
        for (let [f, p] of room.spawnSelections.entries()) selectionsObj[f] = p;
        io.to(room.id).emit('spawn-selections-update', selectionsObj);

        // Once every human has picked, don't make them sit through the rest of
        // the countdown (a short beat so the last pick is visible, and still
        // changeable, before the drop).
        const humansReady = Object.entries(room.activePlayerSlots)
          .filter(([, slot]) => slot && !slot.isBot)
          .every(([f]) => room.spawnSelections.has(parseInt(f)));
        if (humansReady && !room.spawnEarlyTimer) {
          room.spawnEarlyTimer = setTimeout(() => {
            if (room.phase !== 'SPAWN_SELECTION' || !activeRooms[room.id]) return;
            if (room.countdownInterval) { clearInterval(room.countdownInterval); }
            finalizeSpawns(room);
          }, 1500);
        }
        
      } catch (err) {
        log('error', `[ERROR] select-spawn failed:`, err.message);
      }
    });

    // ---------- SIM INPUT (server-authoritative simulation) ----------
    socket.on('sim-input', (input) => {
      try {
        if (!input || typeof input.type !== 'string') { return; }

        // Drop excess messages silently — burst protection without disconnecting
        const limit = inputRateLimits[input.type];
        if (limit) {
          const now = Date.now();
          if (now - limit.lastMs < limit.minIntervalMs) { return; }
          limit.lastMs = now;
        }

        const room = activeRooms[socket.roomId];
        if (!room || !room.matchStarted || !room.simReal) { return; }
        // Use server-stored faction; never trust a client-supplied factionId.
        const fid = socket.assignedFaction || getFactionForSocket(room, socket.id);
        if (!fid) { return; }
        room.simReal.handleInput(fid, input);
      } catch (err) {
        log('error', `[ERROR] sim-input failed for socket ${socket.id}:`, err.message);
      }
    });

    // ---------- DEV SIMULATOR END GAME ----------
    socket.on('dev-simulate-game-over', ({ result }) => {
      if (process.env.NODE_ENV === 'production') { return; }
      if (process.env.DEV_SANDBOX !== '1') { return; }
      try {
        let room = activeRooms[socket.roomId];
        if (!room || !room.matchStarted) { return; }
        
        let fid = getFactionForSocket(room, socket.id);
        if (!fid) { return; }
        
        let winnerFaction = fid;
        if (result === 'loss') {
          // Find another faction to be the winner
          winnerFaction = room.sim.factions.find(f => f !== fid) || 2;
        }
        
        log('info', `[DEV] Simulating game over: Winner faction is ${winnerFaction}`);
        handleGameOver(room, winnerFaction);
      } catch (err) {
        log('error', `[ERROR] dev-simulate-game-over failed:`, err.message);
      }
    });

    // ---------- GUILD CHAT -----------
    socket.on('guild-chat', (data) => {
      if (!userId) {return;}
      
      const parsed = guildChatSchema.safeParse(data);
      if (!parsed.success) {return;}
        
      const userObj = findUserById(userId);
      if (!userObj || !userObj.guild_id) { return; }
      const currentGuildId = userObj.guild_id;
        
      const now = Date.now();
      if (now - socket.lastChatTimestamp < 1000) {
        socket.emit('guild-chat-error', 'You are sending messages too fast.');
        return;
      }
      socket.lastChatTimestamp = now;
        
      let msg = parsed.data.message.trim();
      if (msg.length === 0) { return; }
        
      // No HTML escaping here: the client renders chat with textContent, so
      // escaping would show "&lt;3" instead of "<3".
      if (profanityFilter.isProfane(msg)) {
        msg = profanityFilter.clean(msg);
      }
        
      try {
        const savedMsg = addGuildMessage(currentGuildId, userId, msg);
        io.to(`guild:${currentGuildId}`).emit('guild-chat-message', {
          id: savedMsg.id,
          userId: savedMsg.user_id,
          displayName: savedMsg.display_name,
          message: savedMsg.message,
          timestamp: savedMsg.created_at,
        });
      } catch (err) {
        log('error', 'Failed to save guild chat:', err);
      }
    });

    // ---------- GUILD WARS ----------
    socket.on('guild-war-queue', ({ teamSize }) => {
      if (!userId) { return; }
      const freshGuild = getFreshGuildInfo();
      if (!freshGuild.guildId) { return; }
      let profile = getUserProfile(username);
      if (!profile) { return; }
      if (profile.guild_role !== 'leader' && profile.guild_role !== 'officer') {
        socket.emit('notification', { message: 'Only leaders and officers can queue for Guild Wars.', type: 'error' });
        return;
      }
      if (![2, 3, 5].includes(teamSize)) { return; }
        
      let existing = guildWarQueue.findIndex(q => q.guildId === freshGuild.guildId);
      if (existing !== -1) { guildWarQueue.splice(existing, 1); }
        
      guildWarQueue.push({
        guildId: profile.guild_id,
        guildName: profile.guild_name,
        tag: profile.guild_tag,
        color: profile.guild_color,
        eloRating: profile.guild_elo || 1000,
        teamSize,
        queuedAt: Date.now(),
      });
        
      io.to(`guild:${freshGuild.guildId}`).emit('guild-war-queue-status', { status: 'queued', teamSize });
      log('info', `Guild ${profile.guild_tag} queued for ${teamSize}v${teamSize} Guild War.`);
    });

    socket.on('guild-war-dequeue', () => {
      if (!userId) { return; }
      const freshGuild = getFreshGuildInfo();
      if (!freshGuild.guildId) { return; }
      let profile = getUserProfile(username);
      if (!profile) { return; }
      if (profile.guild_role !== 'leader' && profile.guild_role !== 'officer') { return; }
        
      let existing = guildWarQueue.findIndex(q => q.guildId === freshGuild.guildId);
      if (existing !== -1) {
        guildWarQueue.splice(existing, 1);
        io.to(`guild:${freshGuild.guildId}`).emit('guild-war-queue-status', { status: 'idle' });
        log('info', `Guild ${profile.guild_tag} left the Guild War queue.`);
      }
    });

    socket.on('guild-war-challenge', ({ tag, teamSize }) => {
      if (!userId) { return; }
      const freshGuild = getFreshGuildInfo();
      if (!freshGuild.guildId) { return; }
      let profile = getUserProfile(username);
      if (!profile) { return; }
      if (profile.guild_role !== 'leader' && profile.guild_role !== 'officer') { return; }
      if (![2, 3, 5].includes(teamSize)) { return; }
        
      if (typeof tag !== 'string' || tag.length > 5) {return;}
      let targetGuild = findGuildByTag(tag.toUpperCase());
      if (!targetGuild) {
        socket.emit('notification', { message: 'Guild not found.', type: 'error' });
        return;
      }
      if (targetGuild.id === freshGuild.guildId) {
        socket.emit('notification', { message: 'Cannot challenge your own guild.', type: 'error' });
        return;
      }
        
      // Remember the challenge: only a challenge that was really sent (and is
      // under a minute old) can be accepted.
      pendingWarChallenges.set(`${profile.guild_id}>${targetGuild.id}`, { teamSize, expiresAt: Date.now() + WAR_CHALLENGE_TTL_MS });
      io.to(`guild:${targetGuild.id}`).emit('guild-war-challenge-received', {
        challengerGuild: {
          id: profile.guild_id,
          name: profile.guild_name,
          tag: profile.guild_tag,
          eloRating: profile.guild_elo || 1000,
        },
        teamSize,
      });
      socket.emit('notification', { message: `Challenge sent to [${targetGuild.tag}]`, type: 'success' });
    });

    socket.on('guild-war-accept', (data) => {
      if (!userId) { return; }
      const freshGuild = getFreshGuildInfo();
      if (!freshGuild.guildId) { return; }
      let profile = getUserProfile(username);
      if (!profile) { return; }
      if (profile.guild_role !== 'leader' && profile.guild_role !== 'officer') { return; }
      const challengerGuildId = parseInt(data && data.challengerGuildId, 10);
      const key = `${challengerGuildId}>${freshGuild.guildId}`;
      const challenge = pendingWarChallenges.get(key);
      pendingWarChallenges.delete(key);
      if (!challenge || challenge.expiresAt < Date.now()) {
        socket.emit('notification', { message: 'That challenge has expired.', type: 'error' });
        return;
      }
      const teamSize = challenge.teamSize;

      let targetGuild = findGuildById(freshGuild.guildId);
      let challengerGuild = findGuildById(challengerGuildId);
        
      if (!targetGuild || !challengerGuild) {
        socket.emit('notification', { message: 'Failed to create match.', type: 'error' });
        return;
      }
        
      createGuildWarRoom(challengerGuild, targetGuild, teamSize);
      log('info', `Direct Guild War Match created: [${challengerGuild.tag}] vs [${targetGuild.tag}]`);
    });

    // ---------- RANKED MATCHMAKING ----------
    socket.on('join-ranked-queue', () => {
      const refuse = (message) => {
        socket.emit('notification', { message, type: 'error' });
        socket.emit('ranked-queue-left', { reason: message });
      };
      if (!socket.userId) { refuse('Log in to play ranked.'); return; }
      if (holdsSlotInRoom()) { refuse('You are already in a match.'); return; }

      const userObj = findUserById(socket.userId);
      if (!userObj) { refuse('Account not found.'); return; }

      // One entry per account (and per socket).
      if (!rankedQueue.some(p => p.socket.id === socket.id || p.socket.userId === socket.userId)) {
        rankedQueue.push({ socket, elo: userObj.elo_rating, joinedAt: Date.now() });
        log('info', `User ${socket.userId} (rating ${userObj.elo_rating}) joined ranked queue. Total: ${rankedQueue.length}`);
      }
      matchmakeRanked();
    });

    socket.on('leave-ranked-queue', () => {
      if (leaveRankedQueue(socket)) log('info', `User ${socket.userId} left ranked queue.`);
    });

    // ---------- DISCONNECT ----------
    socket.on('disconnect', () => {
      log('debug', `Socket disconnected: ${socket.id}`);
        
      // Only if this is still the user's current socket: after a re-login the
      // map already points at the new connection, which is online.
      if (userId && userSocketMap.get(userId) === socket.id) {
        userSocketMap.delete(userId);
        const freshGuild = getFreshGuildInfo();
        if (freshGuild.guildId) {
          io.to(`guild:${freshGuild.guildId}`).emit('guild-member-offline', { userId });
        }
      }

      leaveRankedQueue(socket);

      try {
        if (socket.roomId) {
          let room = activeRooms[socket.roomId];
          if (!room) { return; }

          handlePlayerDisconnect(room, socket.id, false);
            
          io.to(room.id).emit('slots-update', room.activePlayerSlots);
          updateLobbyList();
        }
      } catch (err) {
        log('error', `[ERROR] disconnect handler failed for socket ${socket.id}:`, err.message);
      }
    });

    socket.on('quit-game', (ack) => {
      const done = () => { if (typeof ack === 'function') ack(); };
      try {
        let room = activeRooms[socket.roomId];
        if (!room) { done(); return; }
        handlePlayerDisconnect(room, socket.id, true);
        io.to(room.id).emit('slots-update', room.activePlayerSlots);
        socket.assignedFaction = null;
        socket.roomId = null;
        socket.leave(room.id);
      } catch (err) {
        log('error', '[quit-game] handler failed:', err.message);
      }
      done();
    });

    socket.on('reconnect-to-game', (payload) => {
      try {
        const token = payload && payload.token;
        if (typeof token !== 'string' || token.length > 100) {return;}
        let found = false;
        for (let roomId in activeRooms) {
          let room = activeRooms[roomId];
          if (!room.reconnectTokens.has(token)) continue;
          let data = room.reconnectTokens.get(token);
          let fid = data.factionId;
          const slot = room.activePlayerSlots[fid];
          if (!slot || slot.left) continue;

          // A previous socket of this player may still look connected (the
          // server notices a dead connection only at the next ping).
          if (slot.socketId && slot.socketId !== socket.id) {
            const old = io.sockets.sockets.get(slot.socketId);
            if (old) { old.roomId = null; old.leave(room.id); }
          }
          slot.socketId = socket.id;
          socket.assignedFaction = fid;
          socket.roomId = room.id;
          socket.join(room.id);
          reclaimSlot(room, fid);

          sendInitConfig(socket, room);
          const inMatch = !!(room.matchStarted && room.simReal);
          socket.emit('reconnect-success', {
            factionId: fid, nickname: data.nickname, isQuickPlay: room.isQuickPlay,
            inMatch, phase: room.phase,
          });
          if (inMatch) {
            // Deltas only carry changes: bring this client fully up to date.
            room.simReal.sendFullState(socket.id);
          } else if (room.phase === 'SPAWN_SELECTION') {
            // Back into the spawn picker with the time that is left.
            socket.emit('spawn-selection-start', {
              duration: Math.max(1, room.spawnTicksLeft || 1), mapId: room.preset, safeZoneRadius: room.safeZoneRadius,
              mapWidth: room.mapWidth, mapHeight: room.mapHeight,
            });
            const selections = {};
            for (let [f, p] of room.spawnSelections.entries()) selections[f] = p;
            socket.emit('spawn-selections-update', selections);
          }
          io.to(room.id).emit('slots-update', room.activePlayerSlots);
          found = true;
          log('info', `[RECONNECT] Faction ${fid} back in room ${roomId}`);
          break;
        }
        if (!found) {
          const ended = endedMatchFor(token);
          socket.emit('reconnect-failed', ended
            ? { reason: 'ended', winnerName: ended.winnerName }
            : { reason: 'expired' });
        }
      } catch (err) {
        log('error', '[reconnect-to-game] handler failed:', err.message);
      }
    });
  });
}
