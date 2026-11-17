// Google ads on the client — optional; everything here is a no-op unless the
// server reports an AdSense publisher id (GET /api/client-config, see
// server/ads.js). Ads appear only around matches, never during one:
//   * display units in a side rail on the home screen and the recap screen
//     (wide screens only, so they never overlap the menu);
//   * optionally an interstitial between matches (Play Again / Main Menu),
//     through Google's Ad Placement API (H5 Games Ads).
// If the ad script is blocked (ad blockers) the game carries on as if ads
// were off: a between-match break can never hold a player hostage.

import { isMuted, setMuted } from './sfx.js';

const SCRIPT_URL = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
// The side rail needs this much width beside the centred menu / recap card.
const RAIL_MIN_WIDTH = 1150;
// An ad break that hasn't finished by then is abandoned and the game goes on.
const BREAK_TIMEOUT_MS = 40000;

let config = null;           // server config ({client, slots, gameBreaks, test}) or null
let scriptState = 'none';    // none | loading | loaded | failed

export function adsEnabled() { return !!config; }

function loadScript() {
  if (scriptState !== 'none') return;
  scriptState = 'loading';
  window.adsbygoogle = window.adsbygoogle || [];
  // Ad Placement API entry points (no-ops until the script arrives).
  window.adBreak = window.adConfig = (o) => { window.adsbygoogle.push(o); };

  const s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = `${SCRIPT_URL}?client=${encodeURIComponent(config.client)}`;
  if (config.gameBreaks) s.setAttribute('data-ad-frequency-hint', '120s'); // at most one break per 2 min
  if (config.test) { s.setAttribute('data-adbreak-test', 'on'); s.setAttribute('data-adtest', 'on'); }
  s.onload = () => { scriptState = 'loaded'; };
  s.onerror = () => { scriptState = 'failed'; };
  document.head.appendChild(s);

  if (config.gameBreaks) window.adConfig({ preloadAdBreaks: 'on', sound: 'on' });
}

// Fetch the server's ad settings and, if ads are on, load Google's script and
// fill the home-screen unit. Safe to call once at startup.
export async function initAds() {
  try {
    const res = await fetch('/api/client-config', { cache: 'no-store' });
    if (!res.ok) return;
    config = (await res.json()).ads || null;
  } catch (_) { return; } // offline / server error: no ads
  if (!config) return;
  loadScript();
  showHomeAd();
}

// Put a responsive display unit for `slot` into `container` (once). Skipped on
// narrow screens and when the slot isn't configured.
function fillUnit(container, slot) {
  if (!container || !slot || container.dataset.filled) return;
  if (window.innerWidth < RAIL_MIN_WIDTH) { container.hidden = true; return; }
  container.hidden = false;
  const label = document.createElement('div');
  label.className = 'ad-label';
  label.textContent = 'Advertisement';
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.style.display = 'block';
  ins.setAttribute('data-ad-client', config.client);
  ins.setAttribute('data-ad-slot', slot);
  ins.setAttribute('data-ad-format', 'auto');
  ins.setAttribute('data-full-width-responsive', 'true');
  if (config.test) ins.setAttribute('data-adtest', 'on');
  container.append(label, ins);
  container.dataset.filled = '1';
  try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (_) { /* blocked */ }
}

export function showHomeAd() {
  if (!config) return;
  let rail = document.getElementById('homeAdRail');
  if (!rail) {
    const home = document.getElementById('homeScreen');
    if (!home) return;
    rail = document.createElement('aside');
    rail.id = 'homeAdRail';
    rail.className = 'ad-rail';
    rail.hidden = true;
    home.appendChild(rail);
  }
  fillUnit(rail, config.slots.home);
}

// Add the recap-screen unit to the match-end overlay (called after it renders).
export function showRecapAd(overlay) {
  if (!config || !overlay || !config.slots.recap) return;
  let rail = overlay.querySelector('.ad-rail');
  if (!rail) {
    rail = document.createElement('aside');
    rail.className = 'ad-rail ad-rail-recap';
    rail.hidden = true;
    overlay.appendChild(rail);
  }
  fillUnit(rail, config.slots.recap);
}

// Between matches: show an interstitial (if enabled and Google has one ready),
// then call `next` — exactly once, even if the ad never loads.
export function adBreakThen(next) {
  if (!config || !config.gameBreaks || scriptState === 'failed' || scriptState === 'none') { next(); return; }
  let done = false;
  let wasMuted = null;
  const finish = () => {
    if (done) return;
    done = true;
    if (wasMuted !== null) setMuted(wasMuted);
    next();
  };
  const timer = setTimeout(finish, BREAK_TIMEOUT_MS);
  try {
    window.adBreak({
      type: 'next',
      name: 'between-matches',
      beforeAd: () => { wasMuted = isMuted(); setMuted(true); },
      afterAd: () => { if (wasMuted !== null) setMuted(wasMuted); wasMuted = null; },
      adBreakDone: () => { clearTimeout(timer); finish(); },
    });
  } catch (_) {
    clearTimeout(timer);
    finish();
  }
}
