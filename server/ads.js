// Google AdSense — optional, OFF unless ADSENSE_CLIENT is set.
//
//   ADSENSE_CLIENT       your publisher id, "ca-pub-1234567890123456" (turns ads on)
//   ADSENSE_SLOT_HOME    display ad unit id for the home screen (optional)
//   ADSENSE_SLOT_RECAP   display ad unit id for the end-of-match screen (optional)
//   ADSENSE_GAME_BREAKS  "1" = interstitial between matches via Google's Ad
//                        Placement API (H5 Games Ads — needs Google's approval)
//   ADSENSE_TEST         "1" = Google's test mode (no real impressions/earnings)
//
// Ads are never shown during a match. With ADSENSE_CLIENT unset nothing about
// Google loads and the Content Security Policy stays strict. See DEPLOY.md.

const CLIENT_RE = /^ca-pub-\d{10,20}$/;
const SLOT_RE = /^\d{5,20}$/;

export function adsConfig(env = process.env) {
  const client = String(env.ADSENSE_CLIENT || '').trim();
  if (!CLIENT_RE.test(client)) return null;
  const slot = (v) => (SLOT_RE.test(String(v || '').trim()) ? String(v).trim() : null);
  return {
    client,
    slots: { home: slot(env.ADSENSE_SLOT_HOME), recap: slot(env.ADSENSE_SLOT_RECAP) },
    gameBreaks: env.ADSENSE_GAME_BREAKS === '1',
    test: env.ADSENSE_TEST === '1',
  };
}

// Startup log line: say whether ads are on, and why not if a value is wrong.
export function describeAds(env = process.env) {
  const cfg = adsConfig(env);
  if (cfg) {
    const units = Object.entries(cfg.slots).filter(([, v]) => v).map(([k]) => k);
    return `Google ads ON (${cfg.client}; display units: ${units.join(', ') || 'none'}; ` +
      `between-match breaks: ${cfg.gameBreaks ? 'on' : 'off'}${cfg.test ? '; TEST MODE' : ''})`;
  }
  if (env.ADSENSE_CLIENT) return `Google ads OFF: ADSENSE_CLIENT "${env.ADSENSE_CLIENT}" is not a ca-pub-… publisher id`;
  return 'Google ads off (ADSENSE_CLIENT not set)';
}

// /ads.txt — Google requires it on the domain before serving ads.
// "f08c47fec0942fa0" is Google's fixed certification authority id.
export function adsTxt(env = process.env) {
  const cfg = adsConfig(env);
  if (!cfg) return null;
  return `google.com, ${cfg.client.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`;
}

// Extra Content-Security-Policy sources Google's ad code needs (ad script,
// ad frames, measurement and the Funding Choices consent message). Only added
// when ads are on.
const GOOGLE_AD_SOURCES = [
  'https://pagead2.googlesyndication.com',
  'https://*.googlesyndication.com',
  'https://*.g.doubleclick.net',
  'https://*.doubleclick.net',
  'https://adservice.google.com',
  'https://*.adtrafficquality.google',
  'https://www.google.com',
  'https://fundingchoicesmessages.google.com',
  'https://*.gstatic.com',
];

export function cspDirectives(base, env = process.env) {
  if (!adsConfig(env)) return base;
  const add = (list) => [...(list || []), ...GOOGLE_AD_SOURCES];
  return {
    ...base,
    scriptSrc: add(base.scriptSrc),
    connectSrc: add(base.connectSrc),
    frameSrc: add(base.frameSrc || ["'self'"]),
    imgSrc: add(base.imgSrc),
  };
}
