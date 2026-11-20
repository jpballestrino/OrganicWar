// Client-side cost of keeping the map on screen, in headless Chromium: plays a
// Quick Battle as an idle guest (the bots fight around it) and, over a fixed
// window of the match, reports
//   * frames per second,
//   * MB/s uploaded to the GPU for the cell texture and ms of main thread per
//     frame spent uploading (renderer.stats),
//   * ms to apply each sim-delta (decode + fortification zones; state.avgApplyMs).
// Runs RUNS matches and prints each plus the median. VIEW=800x450 shrinks the
// window (software rendering is fill-rate bound; a small window shows the
// upload's share of each frame better).
//
//   npm run build && npm start      # then:
//   node scripts/bench-render.mjs    # env: URL, RUNS (2), FROM (10 s), SECONDS (30 s)
//
// Headless Chromium draws with SwiftShader (software GL), so the upload is
// costlier than on a real GPU — the same for the before and the after.
// Needs Playwright (not a project dependency).

import { createRequire } from 'module';

const { chromium } = createRequire(import.meta.url)('playwright');
const URL = process.env.URL || 'http://localhost:3000';
const RUNS = Number(process.env.RUNS || 2);
const FROM = Number(process.env.FROM || 10);
const SECONDS = Number(process.env.SECONDS || 30);
const [VW, VH] = (process.env.VIEW || '1600x900').split('x').map(Number);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
for (let run = 1; run <= RUNS; run++) {
  const page = await browser.newPage({ viewport: { width: VW, height: VH } });
  await page.goto(`${URL}/?debug`, { waitUntil: 'load' });
  await page.locator('#linkGuest:visible').first().click().catch(() => {});
  await page.locator('#btn-quick-play-guest:visible').first().click();
  await page.waitForFunction(() => document.getElementById('gameHUD')?.style.display === 'flex', null, { timeout: 90000 });
  await page.waitForTimeout(FROM * 1000);
  const sample = () => page.evaluate(() => {
    const s = window.renderer.stats;
    return { t: performance.now(), frames: s.frames, bytes: s.uploadedBytes, uploadMs: s.uploadMs, uploads: s.uploads, apply: window.__owState.avgApplyMs || 0 };
  });
  const a = await sample();
  const applies = [];
  for (let i = 0; i < SECONDS; i++) {
    await page.waitForTimeout(1000);
    applies.push(await page.evaluate(() => window.__owState.avgApplyMs || 0));
  }
  const b = await sample();
  const secs = (b.t - a.t) / 1000;
  const frames = b.frames - a.frames;
  const r = {
    fps: frames / secs,
    uploadMBps: (b.bytes - a.bytes) / 1048576 / secs,
    uploadMsPerFrame: (b.uploadMs - a.uploadMs) / Math.max(1, frames),
    uploadsPerSec: (b.uploads - a.uploads) / secs,
    applyMs: applies.reduce((x, y) => x + y, 0) / applies.length,
  };
  results.push(r);
  console.log(`run ${run}: ${r.fps.toFixed(1)} fps, GPU upload ${r.uploadMBps.toFixed(1)} MB/s (${r.uploadsPerSec.toFixed(1)} uploads/s, ` +
    `${r.uploadMsPerFrame.toFixed(2)} ms per frame), sim-delta apply ${r.applyMs.toFixed(2)} ms`);
  await page.close();
}
const med = (k) => { const v = results.map((r) => r[k]).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
console.log(`median: ${med('fps').toFixed(1)} fps, GPU upload ${med('uploadMBps').toFixed(1)} MB/s, ` +
  `${med('uploadMsPerFrame').toFixed(2)} ms/frame uploading, sim-delta apply ${med('applyMs').toFixed(2)} ms`);
await browser.close();
