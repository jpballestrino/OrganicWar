// Camera keys (W/A/S/D and arrows) in a real match, in headless Chromium.
// Each case holds a key for a moment and checks that the camera moved:
//   1. a player who never picked a spawn (the server placed them)
//   2. after the window lost focus while a key was held (key stuck down)
//   3. with the focus left in a hidden text field from the menu
//   4. on an AZERTY keyboard (the W/A/S/D keys type Z/Q/S/D)
//
//   npm run build && npm start      # then:
//   node scripts/smoke-camera.mjs
// Needs Playwright (not a project dependency).

import { createRequire } from 'module';

const { chromium } = createRequire(import.meta.url)('playwright');
const URL = process.env.URL || 'http://localhost:3000';
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${URL}/?debug`, { waitUntil: 'load' });
await page.locator('#linkGuest:visible').first().click().catch(() => {});
await page.locator('#btn-quick-play-guest:visible').first().click();
// Don't pick a spawn: let the server place us.
await page.waitForFunction(() => document.getElementById('gameHUD')?.style.display === 'flex', null, { timeout: 90000 });
await page.waitForTimeout(1500);

const cam = () => page.evaluate(() => ({ x: window.renderer.camera.x, y: window.renderer.camera.y, zoom: window.renderer.camera.zoom }));
// Hold a key (as a real keyboard sends it) and report how far the camera went.
async function hold(key, code, ms = 600) {
  const a = await cam();
  await page.evaluate(([k, c]) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: c, bubbles: true })), [key, code]);
  await page.waitForTimeout(ms);
  await page.evaluate(([k, c]) => window.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: c, bubbles: true })), [key, code]);
  const b = await cam();
  return { dx: b.x - a.x, dy: b.y - a.y, zoom: b.zoom };
}

// 1. Auto-placed spawn: the match starts zoomed in on our land, and D moves.
// (At the map's right edge D can't go further: then A must move it.)
let m = await hold('d', 'KeyD');
if (m.dx <= 5) m = await hold('a', 'KeyA');
check('a player who did not pick a spawn can move the camera (D, or A at the right edge)', Math.abs(m.dx) > 5, `moved ${m.dx.toFixed(1)}, zoom ${m.zoom.toFixed(2)}`);

// From here on, start each check from the middle of the map: a spawn at the
// map's edge pins the camera there (S can't move it further down), which
// read as a stuck key.
const centre = () => page.evaluate(() => {
  const r = window.renderer;
  r.camera.x = r.mapW / 2 - r.canvas.width / r.camera.zoom / 2;
  r.camera.y = r.mapH / 2 - r.canvas.height / r.camera.zoom / 2;
});
await centre();

// 2. Key held when the window loses focus: no stuck key afterwards.
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true })));
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
m = await hold('s', 'KeyS');
check('after losing focus with W held, S still moves the camera', m.dy > 5, `moved ${m.dy.toFixed(1)}`);
await page.waitForTimeout(400);
const still = await cam();
await page.waitForTimeout(400);
check('…and the camera does not keep drifting on its own', Math.abs((await cam()).y - still.y) < 0.5);

// 3. Focus left in a hidden text field (the menu's nickname box).
await page.evaluate(() => { const i = document.getElementById('nicknameInput'); i.focus(); });
await centre();
m = await hold('a', 'KeyA');
check('with the focus in a hidden menu field, A still moves the camera', m.dx < -5, `moved ${m.dx.toFixed(1)}`);
// …but typing in a visible field (guild chat, if shown) must not move it: a
// visible input we add for the test.
await page.evaluate(() => {
  const i = document.createElement('input');
  i.id = '__camTestInput';
  i.style.cssText = 'position:fixed;top:5px;left:5px;z-index:99999';
  document.body.appendChild(i);
  i.focus();
});
m = await hold('d', 'KeyD');
check('typing in a visible text field does not move the camera', Math.abs(m.dx) < 0.5, `moved ${m.dx.toFixed(1)}`);
await page.evaluate(() => { document.getElementById('__camTestInput').remove(); document.activeElement?.blur?.(); });

// 4. AZERTY: the physical W/A keys type "z"/"q".
await centre();
m = await hold('z', 'KeyW');
check('AZERTY: the key in the W position moves up', m.dy < -5, `moved ${m.dy.toFixed(1)}`);
await centre();
m = await hold('q', 'KeyA');
check('AZERTY: the key in the A position moves left', m.dx < -5, `moved ${m.dx.toFixed(1)}`);

// Arrows keep working.
await centre();
m = await hold('ArrowRight', 'ArrowRight');
check('arrow keys move the camera', m.dx > 5, `moved ${m.dx.toFixed(1)}`);

check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
