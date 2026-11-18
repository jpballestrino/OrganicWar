// Small in-memory rate limiter for the auth endpoints (one server instance, so
// process memory is the right place). Without it anyone could try passwords
// as fast as the server answers, or make the server send thousands of
// password-reset / verification emails (spamming people and getting the
// sending account blocked).
//
//   router.post('/login', rateLimit({ name: 'login', max: 30, windowMs: 15 * 60e3 }), handler)
//
// Each limit counts requests per key (the client IP by default; `key` can add
// e.g. the email address) in a fixed window. Over the limit → 429 with a
// Retry-After header and `{ error }`, which the client shows as is.
// AUTH_RATE_LIMITS=off disables every limit (for load tests on one machine).

const buckets = new Map(); // `${name}|${key}` → { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60000).unref();

function minutes(ms) {
  const m = Math.ceil(ms / 60000);
  return m <= 1 ? 'a minute' : `${m} minutes`;
}

export function rateLimit({ name, max, windowMs, key = () => '', message = 'Too many attempts.' }) {
  return (req, res, next) => {
    if (process.env.AUTH_RATE_LIMITS === 'off') return next();
    const now = Date.now();
    const keys = [`${name}|ip:${req.ip}`];
    const extra = key(req);
    if (extra) keys.push(`${name}|${extra}`);
    for (const k of keys) {
      let b = buckets.get(k);
      if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(k, b); }
      b.count++;
      if (b.count > max) {
        const wait = b.resetAt - now;
        res.set('Retry-After', String(Math.ceil(wait / 1000)));
        return res.status(429).json({ error: `${message} Please try again in ${minutes(wait)}.` });
      }
    }
    next();
  };
}

export function resetRateLimits() { buckets.clear(); }
