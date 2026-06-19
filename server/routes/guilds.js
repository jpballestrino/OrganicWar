import express from 'express';
import { verifyToken } from '../auth.js';
import {
  createGuild, findGuildById, getGuildMembers, searchGuilds, getOpenGuildsPage,
  findUserByUsername, findUserById, findInviteById, respondToGuildInvite,
  addGuildMember, removeGuildMember, promoteGuildMember,
  updateGuildSettings, transferLeadership, disbandGuild,
  createGuildInvite, getPendingInvites,
  createGuildRequest, getGuildRequests, findGuildRequestById, respondToGuildRequest,
} from '../database.js';
import { userSocketMap } from '../game/state.js';
import { isProfane } from '../utils/contentFilter.js';

// Shared guild field validation, used by both create and update routes.
// `requireNameTag` is true on create (name+tag mandatory) and false on update
// (every field optional — only validate the ones present). Returns an error
// string, or null when all supplied fields are valid.
function validateGuildFields({ name, tag, description, color }, { requireNameTag }) {
  if (requireNameTag || name !== undefined) {
    if (typeof name !== 'string' || name.length < 3 || name.length > 25 || /[<>]/.test(name)) {
      return 'Name must be 3-25 chars and cannot contain < or >.';
    }
    if (isProfane(name)) return 'Guild name contains inappropriate content.';
  }
  if (requireNameTag || tag !== undefined) {
    if (typeof tag !== 'string' || tag.length < 2 || tag.length > 5 || !/^[A-Z0-9]+$/i.test(tag)) {
      return 'Tag must be 2-5 alphanumeric chars.';
    }
    if (isProfane(tag)) return 'Guild tag contains inappropriate content.';
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
    return 'Description must be a string up to 500 characters.';
  }
  if (description !== undefined && isProfane(description)) {
    return 'Guild description contains inappropriate content.';
  }
  if (color !== undefined && (typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color))) {
    return 'Color must be a hex code like #ffc107.';
  }
  return null;
}

