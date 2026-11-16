// Tiny synthesized sound engine (Web Audio, no asset files). Every sound is a
// short envelope over an oscillator or a filtered noise burst, so the whole
// soundscape costs zero network bytes and can't 404.
//
// Browsers block audio until a user gesture, so the context is created lazily on
// the first pointer/key event. Mute is persisted in localStorage.

const MUTE_KEY = 'ow_sfx_muted';

let ctx = null;
let master = null;
let noiseBuffer = null;
let muted = false;
const lastPlayed = {};

try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (_) { /* storage blocked */ }

function ensureContext() {
  if (ctx) {
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    return true;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // One second of white noise, reused by every noise burst.
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) { data[i] = Math.random() * 2 - 1; }
    return true;
  } catch (_) {
    ctx = null;
    return false;
  }
}

export function initSfx() {
  const unlock = () => { ensureContext(); };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
}

export function isMuted() { return muted; }

export function setMuted(value) {
  muted = !!value;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (_) { /* storage blocked */ }
}

// One enveloped oscillator: pitch glides f0 → f1 over `dur` seconds.
function tone({ type = 'sine', f0, f1 = f0, dur = 0.15, gain = 0.2, delay = 0 }) {
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) { osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur); }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

// A noise burst through a sweeping low-pass filter (whooshes, explosions).
function noise({ dur = 0.3, gain = 0.25, f0 = 2000, f1 = 200, delay = 0 }) {
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(f0, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.03);
}

// Play a rising/falling run of notes.
function arp(freqs, { type = 'triangle', step = 0.09, dur = 0.16, gain = 0.18 } = {}) {
  freqs.forEach((f, i) => tone({ type, f0: f, dur, gain, delay: i * step }));
}

// name → [minimum ms between plays, recipe]
const SOUNDS = {
  order:    [60,   () => tone({ type: 'triangle', f0: 520, f1: 820, dur: 0.07, gain: 0.12 })],
  cancel:   [120,  () => tone({ type: 'triangle', f0: 420, f1: 240, dur: 0.12, gain: 0.12 })],
  error:    [250,  () => tone({ type: 'square', f0: 170, f1: 130, dur: 0.16, gain: 0.08 })],
  select:   [60,   () => tone({ type: 'sine', f0: 700, dur: 0.05, gain: 0.1 })],
  build:    [150,  () => { tone({ type: 'square', f0: 150, f1: 90, dur: 0.1, gain: 0.1 });
                           tone({ type: 'square', f0: 190, f1: 110, dur: 0.1, gain: 0.1, delay: 0.11 }); }],
  complete: [200,  () => arp([660, 880, 1320], { step: 0.07, dur: 0.14, gain: 0.14 })],
  launch:   [150,  () => { noise({ dur: 0.55, gain: 0.16, f0: 400, f1: 3200 });
                           tone({ type: 'sawtooth', f0: 180, f1: 900, dur: 0.5, gain: 0.06 }); }],
  boom:     [90,   () => { noise({ dur: 0.75, gain: 0.4, f0: 1400, f1: 60 });
                           tone({ type: 'sine', f0: 130, f1: 32, dur: 0.6, gain: 0.4 }); }],
  boomFar:  [150,  () => noise({ dur: 0.5, gain: 0.1, f0: 500, f1: 60 })],
  intercept:[150,  () => { noise({ dur: 0.25, gain: 0.2, f0: 3000, f1: 400 });
                           tone({ type: 'square', f0: 1400, f1: 500, dur: 0.15, gain: 0.06 }); }],
  fallen:   [300,  () => tone({ type: 'sawtooth', f0: 300, f1: 110, dur: 0.35, gain: 0.08 })],
  kill:     [300,  () => arp([523, 659, 784, 1047], { step: 0.08, dur: 0.2, gain: 0.2 })],
  rankUp:   [800,  () => arp([784, 1175], { step: 0.1, dur: 0.22, gain: 0.16 })],
  milestone:[500,  () => arp([880, 1109, 1319], { type: 'sine', step: 0.06, dur: 0.18, gain: 0.14 })],
  alarm:    [1500, () => { for (let i = 0; i < 3; i++) {
                             tone({ type: 'square', f0: 880, f1: 660, dur: 0.14, gain: 0.1, delay: i * 0.2 }); } }],
  tick:     [300,  () => tone({ type: 'sine', f0: 880, dur: 0.08, gain: 0.14 })],
  go:       [500,  () => { tone({ type: 'sine', f0: 1320, dur: 0.4, gain: 0.18 });
                           tone({ type: 'triangle', f0: 660, dur: 0.4, gain: 0.12 }); }],
  victory:  [2000, () => { arp([523, 659, 784, 1047, 784, 1047, 1319], { step: 0.13, dur: 0.3, gain: 0.2 });
                           tone({ type: 'sine', f0: 262, dur: 1.4, gain: 0.14 }); }],
  defeat:   [2000, () => arp([392, 330, 262, 196], { type: 'sawtooth', step: 0.2, dur: 0.4, gain: 0.1 })],
  levelUp:  [1000, () => arp([523, 659, 784, 1047, 1319, 1568], { step: 0.07, dur: 0.22, gain: 0.18 })],
  xp:       [40,   () => tone({ type: 'sine', f0: 1200, f1: 1500, dur: 0.05, gain: 0.06 })],
};

export function playSfx(name) {
  if (muted) return;
  const entry = SOUNDS[name];
  if (!entry) return;
  const now = performance.now();
  if (lastPlayed[name] && now - lastPlayed[name] < entry[0]) return;
  if (!ensureContext() || ctx.state !== 'running') return;
  lastPlayed[name] = now;
  try { entry[1](); } catch (_) { /* never let audio break gameplay */ }
}
