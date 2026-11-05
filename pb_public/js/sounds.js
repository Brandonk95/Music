// Metronome click sounds, synthesized once into AudioBuffers (no sample files).
// Each sound has three variants: accent (beat 1), normal beat, and subdivision.

export const SOUNDS = [
  { id: 'click', name: 'Click' },
  { id: 'wood', name: 'Woodblock' },
  { id: 'beep', name: 'Beep' },
  { id: 'rim', name: 'Rimshot' },
  { id: 'cowbell', name: 'Cowbell' },
  { id: 'hihat', name: 'Hi-hat' },
  { id: 'drums', name: 'Drum kit' },
  { id: 'clave', name: 'Clave' },
];

const KINDS = ['accent', 'normal', 'sub'];

function noise(ctx) {
  const len = Math.floor(ctx.sampleRate * 0.5);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = b;
  return src;
}

function env(ctx, peak, decay, t = 0) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
  g.connect(ctx.destination);
  return g;
}

function osc(ctx, type, freq, dest, dur = 0.4) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.connect(dest);
  o.start(0);
  o.stop(dur);
  return o;
}

const pick = (kind, a, n, s) => (kind === 'accent' ? a : kind === 'normal' ? n : s);

const SYNTH = {
  click(ctx, kind) {
    const f = pick(kind, 2400, 1700, 1250);
    const g = env(ctx, 0.9, 0.025);
    osc(ctx, 'square', f, g);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
    const n = noise(ctx); n.connect(hp).connect(env(ctx, 0.35, 0.01)); n.start(0);
  },
  wood(ctx, kind) {
    const f = pick(kind, 1500, 1050, 800);
    const g = env(ctx, 1, 0.08);
    const o = osc(ctx, 'sine', f, g);
    o.frequency.setValueAtTime(f * 1.25, 0);
    o.frequency.exponentialRampToValueAtTime(f, 0.012);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 4;
    const n = noise(ctx); n.connect(bp).connect(env(ctx, 0.6, 0.015)); n.start(0);
  },
  beep(ctx, kind) {
    const f = pick(kind, 1760, 880, 660);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.7, 0.002);
    g.gain.setValueAtTime(0.7, 0.05);
    g.gain.exponentialRampToValueAtTime(0.0005, 0.09);
    g.connect(ctx.destination);
    osc(ctx, 'sine', f, g);
  },
  rim(ctx, kind) {
    const f = pick(kind, 1900, 1600, 1350);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 2.5;
    bp.connect(env(ctx, 2.2, 0.05));
    const n = noise(ctx); n.connect(bp); n.start(0);
    osc(ctx, 'triangle', f * 0.5, env(ctx, 0.5, 0.03));
  },
  cowbell(ctx, kind) {
    const scale = pick(kind, 1.12, 1, 0.92);
    const decay = pick(kind, 0.3, 0.18, 0.08);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2640 * scale; bp.Q.value = 1;
    bp.connect(env(ctx, 1.3, decay));
    osc(ctx, 'square', 540 * scale, bp);
    osc(ctx, 'square', 800 * scale, bp);
  },
  hihat(ctx, kind) {
    const decay = pick(kind, 0.22, 0.06, 0.035);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = pick(kind, 6500, 7000, 8000);
    hp.connect(env(ctx, pick(kind, 0.9, 0.8, 0.6), decay));
    const n = noise(ctx); n.connect(hp); n.start(0);
  },
  drums(ctx, kind) {
    if (kind === 'accent') { // kick
      const g = env(ctx, 1, 0.35);
      const o = osc(ctx, 'sine', 150, g);
      o.frequency.setValueAtTime(160, 0);
      o.frequency.exponentialRampToValueAtTime(45, 0.12);
      const n = noise(ctx); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500;
      n.connect(lp).connect(env(ctx, 0.3, 0.01)); n.start(0);
    } else if (kind === 'normal') { // snare
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
      hp.connect(env(ctx, 0.8, 0.16));
      const n = noise(ctx); n.connect(hp); n.start(0);
      osc(ctx, 'triangle', 190, env(ctx, 0.7, 0.08));
    } else SYNTH.hihat(ctx, 'sub');
  },
  clave(ctx, kind) {
    const f = pick(kind, 2700, 2500, 2100);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 12;
    bp.connect(env(ctx, 3, 0.06));
    osc(ctx, 'sine', f, bp);
    const n = noise(ctx); n.connect(bp); n.start(0);
  },
};

const cache = new Map();

/** Returns { accent, normal, sub } AudioBuffers for a sound at the given sample rate. */
export async function getSoundSet(id, sampleRate) {
  const key = `${id}@${sampleRate}`;
  if (cache.has(key)) return cache.get(key);
  const synth = SYNTH[id] || SYNTH.click;
  const entries = await Promise.all(KINDS.map(async (kind) => {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(1, Math.floor(sampleRate * 0.4), sampleRate);
    synth(ctx, kind);
    return [kind, await ctx.startRendering()];
  }));
  const set = Object.fromEntries(entries);
  cache.set(key, set);
  return set;
}
