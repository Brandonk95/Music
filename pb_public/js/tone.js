// Reference tone generator (pitch pipe / drone) for the tuner.
import { getCtx } from './audio.js';
import { settings } from './settings.js';

let current = null; // { stop, freq }

function voice(freq, timbre, duration) {
  const ctx = getCtx();
  const t = ctx.currentTime;
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const level = settings.toneVolume * 0.5;
  const oscs = [];
  let input = out;

  if (timbre === 'pluck') {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(Math.min(freq * 8, 12000), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.5, 200), t + (duration || 3));
    lp.connect(out);
    input = lp;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = freq;
    const g2 = ctx.createGain(); g2.gain.value = 0.6;
    o.connect(input); o2.connect(g2).connect(input);
    oscs.push(o, o2);
  } else if (timbre === 'soft') {
    [[1, 1], [2, 0.45], [3, 0.2], [4, 0.1]].forEach(([mult, amp]) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq * mult;
      const g = ctx.createGain(); g.gain.value = amp * 0.6;
      o.connect(g).connect(input);
      oscs.push(o);
    });
  } else {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    o.connect(input);
    oscs.push(o);
  }

  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(level, t + 0.015);
  if (duration) {
    out.gain.exponentialRampToValueAtTime(0.0008, t + duration);
    oscs.forEach((o) => o.stop(t + duration + 0.05));
  }
  oscs.forEach((o) => o.start(t));

  return {
    freq,
    stop() {
      const n = ctx.currentTime;
      out.gain.cancelScheduledValues(n);
      out.gain.setValueAtTime(out.gain.value, n);
      out.gain.linearRampToValueAtTime(0, n + 0.08);
      oscs.forEach((o) => { try { o.stop(n + 0.1); } catch { /* already stopped */ } });
    },
  };
}

export const tone = {
  /** One-shot note, e.g. when tapping a string. */
  pluck(freq) {
    this.stop();
    current = voice(freq, settings.toneTimbre, settings.toneTimbre === 'pluck' ? 2.5 : 1.6);
    const mine = current;
    setTimeout(() => { if (current === mine) current = null; }, 2600);
  },
  /** Sustained drone until stopped (optionally with a pure perfect 5th above). */
  drone(freq) {
    this.stop();
    const timbre = settings.toneTimbre === 'pluck' ? 'soft' : settings.toneTimbre;
    const voices = [voice(freq, timbre, 0)];
    if (settings.droneFifth) voices.push(voice(freq * 1.5, timbre, 0));
    current = { freq, drone: true, stop: () => voices.forEach((v) => v.stop()) };
  },
  stop() { current?.stop(); current = null; },
  get droneFreq() { return current?.drone ? current.freq : null; },
};
