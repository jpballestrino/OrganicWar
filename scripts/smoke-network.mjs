// Bad-connection check: two players in one Quick Battle, player A behind a
// TCP proxy this script controls, player B connected directly (it watches
// what the others see). Scenarios:
//   1. lag     — A's connection freezes for 8 s without closing (packets held)
//   2. drop    — A's connection is cut and refused for 6 s, then comes back
//   3. long    — A is cut for longer than the server's grace period: a bot
//                takes over A's faction; when A returns it gets it back
//   4. ended   — the match ends while A is cut off: on return A is told so
//   5. spawn   — a new match; A drops during spawn selection and gets back
//                into the spawn picker, then into the match
//   6. quit    — A quits from the menu: B sees a bot take over at once
// After each recovery A's map must match the server (own land vs HUD), and
// B must have been told A was reconnecting / back / left.
//
//   RECONNECT_GRACE_SECONDS=10 DEV_SANDBOX=1 npm start   # short grace; DEV_SANDBOX ends a match on demand
//   node scripts/smoke-network.mjs
//
// Needs Playwright (not a project dependency) and a built client (dist/).

import { createRequire } from 'module';
import net from 'net';

const { chromium } = createRequire(import.meta.url)('playwright');
const SERVER_PORT = Number(process.env.SERVER_PORT || 3000);
const PROXY_PORT = Number(process.env.PROXY_PORT || 3101);
const GRACE = Number(process.env.GRACE || 10);
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a TCP proxy we can freeze or cut ──
let mode = 'ok'; // ok | stall | down
const pairs = new Set();
const proxy = net.createServer((client) => {
  if (mode === 'down') { client.destroy(); return; }
  const upstream = net.connect(SERVER_PORT, '127.0.0.1');
  const pair = { client, upstream };
  pairs.add(pair);
  const forward = (from, to) => from.on('data', (d) => {
    if (mode === 'stall') { from.pause(); (pair.held ||= []).push(() => { to.write(d); from.resume(); }); return; }
    to.write(d);
  });
  forward(client, upstream);
  forward(upstream, client);
  const close = () => { pairs.delete(pair); client.destroy(); upstream.destroy(); };
  client.on('error', close); upstream.on('error', close);
  client.on('close', close); upstream.on('close', close);
});
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
function setMode(m) {
  mode = m;
  if (m === 'down') for (const p of pairs) { p.client.destroy(); p.upstream.destroy(); }
  if (m === 'ok') for (const p of pairs) { const h = p.held || []; p.held = []; h.forEach((f) => f()); }
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function player(port) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/?debug`, { waitUntil: 'load' });
  await page.evaluate(() => {
    window.__events = [];
    window.__owSocket.onAny((ev, data) => {
      if (/^(slots-update|player-connection|player-eliminated|game-over|notification|reconnect-success|reconnect-failed)$/.test(ev)) {
        window.__events.push({ ev, data, t: performance.now() });
      }
      if (ev === 'sim-stats') window.__lastStats = performance.now();
    });
  });
  return { page, errors };
}

const A = await player(PROXY_PORT);
const B = await player(SERVER_PORT);
for (const p of [A, B]) await p.page.locator('#linkGuest:visible').first().click().catch(() => {});
await Promise.all([A, B].map((p) => p.page.locator('#btn-quick-play-guest:visible').first().click()));
await Promise.all([A, B].map((p) => p.page.waitForFunction(() => document.getElementById('gameHUD')?.style.display === 'flex', null, { timeout: 90000 })));
const fidA = await A.page.evaluate(() => parseInt(window.__owState.playerFaction));
const fidB = await B.page.evaluate(() => parseInt(window.__owState.playerFaction));
const sameRoom = await B.page.evaluate((f) => {
  const s = window.__owState.activePlayerSlots || {};
  return !!(s[f] && !s[f].isBot);
}, fidA);
check('both players are in the same match', sameRoom && fidA !== fidB, `A=${fidA} B=${fidB}`);
await sleep(3000);

const overlayShown = () => A.page.evaluate(() => getComputedStyle(document.getElementById('reconnectingOverlay')).display !== 'none');
const statsAge = () => A.page.evaluate(() => performance.now() - (window.__lastStats || 0));
async function timeUntil(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(100); }
  return null;
}
async function consistent(label) {
  await sleep(2500);
  const s = await A.page.evaluate(() => {
    const st = window.__owState; const fid = parseInt(st.playerFaction);
    return {
      owned: window.__owCountOwned(fid),
      land: parseInt(document.getElementById('lblMyCells').textContent.replace(/,/g, '')) || 0,
      hud: document.getElementById('gameHUD').style.display,
    };
  });
  check(`${label}: A's map matches the server afterwards`, s.hud === 'flex' && s.land > 0 && Math.abs(s.owned - s.land) <= Math.max(30, s.land * 0.02), JSON.stringify(s));
}
const seenByB = (pred) => B.page.evaluate((src) => window.__events.some(new Function('e', `return (${src})(e)`)), pred.toString());
const slotOfA = () => B.page.evaluate((f) => (window.__owState.activePlayerSlots || {})[f], fidA);

