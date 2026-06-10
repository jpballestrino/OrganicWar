import express from 'express';
import { getUserProfile, getMatchHistory, getTopPlayers, getTopGuilds } from '../database.js';
import { log } from '../utils/logger.js';
import { activeRooms } from '../game/state.js';
import { io } from '../server.js';

const apiRouter = express.Router();

apiRouter.get('/api/profile/:username', (req, res) => {
  try {
    const profile = getUserProfile(req.params.username);
    if (!profile) { return res.status(404).json({ error: 'Profile not found' }); }
    const history = getMatchHistory(req.params.username, 1, 10);
    res.json({ profile, history });
  } catch (err) {
    log('error', 'Profile API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

apiRouter.get('/api/profile/:username/history', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const history = getMatchHistory(req.params.username, page, limit);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

apiRouter.get('/api/rankings/players', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const players = getTopPlayers(limit);
    res.json({ players });
  } catch (err) {
    log('error', 'Rankings players API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

apiRouter.get('/api/rankings/guilds', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const guilds = getTopGuilds(limit);
    res.json({ guilds });
  } catch (err) {
    log('error', 'Rankings guilds API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

apiRouter.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: Object.keys(activeRooms || {}).length,
    uptime: process.uptime(),
  });
});

apiRouter.get('/admin/stats', (req, res) => {
  const apiKey = process.env.ADMIN_API_KEY;
  const providedKey = req.headers['x-admin-key'] || req.query.key;
  if (!apiKey || providedKey !== apiKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
    
  const rooms = Object.values(activeRooms);
  const stats = {
    server: {
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      memoryTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      connectedSockets: io.engine.clientsCount,
      timestamp: new Date().toISOString(),
    },
    rooms: {
      total: rooms.length,
      active: rooms.filter(r => r.matchStarted).length,
      waiting: rooms.filter(r => !r.matchStarted).length,
      quickPlay: rooms.filter(r => r.isQuickPlay).length,
      custom: rooms.filter(r => !r.isQuickPlay).length,
    },
    players: {
      totalHumans: rooms.reduce((sum, r) => 
        sum + Object.values(r.activePlayerSlots).filter(s => s !== null).length, 0),
      totalBots: rooms.reduce((sum, r) => 
        sum + Object.values(r.activePlayerSlots).filter(s => s === null).length, 0),
    },
    roomDetails: rooms.map(r => ({
      id: r.id,
      name: r.name,
      players: Object.values(r.activePlayerSlots).filter(s => s !== null).length,
      maxPlayers: r.maxPlayers,
      matchStarted: r.matchStarted,
      isQuickPlay: r.isQuickPlay,
      createdAt: r.createdAt,
      activeAttacks: (r.sim && r.sim.activeAttacks) ? r.sim.activeAttacks.length : 0,
    })),
  };
    
  res.json(stats);
});
export default apiRouter;
