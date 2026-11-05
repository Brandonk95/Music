// Acoustic sync: listen through the mic and time click onsets on the
// AudioContext clock.
//
// Two measurements, made with the same detector so their unknowns cancel:
//  - loopback: this phone plays a click at time e and hears it at e + R
//              (R = its own output latency + input latency)
//  - host:     the host's click for beat k is heard at grid(k) + m
// Scheduling our clicks at grid(k) + (m - R) makes them come out of our
// speaker exactly when the host's click reaches the room.
import { getCtx, unlock, setMicActive } from './audio.js';

let stream = null, source = null, node = null, workletLoaded = false;
let chunks = [];

export const micOpen = () => !!stream;

export async function openMic() {
  if (stream) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone needs HTTPS');
  const ctx = await unlock();
  setMicActive(true);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    setMicActive(false);
    throw new Error(e.name === 'NotAllowedError' ? 'Microphone permission denied' : e.message);
  }
  if (!workletLoaded) {
    await ctx.audioWorklet.addModule('js/capture-worklet.js');
    workletLoaded = true;
  }
  chunks = [];
  source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'tt-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  node.port.onmessage = (e) => {
    chunks.push(e.data);
    const keepFrom = e.data.t - 6; // seconds of history
    while (chunks.length && chunks[0].t < keepFrom) chunks.shift();
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(ctx.destination); // keeps the worklet running, silently
}

export function closeMic() {
  try { source?.disconnect(); node?.disconnect(); node?.port.close(); } catch { /* already closed */ }
  stream?.getTracks().forEach((t) => t.stop());
  stream = source = node = null;
  chunks = [];
  setMicActive(false);
}

const audioEnd = () => {
  const c = chunks[chunks.length - 1];
  return c ? c.t + c.data.length / getCtx().sampleRate : 0;
};

export async function waitForAudio(tEnd, timeoutMs = 4000) {
  const start = performance.now();
  while (audioEnd() < tEnd) {
    if (performance.now() - start > timeoutMs) throw new Error('No audio from the microphone');
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** Samples between context times a and b (silence where nothing was captured). */
function windowData(a, b, sr) {
  const n = Math.max(0, Math.round((b - a) * sr));
  const out = new Float32Array(n);
  for (const c of chunks) {
    const off = Math.round((c.t - a) * sr);
    const from = Math.max(0, -off);
    const to = Math.min(c.data.length, n - off);
    if (to > from) out.set(c.data.subarray(from, to), off + from);
  }
  return out;
}

/**
 * Finds the click onset in [a, b] (context seconds). Pure function of the
 * samples so it can be unit-tested: returns { time, snr } or null.
 */
export function findOnset(data, start, sr) {
  const n = data.length;
  if (n < 32) return null;
  // Two-pole high-pass at ~800 Hz: metronome clicks are bright, while voices and
  // most band instruments' fundamentals are lower. Then a short RMS envelope.
  const a = 1 / (1 + 2 * Math.PI * 800 / sr);
  const W = Math.max(4, Math.round(0.00025 * sr));
  const env = new Float32Array(n);
  const sq = new Float32Array(n);
  let x1 = data[0], h1 = 0, p1 = 0, h2 = 0, acc = 0;
  for (let i = 1; i < n; i++) {
    const x = data[i];
    h1 = a * (h1 + x - x1); x1 = x; // stage 1
    h2 = a * (h2 + h1 - p1); p1 = h1; // stage 2
    sq[i] = h2 * h2;
    acc += sq[i] - (i >= W ? sq[i - W] : 0);
    env[i] = Math.sqrt(Math.max(0, acc) / W);
  }
  let peak = 0, peakAt = 0;
  for (let i = 0; i < n; i++) if (env[i] > peak) { peak = env[i]; peakAt = i; }
  // Noise floor from the quiet part of the window (a click's decay tail
  // would inflate a median).
  const sorted = Float32Array.from(env).sort();
  const floor = sorted[Math.floor(n * 0.2)] + 1e-7;
  const snr = peak / floor;
  if (peak < 1e-4 || snr < 6) return null;
  const thr = Math.max(peak * 0.25, floor * 4.5);
  const from = Math.max(0, peakAt - Math.round(0.008 * sr));
  let i = from;
  while (i < peakAt && env[i] < thr) i++;
  return { time: start + i / sr, snr };
}

export function detectOnset(a, b) {
  const sr = getCtx().sampleRate;
  return findOnset(windowData(a, b, sr), a, sr);
}

export const median = (arr) => {
  const s = [...arr].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const spread = (arr) => { const m = median(arr); return median(arr.map((x) => Math.abs(x - m))); };

/**
 * Measures this phone's own speaker->mic delay. playAt(t) must schedule a
 * click at context time t. Mic must be open. Returns seconds, or null.
 */
export async function measureLoopback(playAt) {
  const ctx = getCtx();
  const times = [];
  let t = ctx.currentTime + 0.3;
  for (let i = 0; i < 6; i++) {
    t += 0.35 + Math.random() * 0.15; // irregular, so other phones' clicks don't line up
    times.push(t);
    playAt(t);
  }
  await waitForAudio(times[times.length - 1] + 0.35);
  const d = [];
  for (const e of times) {
    const o = detectOnset(e - 0.02, e + 0.3);
    if (o) d.push(o.time - e);
  }
  if (d.length < 4 || spread(d) > 0.003) return null;
  return median(d);
}