// ── 1. lag: the connection freezes without closing ──
setMode('stall');
const lagShown = await timeUntil(overlayShown, 15000);
check('lag: A is shown a reconnecting/unstable state within 5 s', lagShown !== null && lagShown <= 5000, lagShown === null ? 'never shown in 15 s' : `${lagShown} ms`);
setMode('ok');
const lagBack = await timeUntil(async () => !(await overlayShown()) && (await statsAge()) < 1000, 30000);
check('lag: A recovers by itself when the connection comes back', lagBack !== null, lagBack === null ? 'not recovered in 30 s' : `${lagBack} ms`);
await consistent('lag');

// ── 2. drop: cut, refused for 6 s, back ──
await B.page.evaluate(() => { window.__events = []; });
setMode('down');
const dropShown = await timeUntil(overlayShown, 10000);
check('drop: A sees "Reconnecting…" at once', dropShown !== null && dropShown <= 2000, dropShown === null ? 'never' : `${dropShown} ms`);
await sleep(6000);
check('drop: B is told A is reconnecting', await seenByB((e) => e.ev === 'player-connection' && e.data.state === 'reconnecting'));
setMode('ok');
const dropBack = await timeUntil(async () => !(await overlayShown()) && (await statsAge()) < 1000, 30000);
check('drop: A is back in the match', dropBack !== null, dropBack === null ? 'not recovered in 30 s' : `${dropBack} ms`);
check('drop: A still controls its faction (no bot)', !(await slotOfA())?.isBot, JSON.stringify(await slotOfA()));
check('drop: B is told A is back', await seenByB((e) => e.ev === 'player-connection' && e.data.state === 'back'));
await consistent('drop');

// ── 3. long outage: a bot takes over, A takes it back on return ──
await B.page.evaluate(() => { window.__events = []; });
setMode('down');
const botTook = await timeUntil(async () => (await slotOfA())?.isBot === true, (GRACE + 15) * 1000);
check('long: after the grace period a bot plays A\'s faction', botTook !== null, botTook === null ? 'no bot' : `after ${Math.round(botTook / 1000)} s`);
setMode('ok');
const longBack = await timeUntil(async () => !(await overlayShown()) && (await statsAge()) < 1000, 40000);
check('long: A comes back into its match', longBack !== null, longBack === null ? `not recovered; A's screen: ${await A.page.evaluate(() => window.__owState.gameState)}` : `${longBack} ms`);
check('long: A has its faction back from the bot', (await slotOfA())?.isBot === false, JSON.stringify(await slotOfA()));
await consistent('long');

