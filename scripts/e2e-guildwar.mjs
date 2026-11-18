// End-to-end check of guild wars over HTTP + Socket.IO. Server with a
// throw-away database, no email, DEV_SANDBOX (to end a war on demand) and a
// short muster time:
//
//   DB_PATH=/tmp/ow-gw.db DEV_SANDBOX=1 GUILD_WAR_MUSTER_SECONDS=12 npm start
//   DB_PATH=/tmp/ow-gw.db node scripts/e2e-guildwar.mjs

import { io as ioClient } from 'socket.io-client';
import Database from 'better-sqlite3';

const BASE = process.env.URL || 'http://localhost:3000';
const DB_PATH = process.env.DB_PATH;
if (!DB_PATH) { console.error('Set DB_PATH to the server\'s database.'); process.exit(2); }
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new Database(DB_PATH);
const userElo = (id) => db.prepare('SELECT elo_rating FROM users WHERE id = ?').get(id).elo_rating;
const guildRow = (id) => db.prepare('SELECT elo_rating, total_guild_wins AS w, total_guild_losses AS l FROM guilds WHERE id = ?').get(id);

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
async function account(name) {
  const username = `${name}_${RUN}`.toLowerCase();
  const d = await api('/api/auth/register', { method: 'POST', body: { username, email: `${username}@example.test`, password: 'secret123' } });
  if (!d.token) throw new Error(`register: ${JSON.stringify(d)} (run the server without SMTP settings)`);
  return { username, id: d.user.id, token: d.token };
}
function connect(u) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { auth: { token: u.token }, transports: ['websocket'], forceNew: true });
    s.events = [];
    s.onAny((ev, data) => { if (!/^sim-/.test(ev)) s.events.push({ ev, data }); });
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

// Two guilds of two.
const [a1, a2, b1, b2] = await Promise.all(['a1', 'a2', 'b1', 'b2'].map(account));
const gA = (await api('/api/guilds', { method: 'POST', token: a1.token, body: { name: `Alpha ${RUN}`, tag: `A${RUN.slice(0, 3)}`, isOpen: true } })).guild;
const gB = (await api('/api/guilds', { method: 'POST', token: b1.token, body: { name: `Bravo ${RUN}`, tag: `B${RUN.slice(0, 3)}`, isOpen: true } })).guild;
await api(`/api/guilds/${gA.id}/join`, { method: 'POST', token: a2.token });
await api(`/api/guilds/${gB.id}/join`, { method: 'POST', token: b2.token });
db.prepare('UPDATE guilds SET elo_rating = ? WHERE id = ?').run(1000, gA.id);
db.prepare('UPDATE guilds SET elo_rating = ? WHERE id = ?').run(1100, gB.id);
const userElos = [a1, a2, b1, b2].map((u) => userElo(u.id));
const socks = await Promise.all([a1, a2, b1, b2].map(connect));
const [sA1, sA2, sB1, sB2] = socks;
const outsider = await connect(await account('zed'));

// ── a 2v2 war by challenge ──
sA1.emit('guild-war-challenge', { tag: gB.tag, teamSize: 2 });
const ch = await waitEvent(sB1, 'guild-war-challenge-received');
check('the challenged guild receives the challenge', ch && ch.challengerGuild.id === gA.id);
sB1.emit('guild-war-accept', { challengerGuildId: gA.id });
const matched = await waitEvent(sA2, 'guild-war-matched');
check('every member of both guilds is told the war is on', matched && !!(await waitEvent(sB2, 'guild-war-matched')), JSON.stringify(matched));
const roomId = matched.roomId;

outsider.emit('request-rooms');
const lobby = await waitEvent(outsider, 'rooms-list-update');
check('the war room is not in the public lobby', Array.isArray(lobby) && !lobby.some((r) => r.id === roomId));
outsider.emit('join-room', { roomId });
check('outsiders cannot join the war room', !!(await waitEvent(outsider, 'notification', (d) => /not found|closed/i.test(d.message))));

for (const s of socks) s.emit('join-room', { roomId });
const fids = {};
for (const [name, s] of [['a1', sA1], ['a2', sA2], ['b1', sB1], ['b2', sB2]]) {
  const js = await waitEvent(s, 'join-success');
  fids[name] = js && js.factionId;
}
check('members land on their own side automatically', fids.a1 <= 2 && fids.a2 <= 2 && fids.b1 > 2 && fids.b2 > 2 && new Set(Object.values(fids)).size === 4, JSON.stringify(fids));
const cfg = await waitEvent(sA1, 'init-config');
check('the client is told it is a guild war, with both tags', cfg && cfg.isGuildWar && cfg.guildA.tag === gA.tag && cfg.guildB.tag === gB.tag && cfg.teamSize === 2);

