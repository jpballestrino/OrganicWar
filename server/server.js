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
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
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
  perMessageDeflate: false,
});

export const ipConnectionCounts = new Map();
// Decrement per-IP counts every 60s
setInterval(() => {
  for (const [ip, count] of ipConnectionCounts.entries()) {
    if (count <= 1) {
      ipConnectionCounts.delete(ip);
    } else {
      ipConnectionCounts.set(ip, Math.floor(count / 2));
    }
  }
}, 60000);

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
}

// Setup Socket handlers
setupSocketHandlers(io);

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
