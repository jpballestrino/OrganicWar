import { activeRooms, guildWarQueue, rankedQueue, userSocketMap } from './state.js';
import { handlePlayerDisconnect, sendInitConfig, updateLobbyList, buildLobbyList, createGuildWarRoom, matchmakeRanked, handleGameOver, createRoom, startMatchNow } from './roomManager.js';
import { log } from '../utils/logger.js';
import { io, ipConnectionCounts } from '../server.js';
import { verifyToken } from '../auth.js';
import { findUserById, updateLastLogin, getGuildMessages, getUserProfile, findGuildById, findGuildByTag, addGuildMessage } from '../database.js';
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
  maxPlayers: z.union([z.number().int().min(2).max(20), z.string().regex(/^\d+$/)]),
  preset: z.string().min(1).max(50).optional(),
  nickname: z.string().min(1).max(20).optional(),
});

const guildChatSchema = z.object({
  message: z.string().min(1).max(200),
});

export function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    const ip = socket.handshake.address;
    const count = (ipConnectionCounts.get(ip) || 0) + 1;
    ipConnectionCounts.set(ip, count);
    if (count > 100) {
      log('warn', `[RateLimit] Disconnected ${ip} (too many connections)`);
      socket.disconnect(true);
      return;
    }
    
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
          const guildRoom = `guild:${guildId}`;
          socket.join(guildRoom);
          socket.to(guildRoom).emit('guild-member-online', { userId, displayName });
                
          const rawHistory = getGuildMessages(guildId, 200);
          const history = rawHistory.map(row => ({
            id: row.id,
            userId: row.user_id,
            displayName: row.display_name,
            message: row.message,
            timestamp: row.created_at,
          }));
          socket.emit('guild-chat-history', history);
                
          const roomSockets = io.sockets.adapter.rooms.get(guildRoom);
          const onlineIds = [];
          if (roomSockets) {
            for (const sid of roomSockets) {
              const s = io.sockets.sockets.get(sid);
              if (s && s.userId) { onlineIds.push(s.userId); }
            }
          }
          socket.emit('guild-online-members', onlineIds);
        }
      } else {
        log('warn', `Invalid token provided by socket ${socket.id}`);
      }
    }
    
    socket.userId = userId;
    log('info', `Socket connected: ${socket.id} (User ID: ${socket.userId || 'guest'})`);

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
      try {
        const parsed = createRoomSchema.safeParse(data);
        if (!parsed.success) {
          socket.emit('notification', { message: 'Invalid room settings.', type: 'error' });
          return;
        }
        const { name, maxPlayers, preset, nickname } = parsed.data;
        const safeName = sanitizeString(name);
        const freshGuild = getFreshGuildInfo();
        const effectiveNickname = socket.displayName || nickname || 'Host';
        let room = createRoom(safeName, preset || 'north_america', parseInt(maxPlayers) || 5, false);
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
      try {
        if (typeof roomId !== 'string' || roomId.length > 10) {return;}
        let room = activeRooms[roomId];
        if (!room || !room.isOpen) {
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
      } catch (err) {
        log('error', `[ERROR] join-room failed for socket ${socket.id}:`, err.message);
        socket.emit('notification', { message: 'Server error occurred', type: 'error' });
      }
    });

    socket.on('quick-play', ({ nickname }) => {
      if (socket.displayName) { nickname = socket.displayName; }
      try {
        let room = Object.values(activeRooms).find(r => r.isQuickPlay && r.isOpen && !r.gcTimeout);
        if (!room) {
          room = createRoom('Quick Game', 'north_america', 20, true);
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
            
        handlePlayerDisconnect(room, socket.id, false);
            
        room.activePlayerSlots[chosenFid] = {
          socketId: socket.id,
          nickname: nickname || 'Player',
          guildTag: freshGuild.guildTag,
        };
        room.humanPlayers[chosenFid] = { userId: socket.userId || null, isGuest: !socket.userId, status: 'playing' };
            
        if (!room.matchStarted) {
          room.sim.wipeFactionSpawn(chosenFid);
        }
            
        socket.roomId = room.id;
        socket.join(room.id);
        sendInitConfig(socket, room);
            
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
            startMatchNow(room);
          }
        }, 1000);
      } catch (err) {
        log('error', `[ERROR] start-custom-game failed for socket ${socket.id}:`, err.message);
        socket.emit('notification', { message: 'Server error occurred', type: 'error' });
      }
    });

    socket.on('join-faction', ({ factionId, nickname, doctrine }) => {
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
          nickname: nickname || `Player ${fid}`,
          guildTag: freshGuild.guildTag,
        };
        room.humanPlayers[fid] = { userId: socket.userId || null, isGuest: !socket.userId, status: 'playing' };
        sim.doctrines[fid] = doctrine || 'balanced';

        const token = crypto.randomUUID();
        room.reconnectTokens.set(token, { roomId: room.id, factionId: fid, nickname: room.activePlayerSlots[fid].nickname });
        socket.emit('join-success', { factionId: fid, nickname: room.activePlayerSlots[fid].nickname, isQuickPlay: room.isQuickPlay, reconnectToken: token });
        io.to(room.id).emit('slots-update', room.activePlayerSlots);
        log('info', `[Room ${room.id}] Faction ${fid} claimed by ${socket.id} (${nickname})`);
        updateLobbyList();
            
        if (room.isGuildWar && !room.countdownInterval && !room.matchStarted) {
          if (Object.values(room.activePlayerSlots).every(s => s !== null)) {
            let ticks = 5;
            io.to(room.id).emit('custom-game-starting');
            io.to(room.id).emit('waiting-tick', ticks);
            room.countdownInterval = setInterval(() => {
              ticks--;
              io.to(room.id).emit('waiting-tick', ticks);
              if (ticks <= 0) {
                clearInterval(room.countdownInterval);
                startMatchNow(room);
              }
            }, 1000);
          }
        }
      } catch (err) {
        log('error', `[ERROR] join-faction failed for socket ${socket.id}:`, err.message);
        socket.emit('notification', { message: 'Server error occurred', type: 'error' });
      }
    });

    // ---------- DEV SIMULATOR END GAME ----------
    socket.on('dev-simulate-game-over', ({ result }) => {
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
        
      msg = msg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
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

    socket.on('guild-war-accept', ({ challengerGuildId, teamSize }) => {
      if (!userId) { return; }
      const freshGuild = getFreshGuildInfo();
      if (!freshGuild.guildId) { return; }
      let profile = getUserProfile(username);
      if (!profile) { return; }
      if (profile.guild_role !== 'leader' && profile.guild_role !== 'officer') { return; }
        
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
      if (!socket.userId) {
        socket.emit('notification', { message: 'Must be logged in to play ranked.', type: 'error' });
        return;
      }
        
      if (socket.roomId) {
        socket.emit('notification', { message: 'You are already in a room.', type: 'error' });
        return;
      }

      const userObj = findUserById(socket.userId);
      if (!userObj) { return; }

      if (!rankedQueue.some(p => p.socket.id === socket.id)) {
        rankedQueue.push({ socket, elo: userObj.elo_rating, joinedAt: Date.now() });
            
        for (let p of rankedQueue) {
          p.socket.emit('ranked-queue-update', { count: rankedQueue.length, required: 2 });
        }
        log('info', `User ${socket.userId} joined ranked queue. Total: ${rankedQueue.length}`);
        matchmakeRanked();
      }
    });

    socket.on('leave-ranked-queue', () => {
      let idx = rankedQueue.findIndex(p => p.socket.id === socket.id);
      if (idx !== -1) {
        rankedQueue.splice(idx, 1);
        for (let p of rankedQueue) {
          p.socket.emit('ranked-queue-update', { count: rankedQueue.length, required: 2 });
        }
        log('info', `User ${socket.userId} left ranked queue.`);
      }
    });

    // ---------- DISCONNECT ----------
    socket.on('disconnect', () => {
      log('debug', `Socket disconnected: ${socket.id}`);
        
      if (userId) {
        userSocketMap.delete(userId);
        const freshGuild = getFreshGuildInfo();
        if (freshGuild.guildId) {
          io.to(`guild:${freshGuild.guildId}`).emit('guild-member-offline', { userId });
        }
      }

      let idx = rankedQueue.findIndex(p => p.socket.id === socket.id);
      if (idx !== -1) {
        rankedQueue.splice(idx, 1);
        for (let p of rankedQueue) {
          p.socket.emit('ranked-queue-update', { count: rankedQueue.length, required: 2 });
        }
      }

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

    socket.on('quit-game', () => {
      try {
        let room = activeRooms[socket.roomId];
        if (!room) { return; }
        handlePlayerDisconnect(room, socket.id, true);
        io.to(room.id).emit('slots-update', room.activePlayerSlots);
        socket.roomId = null;
      } catch (err) {
        log('error', '[quit-game] handler failed:', err.message);
      }
    });

    socket.on('reconnect-to-game', ({ token }) => {
      try {
        if (typeof token !== 'string' || token.length > 100) {return;}
        log('info', `[RECONNECT] Token received: ${token}`);
        let found = false;
        for (let roomId in activeRooms) {
          let room = activeRooms[roomId];
          if (room.reconnectTokens.has(token)) {
            let data = room.reconnectTokens.get(token);
            let fid = data.factionId;
            log('info', `[RECONNECT] Found token in room ${roomId} for faction ${fid}`);
                    
            if (room.activePlayerSlots[fid]) {
              log('info', `[RECONNECT] Slot ${fid} exists. Reclaiming.`);
              if (room.disconnectTimers[fid]) {
                clearTimeout(room.disconnectTimers[fid]);
                delete room.disconnectTimers[fid];
              }
                        
              room.activePlayerSlots[fid].socketId = socket.id;
              room.activePlayerSlots[fid].disconnected = false;
                        
              socket.roomId = room.id;
              socket.join(room.id);
                        
              sendInitConfig(socket, room);
              socket.emit('reconnect-success', { factionId: fid, nickname: data.nickname, isQuickPlay: room.isQuickPlay });
              io.to(room.id).emit('slots-update', room.activePlayerSlots);
              found = true;
              log('info', `[RECONNECT] Success for ${fid}`);
              break;
            }
          }
        }
        if (!found) {
          log('warn', '[RECONNECT] Token not found! Failing.');
          socket.emit('reconnect-failed');
          socket.emit('notification', { message: 'Session expired. Please start a new game.', type: 'error' });
        }
      } catch (err) {
        log('error', '[reconnect-to-game] handler failed:', err.message);
      }
    });
  });
}
