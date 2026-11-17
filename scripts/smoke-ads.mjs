// Browser check of the optional Google ads (server/ads.js + src/js/ads.js).
// Google's script is replaced by a local stand-in, so this tests OUR side:
// which script is requested, where ad units go, and that between-match ad
// breaks (Ad Placement API) never block the game.
//
//   ADSENSE_CLIENT=ca-pub-1234567890123456 ADSENSE_SLOT_HOME=1111111111 \
//   ADSENSE_SLOT_RECAP=2222222222 ADSENSE_GAME_BREAKS=1 DEV_SANDBOX=1 npm start
//   node scripts/smoke-ads.mjs                 # ads on (the server above)
//   EXPECT=off node scripts/smoke-ads.mjs      # against a server without ADSENSE_*
//
// Needs Playwright (not a project dependency), like smoke-browser.mjs.

import { createRequire } from 'module';

const { chromium } = createRequire(import.meta.url)('playwright');
const URL = process.env.URL || 'http://localhost:3000';
const EXPECT_OFF = process.env.EXPECT === 'off';
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// Stand-in for adsbygoogle.js: fills display units with a placeholder and runs
// ad breaks (beforeAd → afterAd → adBreakDone after 600 ms), recording every
// call in sessionStorage so it survives the reload Play Again does.
const STUB = `
(function () {
  const log = (e) => { const a = JSON.parse(sessionStorage.getItem('adlog') || '[]'); a.push(e); sessionStorage.setItem('adlog', JSON.stringify(a)); };
  function handle(o) {
    if (o && o.type) {
      log({ break: o.type, name: o.name });
      if (o.beforeAd) o.beforeAd();
      setTimeout(() => { if (o.afterAd) o.afterAd(); if (o.adBreakDone) o.adBreakDone({ breakStatus: 'viewed' }); }, 600);
    } else if (o && o.preloadAdBreaks) {
      log({ config: true });
    } else {
      document.querySelectorAll('ins.adsbygoogle:not([data-done])').forEach((ins) => {
        ins.dataset.done = '1'; ins.style.height = '250px'; ins.style.background = '#334155';
        log({ unit: ins.getAttribute('data-ad-slot') });
      });
    }
  }
  const queued = window.adsbygoogle || [];
  window.adsbygoogle = { push: handle };
  queued.forEach(handle);
})();`;

