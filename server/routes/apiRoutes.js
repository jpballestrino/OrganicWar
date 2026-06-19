import express from 'express';
import { getUserProfile, getMatchHistory, getPlayersPage, getGuildsPage, findUserById } from '../database.js';
import { log } from '../utils/logger.js';
import { activeRooms } from '../game/state.js';
import { io } from '../server.js';
import { sendFeedbackEmail } from '../email.js';
import { verifyToken } from '../auth.js';
import { isProfane } from '../utils/contentFilter.js';

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

const clampLimit = (raw, def, max) =>
  Math.min(Math.max(1, parseInt(raw) || def), max);

apiRouter.get('/api/profile/:username/history', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = clampLimit(req.query.limit, 20, 100);
    const history = getMatchHistory(req.params.username, page, limit);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

apiRouter.get('/api/rankings/players', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const search = (req.query.search || '').trim().slice(0, 50);
    const { rows, total } = getPlayersPage(search, page, 20);
    res.json({ players: rows, total, page, pages: Math.max(1, Math.ceil(total / 20)) });
  } catch (err) {
    log('error', 'Rankings players API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

apiRouter.get('/api/rankings/guilds', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const search = (req.query.search || '').trim().slice(0, 50);
    const { rows, total } = getGuildsPage(search, page, 20);
    res.json({ guilds: rows, total, page, pages: Math.max(1, Math.ceil(total / 20)) });
  } catch (err) {
    log('error', 'Rankings guilds API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Per-user feedback rate limiting: max 5 per 24 h, min 60 s between submissions
const feedbackUserMap = new Map(); // userId → { windowStart, count, lastMs }
const FEEDBACK_MAX_PER_DAY = 5;
const FEEDBACK_MIN_GAP_MS = 60_000;
const FEEDBACK_WINDOW_MS = 86_400_000;

function checkFeedbackRate(userId) {
  const now = Date.now();
  const rec = feedbackUserMap.get(userId) || { windowStart: now, count: 0, lastMs: 0 };
  if (now - rec.windowStart >= FEEDBACK_WINDOW_MS) {
    rec.windowStart = now;
    rec.count = 0;
  }
  if (now - rec.lastMs < FEEDBACK_MIN_GAP_MS) {
    const secLeft = Math.ceil((FEEDBACK_MIN_GAP_MS - (now - rec.lastMs)) / 1000);
    return { allowed: false, error: `Please wait ${secLeft}s before sending another report.` };
  }
  if (rec.count >= FEEDBACK_MAX_PER_DAY) {
    return { allowed: false, error: 'You have reached the daily feedback limit (5 per day). Try again tomorrow.' };
  }
  rec.count++;
  rec.lastMs = now;
  feedbackUserMap.set(userId, rec);
  return { allowed: true };
}

function detectSpam(text) {
  // Repeated character run (5+ in a row: "aaaaa", "!!!!!")
  if (/(.)\1{4,}/.test(text)) return 'Message contains repeated characters.';
  // Excessive caps (>65 % alphabetic chars uppercase, min 15 chars of alpha)
  const alpha = text.replace(/[^a-zA-Z]/g, '');
  if (alpha.length >= 15 && (alpha.replace(/[^A-Z]/g, '').length / alpha.length) > 0.65) {
    return 'Please avoid using excessive capital letters.';
  }
  // Same word repeated more than 5 times
  const words = text.toLowerCase().match(/\b\w+\b/g) || [];
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  if (Object.values(freq).some(c => c > 5)) return 'Message appears to contain repeated words.';
  // Fewer than 4 unique characters in the whole text (e.g. "asdf asdf asdf")
  if (text.length >= 10 && new Set(text.replace(/\s/g, '')).size < 4) {
    return 'Message does not contain enough unique content.';
  }
  return null;
}

apiRouter.post('/api/feedback', async (req, res) => {
  // Require authenticated account
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'You must be logged in to send feedback.' });
  }
  const payload = verifyToken(authHeader.split(' ')[1]);
  if (!payload || !payload.userId) {
    return res.status(401).json({ error: 'Invalid session. Please log in again.' });
  }
  const user = findUserById(payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'Account not found.' });
  }

  // Per-user rate limit
  const rateCheck = checkFeedbackRate(user.id);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: rateCheck.error });
  }

  const { type, subject, description } = req.body;

  if (!['bug', 'suggestion', 'other'].includes(type)) {
    return res.status(400).json({ error: 'Invalid feedback type.' });
  }

  const subjectStr = typeof subject === 'string' ? subject.trim() : '';
  const descStr = typeof description === 'string' ? description.trim() : '';

  if (subjectStr.length < 3 || subjectStr.length > 80) {
    return res.status(400).json({ error: 'Subject must be 3–80 characters.' });
  }
  if (descStr.length < 10 || descStr.length > 2000) {
    return res.status(400).json({ error: 'Description must be 10–2000 characters.' });
  }

  // Language filter
  if (isProfane(subjectStr) || isProfane(descStr)) {
    return res.status(400).json({ error: 'Please keep your feedback respectful and free of inappropriate language.' });
  }

  // Spam detection
  const spamReason = detectSpam(subjectStr) || detectSpam(descStr);
  if (spamReason) {
    return res.status(400).json({ error: spamReason });
  }

  try {
    await sendFeedbackEmail({
      type,
      subject: subjectStr,
      description: descStr,
      userEmail: user.email,
      username: user.username,
    });
    res.json({ ok: true });
  } catch (err) {
    log('error', 'Feedback email error:', err);
    res.status(500).json({ error: 'Failed to send report. Please try again.' });
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
