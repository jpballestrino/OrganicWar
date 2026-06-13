// Reproduces the Esc-menu bug: guest quick-play into a match, then press
// Escape and observe (a) how many window keydown listeners exist, (b) whether
// the registered esc handler runs, (c) the overlay's display after each press.
import puppeteer from 'puppeteer-core';

const log = (...a) => console.log('[esc-test]', ...a);

(async () => {
  const browser = await puppeteer.launch({
    channel: 'chrome',
    headless: 'new',
    args: ['--use-gl=angle', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => log('PAGE ERROR:', err.message));
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[probe]')) log('PAGE:', t);
  });

  // Count every keydown listener registered on window, before app code runs.
  await page.evaluateOnNewDocument(() => {
    window.__kdListeners = [];
    const orig = window.addEventListener.bind(window);
    window.addEventListener = (type, fn, opts) => {
      if (type === 'keydown') {
        window.__kdListeners.push(String(fn).slice(0, 80).replace(/\s+/g, ' '));
      }
      return orig(type, fn, opts);
    };
  });

  log('navigating...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });

  // Guest flow: Play as Guest -> Quick Battle.
  await page.waitForSelector('#linkGuest', { timeout: 15000 });
  await page.click('#linkGuest');
  await page.waitForSelector('#btn-quick-play-guest', { visible: true, timeout: 15000 });
  await page.click('#btn-quick-play-guest');
  log('quick play clicked, waiting for match start (5s countdown)...');

  // #gameArea is always display:flex; "map on screen" means the home screen and
  // waiting overlay are gone (quick play hides the waiting overlay on join).
  await page.waitForFunction(() => {
    const hidden = (id) => {
      const el = document.getElementById(id);
      return !el || getComputedStyle(el).display === 'none' || el.style.opacity === '0';
    };
    return hidden('homeScreen') && hidden('waitingOverlay');
  }, { timeout: 30000 });
  log('map on screen (countdown phase, gameState=SPAWN_SELECTION expected).');

  // Instrument the registered esc handler so we can see if it runs.
  const setup = await page.evaluate(() => {
    const r = {
      kdListeners: window.__kdListeners,
      escHandlerType: typeof window.__escKeyHandler,
      activeElement: document.activeElement
        ? `${document.activeElement.tagName}#${document.activeElement.id || '(no id)'}`
        : 'none',
    };
    if (window.__escKeyHandler) {
      window.__escRuns = 0;
      const orig = window.__escKeyHandler;
      window.removeEventListener('keydown', orig);
      const wrapped = (e) => { if (e.key === 'Escape') { window.__escRuns++; } return orig(e); };
      window.__escKeyHandler = wrapped;
      window.addEventListener('keydown', wrapped);
    }
    return r;
  });
  log('window keydown listeners registered:', JSON.stringify(setup.kdListeners, null, 1));
  log('__escKeyHandler:', setup.escHandlerType, '| focused element:', setup.activeElement);

  const probe = () => page.evaluate(() => {
    const ov = document.getElementById('escMenuOverlay');
    return {
      runs: window.__escRuns,
      display: ov ? getComputedStyle(ov).display : 'MISSING',
    };
  });
  const press = async (label) => {
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));
    const s = await probe();
    log(`${label}: handlerRuns=${s.runs} overlayDisplay=${s.display}`);
    return s;
  };

  // Phase 1: during the quick-play start countdown (map already visible).
  const p1 = await press('countdown phase, press #1 (expect open)');
  await press('countdown phase, press #2 (expect closed again)');

  // Phase 2: after the match has started (countdown is 5s).
  log('waiting 7s for start-match-now...');
  await new Promise((r) => setTimeout(r, 7000));
  const p3 = await press('in-match, press #1 (expect open)');
  await press('in-match, press #2 (expect closed again)');

  if (p1.display === 'flex' && p3.display === 'flex') {
    log('PASS: menu opens on the first press in both phases.');
  } else {
    log('FAIL: menu did not open on first press.');
    process.exitCode = 1;
  }

  await browser.close();
  log('done');
})().catch((e) => { console.error('[esc-test] FAILED:', e.message); process.exit(1); });