// ── 4. the match ends while A is cut off ──
setMode('down');
await timeUntil(overlayShown, 5000);
await B.page.evaluate(() => window.__owSocket.emit('dev-simulate-game-over', { result: 'win' }));
await B.page.waitForSelector('#matchEndOverlay .end-card', { timeout: 20000 }).catch(() => {});
setMode('ok');
const endedMsg = await timeUntil(() => A.page.evaluate(() => {
  const o = document.getElementById('serverErrorOverlay');
  return o && getComputedStyle(o).display !== 'none' && /ended/i.test(document.getElementById('serverErrorMsg').textContent);
}), 20000);
check('ended: on return A is told the match ended (and who won)', endedMsg !== null,
  await A.page.evaluate(() => document.getElementById('serverErrorMsg').textContent));

// ── 5. a new match; A drops during spawn selection ──
await A.page.click('#btnServerErrorReturn');
await A.page.waitForEvent('load').catch(() => {});
await B.page.evaluate(() => sessionStorage.removeItem('ow_auto_quick_play'));
await B.page.goto(`http://localhost:${SERVER_PORT}/?debug`, { waitUntil: 'load' });
for (const p of [A, B]) {
  await p.page.evaluate(() => {
    window.__events = [];
    window.__owSocket.onAny((ev, data) => {
      if (/^(slots-update|player-connection|reconnect-success|reconnect-failed)$/.test(ev)) window.__events.push({ ev, data, t: performance.now() });
      if (ev === 'sim-stats') window.__lastStats = performance.now();
    });
  });
  await p.page.locator('#linkGuest:visible').first().click().catch(() => {});
}
await Promise.all([A, B].map((p) => p.page.locator('#btn-quick-play-guest:visible').first().click()));
await A.page.waitForFunction(() => document.getElementById('spawnOverlay')?.style.display === 'flex', null, { timeout: 60000 });
setMode('down');
await sleep(2500);
setMode('ok');
const backInPicker = await timeUntil(() => A.page.evaluate(() =>
  window.__owState.gameState === 'SPAWN_SELECTION' && document.getElementById('spawnOverlay')?.style.display === 'flex'
  && getComputedStyle(document.getElementById('reconnectingOverlay')).display === 'none'), 8000);
check('spawn: after a drop A is back in the spawn picker', backInPicker !== null,
  await A.page.evaluate(() => `${window.__owState.gameState}, picker ${document.getElementById('spawnOverlay')?.style.display}`));
const startedA = await A.page.waitForFunction(() => document.getElementById('gameHUD')?.style.display === 'flex', null, { timeout: 60000 }).then(() => true).catch(() => false);
check('spawn: …and then plays the match normally', startedA && (await A.page.evaluate(() => window.__owCountOwned(parseInt(window.__owState.playerFaction)))) > 0);
await B.page.waitForFunction(() => document.getElementById('gameHUD')?.style.display === 'flex', null, { timeout: 60000 });
const fidA2 = await A.page.evaluate(() => parseInt(window.__owState.playerFaction));
await sleep(2000);

// ── 6. quit from the menu ──
await B.page.evaluate(() => { window.__events = []; });
const quitAt = Date.now();
await A.page.evaluate(() => document.getElementById('btnQuitToMenu').click());
const slotOfA2 = () => B.page.evaluate((f) => (window.__owState.activePlayerSlots || {})[f], fidA2);
const quitBot = await timeUntil(async () => (await slotOfA2())?.isBot === true, 15000);
check('quit: a bot takes over A\'s faction at once', quitBot !== null && Date.now() - quitAt < 3500, quitBot === null ? 'no bot in 15 s' : `${quitBot} ms`);
check('quit: B is told A left', await seenByB((e) => e.ev === 'player-connection' && e.data.state === 'left'));
await A.page.waitForSelector('#homeScreen', { state: 'visible', timeout: 15000 }).catch(() => {});
check('quit: A is back on the home screen', await A.page.locator('#homeScreen').isVisible());
check('quit: A does not rejoin the match it left on reload', await A.page.evaluate(() => !sessionStorage.getItem('reconnectToken')));

check('no page errors (A)', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
check('no page errors (B)', B.errors.length === 0, B.errors.slice(0, 2).join(' | '));
await browser.close();
proxy.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
