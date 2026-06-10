export function createRateLimiter(maxPerSecond) {
  const clients = new Map();
  const checkRate = function(socketId) {
    const now = Date.now();
    let entry = clients.get(socketId);
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + 1000 };
      clients.set(socketId, entry);
    }
    entry.count++;
    if (entry.count > maxPerSecond) {return false;}
    return true;
  };
  checkRate.remove = function(socketId) {
    clients.delete(socketId);
  };
  return checkRate;
}

export const attackLimiter = createRateLimiter(5);
export const buildLimiter = createRateLimiter(3);
export const spawnLimiter = createRateLimiter(10);
export const missileLimiter = createRateLimiter(2);
