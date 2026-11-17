// Google ads configuration (server/ads.js): off unless a valid publisher id is
// set, ads.txt and CSP follow the config.
import { describe, it, expect } from 'vitest';
import { adsConfig, adsTxt, cspDirectives, describeAds } from './ads.js';

const BASE = { defaultSrc: ["'self'"], scriptSrc: ["'self'"], connectSrc: ["'self'"], imgSrc: ["'self'"] };

describe('Google ads config', () => {
  it('is off by default: no config, no ads.txt, CSP untouched', () => {
    expect(adsConfig({})).toBeNull();
    expect(adsTxt({})).toBeNull();
    expect(cspDirectives(BASE, {})).toBe(BASE);
    expect(describeAds({})).toMatch(/off/);
  });

  it('refuses a malformed publisher id instead of loading a broken ad tag', () => {
    expect(adsConfig({ ADSENSE_CLIENT: 'pub-1234567890123456' })).toBeNull();
    expect(adsConfig({ ADSENSE_CLIENT: 'ca-pub-12<script>' })).toBeNull();
    expect(describeAds({ ADSENSE_CLIENT: 'pub-1' })).toMatch(/not a ca-pub/);
  });

  it('turns on with a publisher id, keeping only well-formed slot ids', () => {
    const cfg = adsConfig({
      ADSENSE_CLIENT: 'ca-pub-1234567890123456',
      ADSENSE_SLOT_HOME: '1234567890',
      ADSENSE_SLOT_RECAP: 'nope',
      ADSENSE_GAME_BREAKS: '1',
    });
    expect(cfg).toEqual({
      client: 'ca-pub-1234567890123456',
      slots: { home: '1234567890', recap: null },
      gameBreaks: true,
      test: false,
    });
  });

  it('publishes ads.txt with the pub- id and Google\'s certification id', () => {
    expect(adsTxt({ ADSENSE_CLIENT: 'ca-pub-1234567890123456' }))
      .toBe('google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
  });

  it('opens the CSP to Google\'s ad domains only when ads are on', () => {
    const csp = cspDirectives(BASE, { ADSENSE_CLIENT: 'ca-pub-1234567890123456' });
    expect(csp.scriptSrc).toContain('https://pagead2.googlesyndication.com');
    expect(csp.frameSrc).toContain('https://*.doubleclick.net');
    expect(csp.scriptSrc).toContain("'self'");
    expect(BASE.scriptSrc).toEqual(["'self'"]); // the base object is not mutated
  });
});
