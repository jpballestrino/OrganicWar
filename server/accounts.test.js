// Accounts and guilds pieces that are hard to reach from scripts/e2e-accounts.mjs:
// the auth rate limiter, disbanding a guild with Guild War history, reset-link
// invalidation. Runs against the in-memory test database.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from './migrate.js';
import {
  prepareStatements, createUser, createGuild, findGuildById, findUserById, recordMatch,
  disbandGuild, createPasswordResetToken, findValidResetToken, invalidateResetTokens, db,
} from './database.js';
import { rateLimit, resetRateLimits } from './rateLimit.js';

beforeAll(() => {
  runMigrations();
  prepareStatements();
});

describe('disbanding a guild', () => {
  it('works after the guild has played a Guild War (match records keep the players)', () => {
    const leader = createUser('war_leader', 'war@test.local', 'hash', 'War Leader');
    const guild = createGuild('War Party', 'WARP', '', leader.id, '#ffc107', 0);
    recordMatch('ROOM1', leader.id, 1, 'win', { cells: 10, isGuildMatch: true, guildId: guild.id });

    expect(() => disbandGuild(guild.id)).not.toThrow();
    expect(findGuildById(guild.id)).toBeUndefined();
    expect(findUserById(leader.id).guild_id).toBeNull();
    const rows = db.prepare('SELECT user_id, guild_id FROM match_history WHERE room_id = ?').all('ROOM1');
    expect(rows).toEqual([{ user_id: leader.id, guild_id: null }]);
  });
});

describe('password reset links', () => {
  it('a reset makes every other outstanding link for the account invalid', () => {
    const u = createUser('reset_user', 'reset@test.local', 'hash', 'Reset');
    const later = new Date(Date.now() + 1800000).toISOString().replace('T', ' ').replace('Z', '');
    createPasswordResetToken(u.id, 'tok-a', later);
    createPasswordResetToken(u.id, 'tok-b', later);
    expect(findValidResetToken('tok-a')).toBeTruthy();
    invalidateResetTokens(u.id);
    expect(findValidResetToken('tok-a')).toBeUndefined();
    expect(findValidResetToken('tok-b')).toBeUndefined();
  });

  it('an expired link is refused', () => {
    const u = createUser('reset_old', 'old@test.local', 'hash', 'Old');
    const past = new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace('Z', '');
    createPasswordResetToken(u.id, 'tok-old', past);
    expect(findValidResetToken('tok-old')).toBeUndefined();
  });
});

describe('auth rate limiter', () => {
  beforeEach(() => resetRateLimits());

  function run(mw, req) {
    let status = 200; let body = null; const headers = {};
    let passed = false;
    const res = {
      set: (k, v) => { headers[k] = v; },
      status: (s) => { status = s; return res; },
      json: (b) => { body = b; return res; },
    };
    mw(req, res, () => { passed = true; });
    return { passed, status, body, headers };
  }

  it('lets `max` requests through per IP, then answers 429 with Retry-After', () => {
    const mw = rateLimit({ name: 't1', max: 3, windowMs: 60000, message: 'Too many.' });
    const req = { ip: '1.2.3.4', body: {} };
    for (let i = 0; i < 3; i++) expect(run(mw, req).passed).toBe(true);
    const r = run(mw, req);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(429);
    expect(Number(r.headers['Retry-After'])).toBeGreaterThan(0);
    expect(r.body.error).toMatch(/^Too many\. Please try again in a minute\.$/);
    expect(run(mw, { ip: '5.6.7.8', body: {} }).passed).toBe(true); // other IPs unaffected
  });

  it('can also limit per key (e.g. per email address) across IPs', () => {
    const mw = rateLimit({ name: 't2', max: 2, windowMs: 60000, key: (req) => `email:${req.body.email}` });
    expect(run(mw, { ip: 'a', body: { email: 'x@y.z' } }).passed).toBe(true);
    expect(run(mw, { ip: 'b', body: { email: 'x@y.z' } }).passed).toBe(true);
    expect(run(mw, { ip: 'c', body: { email: 'x@y.z' } }).status).toBe(429);
    expect(run(mw, { ip: 'c', body: { email: 'other@y.z' } }).passed).toBe(true);
  });

  it('AUTH_RATE_LIMITS=off disables it', () => {
    const mw = rateLimit({ name: 't3', max: 1, windowMs: 60000 });
    process.env.AUTH_RATE_LIMITS = 'off';
    try {
      for (let i = 0; i < 5; i++) expect(run(mw, { ip: 'z', body: {} }).passed).toBe(true);
    } finally { delete process.env.AUTH_RATE_LIMITS; }
  });
});