export default function(io) {
  const router = express.Router();

  // Authentication Middleware
  const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header.' });
    }
    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);
    if (!payload || !payload.userId) {
      return res.status(401).json({ error: 'Invalid token.' });
    }
        
    const user = findUserById(payload.userId);
    if (!user) {return res.status(401).json({ error: 'User not found.' });}
        
    req.user = user;
    next();
  };

  // Helper: Find member role
  const getRole = (members, userId) => {
    const m = members.find(m => m.user_id === userId);
    return m ? m.role : null;
  };

  // Helper: Emit to online guild members
  const emitToGuild = (guildId, eventName, data) => {
    const members = getGuildMembers(guildId);
    members.forEach(m => {
      const socketId = userSocketMap.get(m.user_id);
      if (socketId) {
        io.to(socketId).emit(eventName, data);
      }
    });
  };

  // POST /api/guilds - Create guild
  router.post('/', requireAuth, (req, res) => {
    if (req.user.guild_id) {
      return res.status(400).json({ error: 'You are already in a guild.' });
    }
        
    let { name, tag, description, color, isOpen } = req.body;
    const validationError = validateGuildFields(req.body, { requireNameTag: true });
    if (validationError) { return res.status(400).json({ error: validationError }); }
    tag = tag.toUpperCase();

    try {
      const guild = createGuild(name, tag, description || '', req.user.id, color || '#ffc107', isOpen ? 1 : 0);
            
      // Join socket to guild room
      const socketId = userSocketMap.get(req.user.id);
      if (socketId) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.join(`guild:${guild.id}`);
        }
      }
            
      res.json({ guild });
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ error: 'Guild name or tag already exists.' });
      }
      res.status(500).json({ error: 'Failed to create guild.' });
    }
  });

  // GET /api/guilds/open - Paginated list of open, non-full guilds
  router.get('/open', (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const search = (req.query.search || '').trim().slice(0, 50);
      const { rows, total } = getOpenGuildsPage(search, page, 10);
      res.json({ guilds: rows, total, page, pages: Math.max(1, Math.ceil(total / 10)) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch open guilds.' });
    }
  });

  // GET /api/guilds/search - Search guilds
  router.get('/search', (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 1) {return res.json({ guilds: [] });}
        
    try {
      const guilds = searchGuilds(query);
      res.json({ guilds });
    } catch (err) {
      res.status(500).json({ error: 'Search failed.' });
    }
  });

  // GET /api/guilds/:id - Get guild details
  router.get('/:id', (req, res) => {
    try {
      const guild = findGuildById(req.params.id);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
      res.json({ guild });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch guild.' });
    }
  });

  // PUT /api/guilds/:id - Update guild settings
  router.put('/:id', requireAuth, (req, res) => {
    try {
      const guild = findGuildById(req.params.id);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
            
      const role = getRole(guild.members, req.user.id);
      if (role !== 'leader' && role !== 'officer') {
        return res.status(403).json({ error: 'Only leaders or officers can update settings.' });
      }
            
      const { name, tag, description, color, isOpen, maxMembers } = req.body;
      if (maxMembers !== undefined && (typeof maxMembers !== 'number' || maxMembers < 2 || maxMembers > 20)) {
        return res.status(400).json({ error: 'maxMembers must be between 2 and 20.' });
      }
      const validationError = validateGuildFields(req.body, { requireNameTag: false });
      if (validationError) { return res.status(400).json({ error: validationError }); }
      updateGuildSettings(
        guild.id, 
        name !== undefined ? name : guild.name,
        tag !== undefined ? tag.toUpperCase() : guild.tag,
        description !== undefined ? description : guild.description,
        color !== undefined ? color : guild.color,
        isOpen !== undefined ? (isOpen ? 1 : 0) : guild.is_open,
        maxMembers !== undefined ? maxMembers : guild.max_members,
      );
            
      emitToGuild(guild.id, 'guild-update', { type: 'settings', guildId: guild.id });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Update failed.' });
    }
  });

  // POST /api/guilds/:id/invite - Invite a player
  router.post('/:id/invite', requireAuth, (req, res) => {
    try {
      const guild = findGuildById(req.params.id);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
            
      const role = getRole(guild.members, req.user.id);
      if (role !== 'leader' && role !== 'officer') {
        return res.status(403).json({ error: 'Only leaders or officers can invite.' });
      }
            
      if (guild.member_count >= guild.max_members) {
        return res.status(400).json({ error: 'Guild is full.' });
      }

      const { username } = req.body;
      const targetUser = findUserByUsername(username);
      if (!targetUser) {return res.status(404).json({ error: 'Target user not found.' });}
      if (targetUser.guild_id) {return res.status(400).json({ error: 'User is already in a guild.' });}
            
      const pending = getPendingInvites(targetUser.id);
      if (pending.some(i => i.guild_id === guild.id)) {
        return res.status(400).json({ error: 'Invite already sent.' });
      }
            
      const invite = createGuildInvite(guild.id, req.user.id, targetUser.id);
            
      const socketId = userSocketMap.get(targetUser.id);
      if (socketId) {
        io.to(socketId).emit('guild-invite', {
          guildName: guild.name,
          guildTag: guild.tag,
          inviterName: req.user.display_name,
          inviteId: invite.id,
        });
      }
            
      res.json({ success: true, invite });
    } catch (err) {
      res.status(500).json({ error: 'Invite failed.' });
    }
  });

  // POST /api/guilds/invites/:inviteId/respond
  router.post('/invites/:inviteId/respond', requireAuth, (req, res) => {
    try {
      const invite = findInviteById(req.params.inviteId);
      if (!invite) {
        return res.status(404).json({ error: 'Invite not found.' });
      }
      if (invite.invitee_id !== req.user.id) {
        return res.status(403).json({ error: 'Not your invite.' });
      }
      if (invite.status !== 'pending') {
        return res.status(400).json({ error: 'Invite already resolved.' });
      }
            
      const { accept } = req.body;
            
      if (accept) {
        if (req.user.guild_id) {
          return res.status(400).json({ error: 'You are already in a guild.' });
        }
        const guild = findGuildById(invite.guild_id);
        if (!guild) {
          return res.status(404).json({ error: 'Guild no longer exists.' });
        }
        if (guild.member_count >= guild.max_members) {
          return res.status(400).json({ error: 'Guild is full.' });
        }
      }
            
      respondToGuildInvite(invite.id, accept, req.user.id, invite.guild_id);
            
      if (accept) {
        emitToGuild(invite.guild_id, 'guild-update', { type: 'join', username: req.user.username });
                
        const socketId = userSocketMap.get(req.user.id);
        if (socketId) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.join(`guild:${invite.guild_id}`);
          }
        }
      }
            
      res.json({ success: true, accepted: accept });
    } catch (err) {
      console.error('Error in POST /api/guilds/invites/:inviteId/respond:', err);
      res.status(500).json({ error: 'Response failed.' });
    }
  });

  // GET /api/users/me/invites
  router.get('/me/invites', requireAuth, (req, res) => {
    try {
      const invites = getPendingInvites(req.user.id);
      res.json({ invites });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load invites.' });
    }
  });

  // POST /api/guilds/:id/request
  router.post('/:id/request', requireAuth, (req, res) => {
    try {
      if (req.user.guild_id) {return res.status(400).json({ error: 'Already in a guild.' });}
            
      const guild = findGuildById(req.params.id);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
      if (guild.is_open) {return res.status(400).json({ error: 'Guild is open. Just join it directly.' });}
      if (guild.member_count >= guild.max_members) {return res.status(400).json({ error: 'Guild is full.' });}
            
      const existingRequests = getGuildRequests(guild.id);
      if (existingRequests.some(r => r.user_id === req.user.id)) {
        return res.status(400).json({ error: 'Request already sent.' });
      }

      const request = createGuildRequest(guild.id, req.user.id);
      res.json({ success: true, request });
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ error: 'Request already sent.' });
      }
      res.status(500).json({ error: 'Request failed.' });
    }
  });

  // GET /api/guilds/:id/requests
  router.get('/:id/requests', requireAuth, (req, res) => {
    try {
      const guildId = parseInt(req.params.id);
      if (req.user.guild_id !== guildId) {return res.status(403).json({ error: 'Not in this guild.' });}
            
      const guild = findGuildById(guildId);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
      const myRole = getRole(guild.members, req.user.id);
      if (myRole !== 'leader' && myRole !== 'officer') {
        return res.status(403).json({ error: 'Only leaders or officers can view requests.' });
      }
            
      const requests = getGuildRequests(guildId);
      res.json({ requests });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load requests.' });
    }
  });

  // POST /api/guilds/requests/:requestId/respond
  router.post('/requests/:requestId/respond', requireAuth, (req, res) => {
    try {
      const request = findGuildRequestById(req.params.requestId);
      if (!request) {return res.status(404).json({ error: 'Request not found.' });}
      if (request.status !== 'pending') {return res.status(400).json({ error: 'Request already resolved.' });}
            
      if (req.user.guild_id !== request.guild_id) {return res.status(403).json({ error: 'Not in this guild.' });}
      const guild = findGuildById(request.guild_id);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
      const myRole = getRole(guild.members, req.user.id);
            
      if (myRole !== 'leader' && myRole !== 'officer') {
        return res.status(403).json({ error: 'Only leaders or officers can respond to requests.' });
      }
            
      const { accept } = req.body;
            
      if (accept) {
        const targetUser = findUserById(request.user_id);
        if (targetUser.guild_id) {
          respondToGuildRequest(request.id, false, request.user_id, request.guild_id);
          return res.status(400).json({ error: 'User is already in a guild.' });
        }
        if (guild.member_count >= guild.max_members) {
          return res.status(400).json({ error: 'Guild is full.' });
        }
      }
            
      respondToGuildRequest(request.id, accept, request.user_id, request.guild_id);
            
      if (accept) {
        const targetUser = findUserById(request.user_id);
        emitToGuild(request.guild_id, 'guild-update', { type: 'join', username: targetUser.username });
        const targetSocketId = userSocketMap.get(targetUser.id);
        if (targetSocketId) {
          io.to(targetSocketId).emit('guild-update', { type: 'join' });
        }
      }
            
      res.json({ success: true, accepted: accept });
    } catch (err) {
      res.status(500).json({ error: 'Response failed.' });
    }
  });

  // POST /api/guilds/:id/join
  router.post('/:id/join', requireAuth, (req, res) => {
    try {
      if (req.user.guild_id) {return res.status(400).json({ error: 'Already in a guild.' });}
            
      const guild = findGuildById(req.params.id);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
      if (!guild.is_open) {return res.status(403).json({ error: 'Guild is not open to public joins.' });}
      if (guild.member_count >= guild.max_members) {return res.status(400).json({ error: 'Guild is full.' });}
            
      addGuildMember(req.user.id, guild.id, 'member');
      emitToGuild(guild.id, 'guild-update', { type: 'join', username: req.user.username });
            
      const socketId = userSocketMap.get(req.user.id);
      if (socketId) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.join(`guild:${guild.id}`);
        }
      }
            
      res.json({ success: true });
    } catch (err) {
      console.error('Error in POST /:id/join:', err);
      res.status(500).json({ error: 'Join failed.' });
    }
  });

  // POST /api/guilds/:id/leave
  router.post('/:id/leave', requireAuth, (req, res) => {
    try {
      const guildId = parseInt(req.params.id);
      if (req.user.guild_id !== guildId) {return res.status(400).json({ error: 'Not in this guild.' });}
            
      const guild = findGuildById(guildId);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
      const role = getRole(guild.members, req.user.id);
            
      if (role === 'leader') {
        const others = guild.members.filter(m => m.user_id !== req.user.id);
        if (others.length === 0) {
          disbandGuild(guildId);
          return res.json({ success: true, disbanded: true });
        } else {
          const nextOfficer = others.find(m => m.role === 'officer');
          const nextLeaderId = nextOfficer ? nextOfficer.user_id : others[0].user_id;
          transferLeadership(nextLeaderId, guildId);
        }
      }
            
      removeGuildMember(req.user.id, guildId);
      emitToGuild(guildId, 'guild-update', { type: 'leave', username: req.user.username });
            
      const socketId = userSocketMap.get(req.user.id);
      if (socketId) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.leave(`guild:${guildId}`);
        }
      }
            
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Leave failed.' });
    }
  });

  // POST /api/guilds/:id/kick
  router.post('/:id/kick', requireAuth, (req, res) => {
    try {
      const guildId = parseInt(req.params.id);
      const guild = findGuildById(guildId);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
            
      const myRole = getRole(guild.members, req.user.id);
      if (myRole !== 'leader' && myRole !== 'officer') {
        return res.status(403).json({ error: 'Not authorized to kick.' });
      }
            
      const { userId } = req.body;
      if (parseInt(userId) === req.user.id) {return res.status(400).json({ error: "Cannot kick yourself. Use 'Leave' instead." });}
      const targetRole = getRole(guild.members, userId);
      if (!targetRole) {return res.status(404).json({ error: 'User not in guild.' });}
            
      if (myRole === 'officer' && (targetRole === 'leader' || targetRole === 'officer')) {
        return res.status(403).json({ error: 'Officers cannot kick other officers or leaders.' });
      }
            
      removeGuildMember(userId, guildId);
      emitToGuild(guildId, 'guild-update', { type: 'kick', targetId: userId });
            
      const targetSocketId = userSocketMap.get(userId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('guild-update', { type: 'kicked' });
        const socket = io.sockets.sockets.get(targetSocketId);
        if (socket) {
          socket.leave(`guild:${guildId}`);
        }
      }
            
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Kick failed.' });
    }
  });

  // POST /api/guilds/:id/promote
  router.post('/:id/promote', requireAuth, (req, res) => {
    try {
      const guildId = parseInt(req.params.id);
      const guild = findGuildById(guildId);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
            
      const myRole = getRole(guild.members, req.user.id);
      if (myRole !== 'leader') {return res.status(403).json({ error: 'Only the leader can promote/demote.' });}
            
      const { userId, role } = req.body;
      if (userId === req.user.id) {return res.status(400).json({ error: 'Cannot change your own role.' });}
      if (role !== 'officer' && role !== 'member') {return res.status(400).json({ error: 'Invalid role.' });}
            
      const targetRole = getRole(guild.members, userId);
      if (!targetRole) {return res.status(404).json({ error: 'User not in guild.' });}
            
      promoteGuildMember(userId, guildId, role);
      emitToGuild(guildId, 'guild-update', { type: 'role-change', targetId: userId, role });
            
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Promotion failed.' });
    }
  });

  // DELETE /api/guilds/:id
  router.delete('/:id', requireAuth, (req, res) => {
    try {
      const guildId = parseInt(req.params.id);
      const guild = findGuildById(guildId);
      if (!guild) {return res.status(404).json({ error: 'Guild not found.' });}
            
      const myRole = getRole(guild.members, req.user.id);
      if (myRole !== 'leader') {return res.status(403).json({ error: 'Only the leader can disband the guild.' });}
            
      emitToGuild(guildId, 'guild-update', { type: 'disbanded' });
            
      const members = getGuildMembers(guildId);
      members.forEach(m => {
        const socketId = userSocketMap.get(m.user_id);
        if (socketId) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.leave(`guild:${guildId}`);
          }
        }
      });
            
      disbandGuild(guildId);
            
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Disband failed.' });
    }
  });

  return router;
}
