export const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // 'debug', 'info', 'warn', 'error'
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export function log(level, message, data = null) {
  if (LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL]) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    if (data) {console[level === 'error' ? 'error' : 'log'](entry, data);}
    else {console[level === 'error' ? 'error' : 'log'](entry);}
  }
}
