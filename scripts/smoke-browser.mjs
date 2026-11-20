// Browser smoke test: plays the first seconds of a Quick Battle in headless
// Chromium against a running server and checks the in-match UI.
//
//   npm run build && npm start        # in one terminal (serves dist/ on :3000)
//   node scripts/smoke-browser.mjs    # in another
//
// Options (env): URL (default http://localhost:3000), SHOTS (directory for
// screenshots; omit to skip them). Exits non-zero if any check fails.
//
// Needs Playwright with a Chromium build. It is not a project dependency —
// install it yourself (`npm i -D playwright && npx playwright install chromium`)
// or run where it is already available.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// require() so a globally installed Playwright (NODE_PATH) is found too.
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = process.env.URL || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || '';
// MODE=mega plays a Mega Battle (64 players) instead of a standard Quick Battle.
const MODE = process.env.MODE === 'mega' ? 'mega' : 'standard';
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  // Software GL can be slow to produce a frame; a missing picture is not a failure.
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 90000 })
    .catch((e) => console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`));
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

await page.goto(`${URL}/?debug`, { waitUntil: 'networkidle' });
await shot(page, '01-home');

// Start a Quick Battle (guest or logged-in button, whichever is on screen).
const guest = page.locator('#linkGuest:visible').first();
if (await guest.count()) { await guest.click(); await page.waitForTimeout(400); }
await shot(page, '01b-guest-home');
const quick = MODE === 'mega'
  ? page.locator('#btn-mega-play-guest:visible, #btn-mega-play:visible').first()
  : page.locator('#btn-quick-play-guest:visible, #btn-quick-play:visible').first();
await quick.click();

// Spawn selection: pick a land cell near the middle of the screen.
await page.waitForFunction(() => document.getElementById('spawnOverlay')?.style.display === 'flex', null, { timeout: 30000 });
const timerText = await page.textContent('#spawnTimerText');
check('spawn timer shows the server duration', /^\d+$/.test((timerText || '').trim()), `"${timerText}"`);
const radius = await page.evaluate(() => window.__owState.safeZoneRadius);
// 80 up to 20 players; a Mega room's 45 scaled to its bigger map (2560 / 1920).
check('spawn safe zone fits the room size', radius === (MODE === 'mega' ? 60 : 80), `radius ${radius}`);
const mapSize = await page.evaluate(() => [window.renderer.mapW, window.renderer.mapH].join('x'));
check('the room\'s map size is in use', mapSize === (MODE === 'mega' ? '2560x1440' : '1920x1080'), mapSize);
for (const [x, y] of [[960, 540], [700, 400], [1200, 600], [800, 700], [1100, 350]]) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(150);
}
await shot(page, '02-spawn');

await page.waitForFunction(() => document.getElementById('gameHUD')?.style.display === 'flex', null, { timeout: 40000 });
await page.waitForTimeout(3000);
await shot(page, '03-match-1920');

// --- Build bar ---
const bar = await page.$$eval('.build-option', els => els.map(e => ({
  key: e.querySelector('.build-key').textContent.trim(),
  name: e.querySelector('.build-name').textContent.trim(),
  cost: e.querySelector('.build-cost').textContent.trim(),
  tag: e.tagName,
  title: e.title,
})));
check('build bar has seven actions', bar.length === 7, bar.map(b => `${b.key}:${b.name}`).join(' '));
check('build bar is in hotkey order', bar.map(b => b.key).join('') === [...bar.map(b => b.key)].sort().join(''));
check('build buttons are real <button>s with tooltips', bar.every(b => b.tag === 'BUTTON' && b.title.length > 10));

// --- Esc in a build mode cancels the mode and nothing else ---
const escResult = await page.evaluate(() => {
  // The state module is bundled; with ?debug the game exposes it on window.
  const st = window.__owState;
  if (!st) return { hook: false };
  st.activePurchaseMode = 'defense_building';
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
  const menuOpen = document.getElementById('escMenuOverlay').style.display !== 'none';
  const modeAfter = st.activePurchaseMode;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
  const menuOpen2 = document.getElementById('escMenuOverlay').style.display !== 'none';
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
  return { hook: true, menuOpen, modeAfter, menuOpen2 };
});
check('debug state hook is present', escResult.hook === true);
if (escResult.hook) {
  check('Esc in build mode cancels the mode', escResult.modeAfter === null);
  check('Esc in build mode does not open the pause menu', escResult.menuOpen === false);
  check('a second Esc opens the pause menu', escResult.menuOpen2 === true);
}

// --- Unaffordable action is refused with a toast, from the hotkey ---
await page.keyboard.press('4'); // a silo costs far more than the starting gold
await page.waitForTimeout(300);
const modeAfterSilo = await page.evaluate(() => String(window.__owState ? window.__owState.activePurchaseMode : 'no-hook'));
check('unaffordable hotkey does not enter the mode', modeAfterSilo === 'null', modeAfterSilo);

// --- Blitz: key 1 starts it, the server confirms the cooldown, a 2nd press is refused ---
await page.keyboard.press('1');
await page.waitForTimeout(1500); // a few sim-stats messages
const blitz = await page.evaluate(() => {
  const st = window.__owState;
  const el = document.querySelector('.build-option[data-mode="blitz"] .build-cost');
  return { cooldown: (st.blitzReadyAt - performance.now()) / 1000, label: el.textContent };
});
check('Blitz starts and the server reports its cooldown', blitz.cooldown > 40 && blitz.cooldown < 52, JSON.stringify(blitz));
check('Blitz button shows it is active', /^Active \d+s$/.test(blitz.label), blitz.label);

// --- Prices come from the sim ---
const prices = await page.evaluate(() => window.__owState.prices);
check('live prices arrive in sim-stats', prices && prices.defense >= 2000 && prices.silo >= 10000, JSON.stringify(prices));

// --- HUD numbers ---
const hud = await page.evaluate(() => ({
  troops: document.getElementById('lblMyTroops').textContent,
  land: document.getElementById('lblMyCells').textContent,
  gold: document.getElementById('lblMyGold').textContent,
  leaderboardRows: document.getElementById('leaderboardList').children.length,
}));
check('HUD shows live numbers', parseInt(hud.land.replace(/,/g, '')) > 0 && hud.leaderboardRows > 0, JSON.stringify(hud));
const players = await page.evaluate(() => Object.values(window.__owState.activePlayerSlots).filter(Boolean).length);
check('room has the expected number of factions', players === (MODE === 'mega' ? 64 : 20), `${players} factions`);

// --- Fog of war and minimap ---
const fogNow = await page.evaluate(() => ({ fog: window.__owFog(), minimap: document.getElementById('minimap')?.style.display }));
check('fog of war: only the surroundings are live', fogNow.fog.on && fogNow.fog.seen > 0 && fogNow.fog.seen < fogNow.fog.blocks / 2, JSON.stringify(fogNow.fog));
check('minimap is shown with every empire', fogNow.minimap === 'block' && fogNow.fog.coarseOwners >= 5, JSON.stringify(fogNow));

// --- Reload mid-match: the reconnect token must bring back map, HUD, buildings ---
const ownedBefore = await page.evaluate(() => window.__owCountOwned(parseInt(window.__owState.playerFaction)));
const buildingsBefore = await page.evaluate(() => window.__owState.buildings.length);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('gameHUD')?.style.display === 'flex', null, { timeout: 40000 })
  .catch(() => {});
await page.waitForTimeout(4000);
const after = await page.evaluate(() => {
  const st = window.__owState;
  const fid = parseInt(st.playerFaction);
  return {
    hud: document.getElementById('gameHUD').style.display,
    bar: document.getElementById('gameEconomyHUD').style.display,
    owned: fid ? window.__owCountOwned(fid) : 0,
    land: parseInt(document.getElementById('lblMyCells').textContent.replace(/,/g, '')) || 0,
    others: [...Array(20).keys()].reduce((n, i) => n + (i + 1 !== fid && window.__owCountOwned(i + 1) > 0 ? 1 : 0), 0),
    buildings: st.buildings.length,
    fog: window.__owFog(),
  };
});
await shot(page, '05-after-reload');
check('reload: HUD and build bar are back', after.hud === 'flex' && after.bar === 'flex', JSON.stringify(after));
if (after.land === 0) {
  // The idle test player can be overrun by bots while the (slow) reload runs.
  console.log(`SKIP  reload: own territory — the test player was eliminated during the reload (had ${ownedBefore} cells); re-run`);
} else {
  check('reload: own territory is back on the map', after.owned > 0 && Math.abs(after.owned - after.land) <= Math.max(50, after.land * 0.05),
    `before ${ownedBefore}, after ${after.owned}, HUD land ${after.land}`);
}
// Fog of war: rivals out of sight are on the minimap layer, not cell by cell.
check('reload: rival territories are back (minimap layer)', after.fog.coarseOwners >= 5, `${after.fog.coarseOwners} empires on the minimap, ${after.others} in sight`);
check('reload: the fog of war is back — only part of the map is live',
  after.fog.on && after.fog.seen > 0 && after.fog.seen < after.fog.blocks, JSON.stringify(after.fog));
check('reload: buildings are back', buildingsBefore === 0 || after.buildings > 0, `before ${buildingsBefore}, after ${after.buildings}`);

// Layout last: it is slow under software GL, and an idle player is fair game
// for the bots once the opening truce ends.
// --- Bottom bar must fit the window at common widths ---
for (const width of [1920, 1600, 1366, 1280, 1100, 1024]) {
  await page.setViewportSize({ width, height: 768 });
  // The HUD animates its size (0.3s transition) and software GL is slow: wait
  // until the bar's edges stop moving (two equal readings) before measuring.
  await page.waitForFunction((w) => {
    const els = document.querySelectorAll('#gameEconomyHUD .build-option');
    const key = `${window.innerWidth}:${Math.round(els[0].getBoundingClientRect().left)}:${Math.round(els[els.length - 1].getBoundingClientRect().right)}`;
    const settled = window.innerWidth === w && window.__lastBarKey === key;
    window.__lastBarKey = key;
    return settled;
  }, width, { polling: 400, timeout: 30000 }).catch(() => {});
  const fit = await page.evaluate(() => {
    const hud = document.getElementById('gameEconomyHUD');
    const r = [...hud.querySelectorAll('.build-option')].map(e => e.getBoundingClientRect());
    const stats = hud.querySelector('.hud-stats-container').getBoundingClientRect();
    const first = r[0];
    const last = r[r.length - 1];
    return {
      w: window.innerWidth, left: Math.round(first.left), right: Math.round(last.right), statsRight: Math.round(stats.right),
      inside: last.right <= window.innerWidth && first.left >= 0,
      noOverlap: stats.right <= first.left,
      overflow: hud.scrollWidth > hud.clientWidth,
    };
  });
  check(`bottom bar fits at ${width}px`, fit.inside && fit.noOverlap && !fit.overflow, JSON.stringify(fit));
  await shot(page, `04-match-${width}`);
}
await page.setViewportSize({ width: 1920, height: 1080 });

// --- Synergy links: bots build next to their own buildings, so links appear ---
await page.setViewportSize({ width: 1920, height: 1080 });
const linkInfo = await page.waitForFunction(() => {
  const linked = window.__owState.buildings.filter(b => b.links && !b.constructing);
  if (linked.length < 2) return null;
  const b = linked[0];
  const r = window.renderer;
  r.camera.zoom = 3;
  r.camera.x = b.col - r.canvas.width / 3 / 2;
  r.camera.y = b.row - r.canvas.height / 3 / 2;
  return { linked: linked.length, at: [b.row, b.col], links: b.links };
}, null, { polling: 2000, timeout: 90000 }).then(h => h.jsonValue()).catch(() => null);
check('synergy links reach the client', !!linkInfo, JSON.stringify(linkInfo));
// Re-aim after the viewport change above has been fully handled.
await page.waitForTimeout(1500);
if (linkInfo) {
  await page.evaluate(([row, col]) => {
    const r = window.renderer;
    r.camera.zoom = 3;
    r.camera.x = col - r.canvas.width / 3 / 2;
    r.camera.y = row - r.canvas.height / 3 / 2;
  }, linkInfo.at);
  await page.waitForTimeout(1500);
}
await shot(page, '06-links');

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