const started = await waitEvent(sA1, 'start-match-now', () => true, 40000);
check('a full roster starts the war without waiting for the deadline', !!started);
const fin = await waitEvent(sA1, 'spawns-finalized');
const botSlots = Object.values(fin.slots).filter((x) => x && x.isBot).length;
check('no bots in a guild war', botSlots === 0, `${botSlots} bot slots`);
await sleep(2500);

// No friendly fire: a1 aims at a2's home cell.
const c = fin.centroids[fids.a2];
sA1.emit('sim-input', { type: 'expand', payload: { targetCell: c.r * 1920 + c.c, attackPercentage: 50 } });
check('attacking your own ally is refused', !!(await waitEvent(sA1, 'notification', (d) => /ally/i.test(d.message), 3000)));
sA1.emit('sim-input', { type: 'fire_missile', payload: { targetCell: c.r * 1920 + c.c } });
check('firing a missile at your ally is refused', (await new Promise((r) => setTimeout(() => r(sA1.events.filter((e) => e.ev === 'notification' && /ally/i.test(e.data.message)).length), 1500))) >= 2);

// Guild A wins.
sA1.emit('dev-simulate-game-over', { result: 'win' });
const res = await waitEvent(sB2, 'guild-war-result', () => true, 10000);
check('both sides get the guild rating result', !!res && !!(await waitEvent(sA2, 'guild-war-result')), JSON.stringify(res));
const ga = guildRow(gA.id);
const gb = guildRow(gB.id);
check('the winning guild gains rating, the loser loses the same amount', ga.elo_rating > 1000 && gb.elo_rating < 1100 && ga.elo_rating - 1000 === 1100 - gb.elo_rating,
  `A ${1000}→${ga.elo_rating}, B ${1100}→${gb.elo_rating}`);
check('an upset (lower-rated guild wins) is worth more than 16', ga.elo_rating - 1000 > 16, `+${ga.elo_rating - 1000}`);
check('guild win/loss records are updated', ga.w === 1 && gb.l === 1);
check('individual players\' ratings do not change', [a1, a2, b1, b2].every((u, i) => userElo(u.id) === userElos[i]),
  [a1, a2, b1, b2].map((u, i) => `${userElos[i]}→${userElo(u.id)}`).join(' '));
const hist = await Promise.all([a2, b2].map((u) => api(`/api/profile/${u.username}`)));
check('teammates of the winner are recorded as winners, the others as losers', hist[0].history?.[0]?.result === 'win' && hist[1].history?.[0]?.result === 'loss',
  `${hist[0].history?.[0]?.result} / ${hist[1].history?.[0]?.result}`);

// ── a war where only one member per guild shows up: starts at the deadline ──
for (const s of socks) s.events = [];
await new Promise((r) => setTimeout(r, 1000));
sA1.emit('guild-war-challenge', { tag: gB.tag, teamSize: 2 });
await waitEvent(sB1, 'guild-war-challenge-received');
sB1.emit('guild-war-accept', { challengerGuildId: gA.id });
const m2 = await waitEvent(sA1, 'guild-war-matched');
sA1.emit('join-room', { roomId: m2.roomId });
sB1.emit('join-room', { roomId: m2.roomId });
const started2 = await waitEvent(sA1, 'start-match-now', () => true, 60000);
check('with a member missing on each side, the war starts at the deadline', !!started2);
const fin2 = await waitEvent(sA1, 'spawns-finalized');
const filled = Object.values(fin2.slots).filter(Boolean);
check('…with just the players who came (empty slots stay empty)', filled.length === 2 && filled.every((x) => !x.isBot), `${filled.length} slots`);

// ── nobody from one guild shows up: called off ──
for (const s of socks) s.events = [];
sA1.disconnect(); sA1.connect(); await sleep(800);
sA1.events = [];
sA1.emit('guild-war-challenge', { tag: gB.tag, teamSize: 2 });
await waitEvent(sB1, 'guild-war-challenge-received', () => true, 5000);
sB1.emit('guild-war-accept', { challengerGuildId: gA.id });
const m3 = await waitEvent(sA2, 'guild-war-matched', () => true, 5000);
sA2.emit('join-room', { roomId: m3 && m3.roomId });
const off = await waitEvent(sB2, 'notification', (d) => /called off/i.test(d.message), 60000);
check('a war one guild never joins is called off (no rating change)', !!off && guildRow(gA.id).elo_rating === ga.elo_rating, off && off.message);

[...socks, outsider].forEach((s) => s.close());
db.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