// Time from a click on `buttonId` to the page starting to unload, measured in
// the page itself (Playwright's own click overhead is large on slow software
// rendering and would swamp what we are measuring).
async function msUntilUnload(page, buttonId) {
  await page.evaluate((id) => {
    document.getElementById(id).addEventListener('click', () => {
      if (!sessionStorage.getItem('tClick')) sessionStorage.setItem('tClick', String(performance.now()));
    }, { capture: true });
    window.addEventListener('beforeunload', () => sessionStorage.setItem('tUnload', String(performance.now())));
  }, buttonId);
  await page.locator(`#${buttonId}`).click();
  await page.locator(`#${buttonId}`).click({ timeout: 300 }).catch(() => {}); // double click
  await page.waitForEvent('load', { timeout: 60000 });
  return page.evaluate(() => {
    const ms = Number(sessionStorage.getItem('tUnload')) - Number(sessionStorage.getItem('tClick'));
    sessionStorage.removeItem('tClick');
    sessionStorage.removeItem('tUnload');
    return Math.round(ms);
  });
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function newPage({ blockAds = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const requests = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*googlesyndication.com/**', (route) => {
    requests.push(route.request().url());
    return blockAds ? route.abort() : route.fulfill({ contentType: 'text/javascript', body: STUB });
  });
  return { page, requests, errors };
}

// ── server side ──
const txt = await fetch(`${URL}/ads.txt`);
const csp = (await fetch(`${URL}/`)).headers.get('content-security-policy') || '';
const cfg = await (await fetch(`${URL}/api/client-config`)).json();
const privacy = await (await fetch(`${URL}/privacy`)).text();
if (EXPECT_OFF) {
  check('ads off: client config says so', cfg.ads === null);
  check('ads off: no ads.txt', txt.status === 404);
  check('ads off: CSP has no Google ad domains', !/googlesyndication/.test(csp));
  check('ads off: privacy policy has no advertising section', !/<h2>Advertising<\/h2>/.test(privacy) && /Privacy Policy/.test(privacy));
} else {
  check('client config carries the publisher id', cfg.ads && /^ca-pub-/.test(cfg.ads.client), JSON.stringify(cfg.ads));
  check('ads.txt is served', txt.status === 200 && /^google\.com, pub-\d+, DIRECT, f08c47fec0942fa0/.test(await txt.text()));
  check('CSP allows Google ad domains', /pagead2\.googlesyndication\.com/.test(csp) && /frame-src[^;]*doubleclick/.test(csp));
  check('privacy policy explains the ads', /<h2>Advertising<\/h2>/.test(privacy) && /adssettings\.google\.com/.test(privacy));
}

// ── home screen ──
{
  const { page, requests, errors } = await newPage();
  await page.goto(`${URL}/?debug`, { waitUntil: 'load' });
  await page.locator('#linkGuest:visible').first().click().catch(() => {});
  await page.waitForTimeout(1500);
  const rail = await page.evaluate(() => {
    const r = document.getElementById('homeAdRail');
    return r ? { hidden: r.hidden, slot: r.querySelector('ins')?.getAttribute('data-ad-slot'), label: r.querySelector('.ad-label')?.textContent } : null;
  });
  if (EXPECT_OFF) {
    check('ads off: Google\'s script is never requested', requests.length === 0, requests.join(' '));
    check('ads off: no ad rail', rail === null);
  } else {
    check('Google\'s script is requested with the publisher id', requests.some(u => u.includes(`client=${cfg.ads.client}`)), requests[0] || 'none');
    check('home screen shows the home ad unit', rail && !rail.hidden && rail.slot === cfg.ads.slots.home && rail.label === 'Advertisement', JSON.stringify(rail));
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(500);
    const visible = await page.evaluate(() => getComputedStyle(document.getElementById('homeAdRail')).display !== 'none');
    check('no ad on narrow screens (would cover the menu)', !visible);
    await page.setViewportSize({ width: 1600, height: 900 });

    // ── a match, its recap, and Play Again through an ad break ──
    await page.locator('#btn-quick-play-guest:visible').first().click();
    await page.waitForFunction(() => document.getElementById('gameHUD')?.style.display === 'flex', null, { timeout: 90000 });
    const duringMatch = await page.evaluate(() => JSON.parse(sessionStorage.getItem('adlog') || '[]').filter(e => e.break).length);
    check('no ad break during the match', duringMatch === 0);
    // Unset and '0' both mean "sound on".
    const mutedBefore = await page.evaluate(() => localStorage.getItem('ow_sfx_muted') === '1');
    await page.evaluate(() => window.__owSocket.emit('dev-simulate-game-over', { result: 'win' }));
    await page.waitForSelector('#matchEndOverlay .end-card', { timeout: 30000 });
    await page.waitForTimeout(800);
    const recapSlot = await page.evaluate(() => document.querySelector('#matchEndOverlay .ad-rail ins')?.getAttribute('data-ad-slot'));
    check('recap shows the recap ad unit', recapSlot === cfg.ads.slots.recap, String(recapSlot));
    const waited = await msUntilUnload(page, 'btnEndPlayAgain');
    const log = await page.evaluate(() => JSON.parse(sessionStorage.getItem('adlog') || '[]'));
    const breaks = log.filter(e => e.break);
    check('Play Again plays one between-match break first', breaks.length === 1 && breaks[0].break === 'next' && waited >= 550,
      `${breaks.length} break(s), page left ${waited} ms after the click (stand-in break: 600 ms)`);
    check('sound setting is restored after the break',
      await page.evaluate(() => localStorage.getItem('ow_sfx_muted') === '1') === mutedBefore);
    await page.waitForFunction(() => window.__owState?.gameState && window.__owState.gameState !== 'SETUP', null, { timeout: 30000 }).catch(() => {});
    check('the next battle starts after the break', await page.evaluate(() => window.__owState.gameState !== 'SETUP'));
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ── ad blocker: the script fails to load, the game must not wait ──
if (!EXPECT_OFF) {
  const { page, errors } = await newPage({ blockAds: true });
  await page.goto(`${URL}/?debug`, { waitUntil: 'load' });
  await page.locator('#linkGuest:visible').first().click().catch(() => {});
  await page.locator('#btn-quick-play-guest:visible').first().click();
  await page.waitForFunction(() => document.getElementById('gameHUD')?.style.display === 'flex', null, { timeout: 90000 });
  await page.evaluate(() => window.__owSocket.emit('dev-simulate-game-over', { result: 'loss' }));
  await page.waitForSelector('#matchEndOverlay .end-card', { timeout: 30000 });
  const ms = await msUntilUnload(page, 'btnEndMenu');
  check('with an ad blocker, Main Menu works at once', ms < 200, `${ms} ms from click to leaving the page`);
  check('no page errors with the ad script blocked', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

await browser.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
