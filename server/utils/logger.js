import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// In production, write structured JSON to a daily rotating log file.
// In development, only console output (fast, readable).
const IS_PROD = process.env.NODE_ENV === 'production';

let _logStream = null;
let _logStreamDate = null;

function getLogStream() {
  if (!IS_PROD) return null;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (_logStreamDate === today && _logStream) return _logStream;

  // Close previous stream if date rolled over
  if (_logStream) {
    try { _logStream.end(); } catch {}
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    _logStream = fs.createWriteStream(path.join(LOG_DIR, `server-${today}.log`), { flags: 'a' });
    _logStreamDate = today;
  } catch {
    _logStream = null;
  }
  return _logStream;
}

export function log(level, message, data = null) {
  if ((LOG_LEVELS[level] ?? 1) < (LOG_LEVELS[LOG_LEVEL] ?? 1)) return;

  const timestamp = new Date().toISOString();

  // File output: structured JSON (production only)
  const stream = getLogStream();
  if (stream) {
    const entry = { ts: timestamp, level, msg: message };
    if (data != null) entry.data = data instanceof Error ? data.message : data;
    try { stream.write(JSON.stringify(entry) + '\n'); } catch {}
  }

  // Console output: human-readable (always)
  const prefix = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (data != null) {
    (level === 'error' ? console.error : console.log)(prefix, data);
  } else {
    (level === 'error' ? console.error : console.log)(prefix);
  }
}
