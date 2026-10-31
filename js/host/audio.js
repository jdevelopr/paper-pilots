// audio.js: tiny synthesized sound effects for the host screen. No audio files.
// The AudioContext is created on the first user gesture (the host clicking a button).

let ctx = null, master = null, noiseBuf = null;

export function initAudio() {
  if (ctx) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch { ctx = null; }
}

function tone(freq, dur, { type = 'triangle', vol = 0.5, slide = 0, delay = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}

function noise(dur, { freq = 1200, q = 0.8, vol = 0.4, sweep = 1, delay = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.2);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t); src.stop(t + dur + 0.05);
}

export const sfx = {
  tick: () => tone(660, 0.12, { type: 'square', vol: 0.18 }),
  go: () => { tone(880, 0.25, { type: 'square', vol: 0.2 }); tone(1320, 0.3, { type: 'triangle', vol: 0.2, delay: 0.05 }); },
  ding: () => { tone(1568, 0.18, { vol: 0.2 }); tone(2093, 0.22, { vol: 0.14, delay: 0.05 }); },
  throw: boost => noise(boost ? 0.55 : 0.4, { freq: 500, sweep: 4, vol: boost ? 0.5 : 0.35 }),
  thud: () => { noise(0.18, { freq: 300, q: 0.6, vol: 0.6, sweep: 0.5 }); tone(110, 0.15, { type: 'sine', vol: 0.4, slide: 0.5 }); },
  crumple: () => { for (let i = 0; i < 6; i++) noise(0.08, { freq: 2500 + Math.random() * 2000, q: 2, vol: 0.3, delay: i * 0.05 }); },
  land: () => noise(0.35, { freq: 1800, sweep: 0.3, vol: 0.25 }),
  zone: tier => [0, 1, 2].forEach(i => tone(523 * Math.pow(1.26, i + tier * 0.5), 0.2, { vol: 0.16, delay: i * 0.08 })),
  coin: () => tone(988, 0.08, { type: 'square', vol: 0.1 }),
  buy: () => { tone(784, 0.1, { vol: 0.2 }); tone(1175, 0.16, { vol: 0.2, delay: 0.08 }); },
  fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, { type: 'square', vol: 0.12, delay: i * 0.13 })),
  elevator: () => { tone(1319, 0.6, { type: 'sine', vol: 0.25 }); tone(1047, 0.8, { type: 'sine', vol: 0.25, delay: 0.35 }); },
};
