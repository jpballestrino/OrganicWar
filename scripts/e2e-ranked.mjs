// End-to-end check of ranked matches over HTTP + Socket.IO, against a running
// server started with a throw-away database, no email, and DEV_SANDBOX (to end
// a match on demand):
//
//   DB_PATH=/tmp/ow-ranked.db DEV_SANDBOX=1 npm start
//   DB_PATH=/tmp/ow-ranked.db node scripts/e2e-ranked.mjs
//
// The script sets the test accounts' ratings directly in that database (the
// only way to get players of known, different ratings).

import { io as ioClient } from 'socket.io-client';
import Database from 'better-sqlite3';

const BASE = process.env.URL || 'http://localhost:3000';
const DB_PATH = process.env.DB_PATH;
if (!DB_PATH) { console.error('Set DB_PATH to the server\'s database.'); process.exit(2); }
const RUN = Date.now().toString(36).slice(-5);
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new Database(DB_PATH);
const ratingOf = (id) => db.prepare('SELECT elo_rating FROM users WHERE id = ?').get(id).elo_rating;

async function account(name, elo) {
  const username = `${name}_${RUN}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@example.test`, password: 'secret123' }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`register ${username}: ${JSON.stringify(data)} (run the server without SMTP settings)`);
  db.prepare('UPDATE users SET elo_rating = ? WHERE id = ?').run(elo, data.user.id);
  return { username, id: data.user.id, token: data.token, elo };
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { auth: token ? { token } : {}, transports: ['websocket'], forceNew: true });
    s.events = [];
    s.onAny((ev, data) => { if (!/^sim-/.test(ev)) s.events.push({ ev, data, t: Date.now() }); });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
async function waitEvent(s, ev, pred = () => true, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const hit = s.events.find((e) => e.ev === ev && pred(e.data));
    if (hit || Date.now() > end) return hit ? hit.data : null;
    await sleep(100);
  }
}

// ── who may queue ──
const guest = await connect(null);
guest.emit('join-ranked-queue');
check('guests are refused (and told to leave the queue screen)', !!(await waitEvent(guest, 'ranked-queue-left')));

const alice = await account('alice', 1000);
const bob = await account('bob', 1030);
const carol = await account('carol', 1700);
const [sa, sb, sc] = await Promise.all([alice, bob, carol].map((u) => connect(u.token)));

// ── matching by rating ──
const t0 = Date.now();
sa.emit('join-ranked-queue');
sc.emit('join-ranked-queue');
await sleep(1500);
sb.emit('join-ranked-queue');
const upd = await waitEvent(sc, 'ranked-queue-update', (d) => d.count === 3);
check('queue updates show the count and the rating range', upd && upd.range > 0, JSON.stringify(upd));
const foundA = await waitEvent(sa, 'ranked-match-found', () => true, 30000);
const waited = Math.round((Date.now() - t0) / 1000);
check('the two close-rated players are matched (after the gathering wait)', !!foundA && !!(await waitEvent(sb, 'ranked-match-found')), `${waited} s`);
check('the far-rated player is not matched with them yet', !(await waitEvent(sc, 'ranked-match-found', () => true, 500)));
sc.emit('leave-ranked-queue');

// ── the ranked room is private ──
guest.emit('join-room', { roomId: foundA.roomId });
const closed = await waitEvent(guest, 'notification', (d) => /not found|closed/i.test(d.message));
check('the ranked room cannot be joined from the lobby', !!closed);
const cfg = await waitEvent(sa, 'init-config');
check('the client is told it is a ranked match', cfg && cfg.isRankedMatch === true);
check('the match is a full battle (bots fill the other factions)', cfg && cfg.maxPlayers === 20, `maxPlayers ${cfg && cfg.maxPlayers}`);
sa.emit('quick-play', {});
await sleep(300);
check('a player already matched cannot start another match', !(await waitEvent(sa, 'join-success', (d) => !d.isRankedMatch, 300)));

// ── play: alice quits mid-match, bob wins ──
const started = await waitEvent(sa, 'start-match-now', () => true, 40000);
check('the match starts', !!started);
await sleep(3000);
await new Promise((r) => sa.timeout(2000).emit('quit-game', () => r()));
await sleep(500);
sb.emit('dev-simulate-game-over', { result: 'win' });
const rb = await waitEvent(sb, 'ranked-result', () => true, 10000);
check('the winner is told their rating change', rb && rb.eloDelta > 0 && rb.place === 1 && rb.humans === 2, JSON.stringify(rb));
const aAfter = ratingOf(alice.id);
const bAfter = ratingOf(bob.id);
check('ratings move by Elo: winner up, quitter down by the same amount', bAfter > bob.elo && aAfter < alice.elo && (bAfter - bob.elo) === (alice.elo - aAfter),
  `alice ${alice.elo}→${aAfter}, bob ${bob.elo}→${bAfter}`);
check('the far-rated player who left the queue is untouched', ratingOf(carol.id) === carol.elo);
const hist = await (await fetch(`${BASE}/api/profile/${alice.username}`)).json();
check('the quitter\'s match is recorded as abandoned', hist.history?.[0]?.result === 'abandoned', JSON.stringify(hist.history?.[0]));
const histB = await (await fetch(`${BASE}/api/profile/${bob.username}`)).json();
check('the winner\'s match is recorded as a win', histB.history?.[0]?.result === 'win', JSON.stringify(histB.history?.[0]));

// ── a custom (unranked) game between the same two leaves ratings alone ──
const before = [ratingOf(alice.id), ratingOf(bob.id)];
sa.events = []; sb.events = [];
sa.emit('create-custom-room', { name: `Friendly ${RUN}`, maxPlayers: 2, preset: 'europe' });
const own = await waitEvent(sa, 'join-success');
const roomCfg = await waitEvent(sa, 'init-config');
check('a custom room is created after the ranked match', !!own && !!roomCfg);
const roomsList = await new Promise((r) => { guest.once('rooms-list-update', r); guest.emit('request-rooms'); setTimeout(() => r(null), 2000); });
const custom = (roomsList || []).find((x) => x.name === `Friendly ${RUN}`);
sb.emit('join-room', { roomId: custom && custom.id });
await waitEvent(sb, 'init-config');
sb.emit('join-faction', { factionId: own.factionId === 1 ? 2 : 1 });
await waitEvent(sb, 'join-success');
sa.emit('start-custom-game');
const customStarted = await waitEvent(sb, 'start-match-now', () => true, 40000);
check('the custom match starts', !!customStarted);
sa.emit('dev-simulate-game-over', { result: 'win' });
await waitEvent(sb, 'game-over', () => true, 10000);
await sleep(500);
check('custom games do not change ratings', ratingOf(alice.id) === before[0] && ratingOf(bob.id) === before[1],
  `alice ${before[0]}→${ratingOf(alice.id)}, bob ${before[1]}→${ratingOf(bob.id)}`);
check('no rating message after an unranked game', !(await waitEvent(sa, 'ranked-result', () => true, 300)));

[guest, sa, sb, sc].forEach((s) => s.close());
db.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
