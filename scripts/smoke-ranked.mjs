// Browser check of the ranked screens: queue screen (status line, leaving the
// queue), two logged-in players matched into a ranked battle, and the rating
// change on the end-of-match screen. Server as for scripts/e2e-ranked.mjs
// (no email, DEV_SANDBOX=1), built client. Needs Playwright.

import { createRequire } from 'module';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.URL || 'http://localhost:3000';
const RUN = Date.now().toString(36).slice(-5);
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

async function account(name) {
  const username = `${name}_${RUN}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@example.test`, password: 'secret123' }),
  });
  return res.json();
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function player(name) {
  const { token, user } = await account(name);
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?debug`);
  await page.evaluate(([t, u]) => { localStorage.setItem('organicwar_auth_token', t); localStorage.setItem('organicwar_auth_user', JSON.stringify(u)); }, [token, user]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#homeStateLoggedIn', { state: 'visible', timeout: 15000 });
  return { page, errors };
}

const A = await player('ra');
const B = await player('rb');
check('no hidden button left on the queue screen', (await A.page.locator('#btn-force-start-ranked').count()) === 0);

// Queue, leave, queue again.
await A.page.click('#btn-ranked-play');
await A.page.waitForSelector('#homeStateRankedQueue', { state: 'visible' });
await A.page.waitForTimeout(1500);
check('queue screen says it is searching, with a rating range', /Searching|queue/.test(await A.page.textContent('#lblRankedPlayers')) && /rating/.test(await A.page.textContent('#lblRankedPlayers')),
  await A.page.textContent('#lblRankedPlayers'));
await A.page.click('#btn-leave-ranked');
check('leaving the queue returns to the menu', await A.page.locator('#homeStateLoggedIn').isVisible());

await A.page.click('#btn-ranked-play');
await B.page.click('#btn-ranked-play');
await B.page.waitForFunction(() => /2 players/.test(document.getElementById('lblRankedPlayers').textContent), null, { timeout: 10000 }).catch(() => {});
check('both see each other in the queue', /2 players/.test(await B.page.textContent('#lblRankedPlayers')), await B.page.textContent('#lblRankedPlayers'));
await Promise.all([A, B].map((p) => p.page.waitForFunction(() => document.getElementById('waitingTitle')?.textContent.includes('Ranked'), null, { timeout: 40000 })));
check('they are matched into a ranked lobby', true);
await Promise.all([A, B].map((p) => p.page.waitForFunction(() => document.getElementById('gameHUD')?.style.display === 'flex', null, { timeout: 60000 })));
check('the ranked battle starts for both', true);
const factions = await A.page.evaluate(() => Object.values(window.__owState.activePlayerSlots || {}).filter(Boolean).length);
check('the battle has a full field (bots fill it)', factions === 20, `${factions} factions`);

await A.page.waitForTimeout(2000);
await A.page.evaluate(() => window.__owSocket.emit('dev-simulate-game-over', { result: 'win' }));
for (const [p, sign] of [[A, '+'], [B, '-']]) {
  await p.page.waitForSelector('#matchEndOverlay .end-ranked:not(.end-ranked-pending)', { timeout: 20000 }).catch(() => {});
  const line = await p.page.textContent('#matchEndOverlay .end-ranked').catch(() => '');
  check(`the end screen shows the rating change (${sign === '+' ? 'winner' : 'loser'})`, line.includes(`(${sign}`) && /Rating 1000 → \d+/.test(line), line);
}
check('no page errors', A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].slice(0, 2).join(' | '));

await browser.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
