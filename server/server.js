// HTTP + WebSockets Game Server Layer (Server-Side)
import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server } from 'socket.io';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { verifyToken } from './auth.js';
import { findUserById, getUserProfile, prepareStatements , db } from './database.js';
import { runMigrations } from './migrate.js';
import guildRoutes from './routes/guilds.js';
import authRouter from './routes/authRoutes.js';
import apiRouter from './routes/apiRoutes.js';

import { log } from './utils/logger.js';
import { activeRooms } from './game/state.js';
import { setupSocketHandlers } from './game/socketHandlers.js';
import { guildWarMatchmakerInterval, rankedMatchmakerInterval, playerCountInterval } from './game/gameLoop.js';

runMigrations();
prepareStatements();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
}));
app.use(compression());
app.use(cookieParser());
app.use(express.json());

let httpServer;
if (process.env.SSL_CERT && process.env.SSL_KEY) {
  const sslOptions = {
    cert: fs.readFileSync(process.env.SSL_CERT),
    key: fs.readFileSync(process.env.SSL_KEY),
  };
  httpServer = createHttpsServer(sslOptions, app);
  console.log('[INFO] HTTPS server enabled');
} else {
  httpServer = createServer(app);
  console.log('[INFO] HTTP server (no SSL)');
}

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

export const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  perMessageDeflate: true,
});

// Connection-rate limiter (counts connections in a ~60s rolling window, halved each minute).
// Used in socketHandlers.js to block connection-flood attacks.
export const ipConnectionCounts = new Map();
setInterval(() => {
  for (const [ip, count] of ipConnectionCounts.entries()) {
    if (count <= 1) ipConnectionCounts.delete(ip);
    else ipConnectionCounts.set(ip, Math.floor(count / 2));
  }
}, 60000);

// Concurrent connection limit per IP — prevents one user from filling all faction slots.
const ipConcurrentCounts = new Map();
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP) || 5;

io.use((socket, next) => {
  const ip = socket.handshake.address;
  // Exempt localhost (dev / internal health checks)
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return next();
  }
  const current = (ipConcurrentCounts.get(ip) || 0) + 1;
  if (current > MAX_CONNECTIONS_PER_IP) {
    log('warn', `[RateLimit] ${ip} exceeded concurrent connection limit (${current}/${MAX_CONNECTIONS_PER_IP})`);
    return next(new Error('connection-limit'));
  }
  ipConcurrentCounts.set(ip, current);
  socket.on('disconnect', () => {
    const n = (ipConcurrentCounts.get(ip) || 1) - 1;
    if (n <= 0) ipConcurrentCounts.delete(ip);
    else ipConcurrentCounts.set(ip, n);
  });
  next();
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    const payload = verifyToken(token);
    if (payload && payload.userId) {
      const user = findUserById(payload.userId);
      if (user) {
        socket.userId = user.id;
        socket.username = user.username;
        socket.displayName = user.display_name;
        const profile = getUserProfile(user.username);
        if (profile && profile.guild_tag) {
          socket.guildTag = profile.guild_tag;
        }
        return next();
      }
    }
  }
  socket.userId = null;
  socket.isGuest = true;
  next();
});

app.use('/api/auth', authRouter);
app.use('/', apiRouter);

// Serve the password-reset standalone page
app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'src', 'reset-password.html'));
});

// Attach guild routes
app.use('/api/guilds', guildRoutes(io));

// Serve client static assets when deployed
const clientDistPath = path.join(__dirname, '../dist');
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
} else if (process.env.NODE_ENV === 'production') {
  log('error', '[FATAL] dist/ directory not found in production — clients will see nothing. Run `npm run build` before starting the server.');
  // Don't exit: the server is still useful (API + websockets work), but log loudly.
} else {
  log('warn', 'dist/ not found — serving via Vite dev server on :5173 instead (expected in development).');
}

// Health check — live room count + per-worker RSS for capacity planning (Item 17)
app.get('/healthz', (_req, res) => {
  const MAX_ROOMS = parseInt(process.env.MAX_CONCURRENT_ROOMS) || 10;
  const rooms = Object.values(activeRooms);
  const roomDetails = rooms.map(r => ({
    id: r.id,
    humans: Object.values(r.activePlayerSlots).filter(s => s && !s.isBot).length,
    rssMB: r.simReal?._workerRssMB ?? null,
  }));
  const totalWorkerRssMB = roomDetails.reduce((s, r) => s + (r.rssMB || 0), 0);
  res.json({
    status: 'ok',
    nodeEnv: process.env.NODE_ENV || 'development',
    distReady: fs.existsSync(clientDistPath),
    rooms: rooms.length,
    maxRooms: MAX_ROOMS,
    totalWorkerRssMB,
    uptime: Math.floor(process.uptime()),
    roomDetails,
  });
});

// Setup Socket handlers
setupSocketHandlers(io);

// ── Automated SQLite Backups ──────────────────────────────────────────────────
// db.backup() uses SQLite's online backup API — safe even under concurrent writes.
// Skipped in test mode (:memory: DB has nothing to back up).
if (process.env.NODE_ENV !== 'test') {
  const BACKUP_DIR = path.join(__dirname, '..', 'backups');
  const HOURLY_KEEP = 48;

  function runDbBackup() {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const ts = new Date().toISOString().slice(0, 16).replace(/:/g, '-'); // YYYY-MM-DDTHH-mm
      const dest = path.join(BACKUP_DIR, `organicwar-${ts}.db`);
      db.backup(dest).then(() => {
        // Prune: keep only the most recent HOURLY_KEEP backups
        const files = fs.readdirSync(BACKUP_DIR)
          .filter(f => f.startsWith('organicwar-') && f.endsWith('.db'))
          .sort()
          .reverse();
        for (const f of files.slice(HOURLY_KEEP)) {
          fs.unlinkSync(path.join(BACKUP_DIR, f));
        }
        log('info', `[Backup] DB snapshot saved: ${path.basename(dest)} (${files.length} total)`);
      }).catch(err => {
        log('error', '[Backup] DB backup failed:', err.message);
      });
    } catch (err) {
      log('error', '[Backup] DB backup setup failed:', err.message);
    }
  }

  // First backup 5 minutes after startup, then every hour
  setTimeout(runDbBackup, 5 * 60 * 1000);
  setInterval(runDbBackup, 60 * 60 * 1000);
}

httpServer.listen(PORT, () => {
  log('info', `Server listening on port ${PORT}`);
});

function gracefulShutdown(signal) {
  log('info', `Received ${signal}. Starting graceful shutdown...`);
    
  io.emit('notification', { 
    message: 'Server is restarting. You will be reconnected shortly.', 
    type: 'warning', 
  });
    
  httpServer.close(() => {
    log('info', 'HTTP server closed');
  });
    
  clearInterval(guildWarMatchmakerInterval);
  clearInterval(rankedMatchmakerInterval);
  clearInterval(playerCountInterval);
    
  try {
    db.close();
    log('info', 'Database closed');
  } catch (err) {
    log('error', 'Error closing database:', err);
  }
    
  setTimeout(() => {
    log('info', 'Shutdown complete.');
    process.exit(0);
  }, 1000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
