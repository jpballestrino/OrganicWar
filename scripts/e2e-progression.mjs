// End-to-end check of server-side XP for logged-in players, against a running
// server started with the dev sandbox enabled:
//
//   DEV_SANDBOX=1 npm start              # in one terminal
//   node scripts/e2e-progression.mjs     # in another (URL=http://localhost:3000)
//
// 1. Registers a fresh account, connects, and expects an empty profile.
// 2. Plays a real Quick Battle idle until its match ends (eliminated by bots,
//    or still standing at game over) and expects the server's
//    `progression-result`, scored from the worker's own numbers.
// 3. Reconnects and expects the stored profile (1 game, same XP).
// 4. A second account imports a guest profile, wins via the dev end-of-match
//    switch (game-over path) and expects the Victory XP on top of the import.
// Exits non-zero on any failure. Takes a few minutes (step 2 waits for bots).

import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

async function register(tag) {
  const name = `e2e${tag}${Date.now().toString(36)}`.slice(0, 20);
  const res = await fetch(`${URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: 'e2e-password-123' }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error(`register failed: ${res.status} ${JSON.stringify(data)}`);
  return data.token;
}

function connect(token) {
  return io(URL, { auth: { token, tzOffset: new Date().getTimezoneOffset() }, transports: ['websocket'], forceNew: true });
}

const once = (socket, event, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
  socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
});

// --- 1-3: real match, eliminated by bots ---
const tokenA = await register('a');
let a = connect(tokenA);
const first = await once(a, 'progression-profile', 10000);
check('a new account starts with an empty profile', first.profile.xp === 0 && first.profile.games === 0 && first.canImport === true,
  JSON.stringify({ xp: first.profile.xp, games: first.profile.games, canImport: first.canImport }));
check('today\'s daily missions are rolled on the server', Array.isArray(first.profile.missions) && first.profile.missions.length === 3);

let myFid = 0;
a.on('join-success', ({ factionId }) => { myFid = factionId; });
const resultA = new Promise((resolve) => a.once('progression-result', resolve));
// The idle player's match ends either when the bots eliminate it, or at game
// over if it is still standing when someone reaches the domination share.
const endA = new Promise((resolve) => {
  a.on('player-eliminated', (p) => { if (p.factionId === myFid) resolve({ how: 'eliminated', placement: p.placement }); });
  a.on('game-over', (g) => resolve({ how: 'game over', placement: g.winner === myFid ? 1 : g.stats?.[myFid]?.placement }));
});
a.emit('quick-play', { nickname: 'E2E-A' });
await once(a, 'start-match-now', 60000);
console.log('      match started; waiting for the idle player\'s match to end (up to 7 min)…');
const end = await Promise.race([endA, new Promise((_, rej) => setTimeout(() => rej(new Error('match did not end in time')), 420000))]);
const res = await Promise.race([resultA, new Promise((r) => setTimeout(() => r(null), 5000))]);
check(`the server sends the XP result (${end.how})`, !!res, res ? `+${res.totalXp} XP, placed #${end.placement}` : 'no progression-result');
if (res) {
  check('the result is scored from the server\'s numbers', res.lines.some(l => l.label === `Placed #${end.placement} of 20`),
    res.lines.map(l => `${l.label}: ${l.xp}`).join(', '));
  check('the result carries the saved profile', res.profile.games === 1 && res.profile.xp === res.totalXp);
}
a.disconnect();

a = connect(tokenA);
const again = await once(a, 'progression-profile', 10000);
check('the profile is stored and comes back on a new connection',
  res && again.profile.games === 1 && again.profile.xp === res.totalXp && again.canImport === false,
  JSON.stringify({ xp: again.profile.xp, games: again.profile.games }));
a.disconnect();

// --- 4: guest import + win via the dev end-of-match switch ---
const tokenB = await register('b');
const b = connect(tokenB);
const fresh = await once(b, 'progression-profile', 10000);
check('second account can import', fresh.canImport === true);
b.emit('progression-import', { xp: 700, games: 3, wins: 0, eliminations: 2, bestPlacement: 4 });
const imported = await once(b, 'progression-profile', 10000);
check('the guest profile is imported', imported.profile.xp === 700 && imported.profile.games === 3 && imported.canImport === false,
  JSON.stringify({ xp: imported.profile.xp, games: imported.profile.games }));
b.emit('progression-import', { xp: 99999, games: 100, wins: 50, eliminations: 0 });
await new Promise(r => setTimeout(r, 500));

const resultB = new Promise((resolve) => b.once('progression-result', resolve));
b.emit('quick-play', { nickname: 'E2E-B' });
await once(b, 'start-match-now', 60000);
b.emit('dev-simulate-game-over', { result: 'win' });
const win = await Promise.race([resultB, new Promise((r) => setTimeout(() => r(null), 10000))]);
check('a win pays Victory XP (game-over path)', win && win.lines.some(l => l.label === 'Victory' && l.xp === 150),
  win ? win.lines.map(l => `${l.label}: ${l.xp}`).join(', ') : 'no result (is DEV_SANDBOX=1 set?)');
check('it adds to the imported profile, not to a second import', win && win.profile.games === 4 && win.profile.xp === 700 + win.totalXp,
  win ? JSON.stringify({ xp: win.profile.xp, games: win.profile.games }) : '');
b.disconnect();

if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
process.exit(0);
