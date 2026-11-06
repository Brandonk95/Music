// Sample-accurate metronome engine: a Worker clock wakes a lookahead scheduler
// that queues clicks on the AudioContext timeline (immune to UI jank and
// background-tab timer throttling).
import { getCtx, unlock } from './audio.js';
import { getSoundSet } from './sounds.js';

export const SUBDIVISIONS = [
  { id: '1', label: '♩', name: 'Quarter', pattern: [0] },
  { id: '2', label: '♫', name: 'Eighths', pattern: [0, 1 / 2] },
  { id: '3', label: '♪³', name: 'Triplets', pattern: [0, 1 / 3, 2 / 3] },
  { id: '4', label: '♬♬', name: 'Sixteenths', pattern: [0, 0.25, 0.5, 0.75] },
  { id: '5', label: '⁵', name: 'Quintuplets', pattern: [0, 0.2, 0.4, 0.6, 0.8] },
  { id: '6', label: '⁶', name: 'Sextuplets', pattern: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6] },
  { id: 'swing', label: '♩♪', name: 'Swing', pattern: [0, 2 / 3] },
  { id: 'shuffle', label: '♩ ♪', name: 'Triplet skip', pattern: [0, 1 / 3] },
  { id: 'dotted', label: '♪. ♬', name: 'Dotted 8th + 16th', pattern: [0, 0.75] },
  { id: 'gallop', label: '♪♬', name: '8th + two 16ths', pattern: [0, 0.5, 0.75] },
  { id: 'revgallop', label: '♬♪', name: 'Two 16ths + 8th', pattern: [0, 0.25, 0.5] },
  { id: 'syncop', label: '♬♪♬', name: '16th · 8th · 16th', pattern: [0, 0.25, 0.75] },
  { id: 'offbeat', label: '𝄾♪', name: 'Off-beats only', pattern: [0, 0.5], silentMain: true },
];

export const ACCENT = { MUTE: 0, SOFT: 1, NORMAL: 2, STRONG: 3 };

const LOOKAHEAD = 0.12; // seconds of audio scheduled ahead

// ---------- group metronome timeline ----------
// A party state describes a beat grid on the shared server clock:
//   t0 (ms, a downbeat), bpm, beats  -- current grid, valid from t0 on
//   prev {t0,bpm,beats}               -- previous grid, valid until t0 (pending tempo change)
//   mute {on, at}                     -- pause switches to `on` at server time `at`
// Every device derives identical beat times from it, so changes never need a resync.

export function isMutedAt(s, ts) {
  const m = s.mute;
  if (!m) return false;
  return ts >= m.at ? !!m.on : !m.on;
}

function segments(s) {
  const cur = { t0: s.t0, bpm: s.bpm, beats: s.beats, lo: s.t0, hi: Infinity };
  if (!s.prev) return [cur];
  return [{ ...s.prev, lo: s.prev.t0, hi: s.t0 }, cur];
}

/** All clicks with server time in [A, B), sorted. pattern = subdivision offsets. */
export function groupEvents(s, A, B, pattern = [0]) {
  const out = [];
  for (const seg of segments(s)) {
    const a = Math.max(A, seg.lo), b = Math.min(B, seg.hi);
    if (!(b > a)) continue;
    const P = 60000 / seg.bpm;
    for (let k = Math.max(0, Math.floor((a - seg.t0) / P) - 1); seg.t0 + k * P < b; k++) {
      pattern.forEach((o, sub) => {
        const ts = seg.t0 + (k + o) * P;
        if (ts >= a && ts < b) out.push({ ts, k, sub, beat: k % seg.beats, bar: Math.floor(k / seg.beats), P });
      });
    }
  }
  return out.sort((x, y) => x.ts - y.ts);
}

/** Server time of the first main beat at or after t. */
export function nextBeatAt(s, t) {
  const ev = groupEvents(s, t, t + 2 * 60000 / 20, [0]);
  return ev.length ? ev[0].ts : t;
}

/** Server time of the first downbeat at or after t (where a tempo change can start). */
export function nextDownbeatAt(s, t) {
  const ev = groupEvents(s, t, t + 17 * 60000 / 20, [0]).find((e) => e.beat === 0);
  return ev ? ev.ts : t;
}

const workerSrc = `let id=null;onmessage=e=>{clearInterval(id);if(e.data==='start')id=setInterval(()=>postMessage(0),20)}`;

export class Metronome extends EventTarget {
  constructor() {
    super();
    this.bpm = 120;
    this.beats = 4;
    this.noteValue = 4;
    this.accents = [3, 2, 2, 2];
    this.subdivision = '1';
    this.sound = 'click';
    this.volume = 0.9;
    this.subVolume = 0.55;
    this.trainer = { enabled: false, target: 160, step: 5, everyBars: 4 };
    this.gap = { enabled: false, play: 2, mute: 2 };
    this.randomMute = 0; // percent of beats silenced
    this.countIn = 0; // number of count-in clicks before the music starts
    this.drillCounts = 0; // stop after this many counts (marching drill sets); 0 = off

    this.playing = false;
    this.events = []; // visual events waiting to be shown
    this.worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
    this.worker.onmessage = () => (this.group ? this._scheduleGroup() : this._schedule());
    this.group = null; // set while in a group metronome
    this.sources = new Set();
  }

  // ---- state for presets ----
  getState() {
    return {
      bpm: this.bpm, beats: this.beats, noteValue: this.noteValue, accents: [...this.accents],
      subdivision: this.subdivision, sound: this.sound, volume: this.volume, subVolume: this.subVolume,
      trainer: { ...this.trainer }, gap: { ...this.gap }, randomMute: this.randomMute, countIn: this.countIn,
      drillCounts: this.drillCounts,
    };
  }

  setState(s) {
    if (!s) return;
    const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
    this.bpm = num(s.bpm, 20, 400, 120);
    this.setBeats(num(s.beats, 1, 16, 4), Array.isArray(s.accents) ? s.accents : null);
    this.noteValue = [2, 4, 8, 16].includes(+s.noteValue) ? +s.noteValue : 4;
    if (SUBDIVISIONS.some((x) => x.id === s.subdivision)) this.subdivision = s.subdivision;
    if (s.sound) this.setSound(s.sound);
    this.volume = num(s.volume, 0, 1, 0.9);
    this.subVolume = num(s.subVolume, 0, 1, 0.55);
    this.trainer = { ...this.trainer, ...(s.trainer || {}) };
    this.gap = { ...this.gap, ...(s.gap || {}) };
    this.randomMute = num(s.randomMute, 0, 100, 0);
    this.countIn = s.countIn === true ? this.beats : num(s.countIn, 0, 32, 0); // older presets stored a boolean
    this.drillCounts = num(s.drillCounts, 0, 999, 0);
    this._emit('change');
  }

  setBpm(bpm) {
    this.bpm = Math.round(Math.min(400, Math.max(20, bpm)) * 10) / 10;
    this._emit('change');
  }

  setBeats(n, accents) {
    this.beats = n;
    const old = accents || this.accents;
    this.accents = Array.from({ length: n }, (_, i) => (old[i] != null ? old[i] : i === 0 ? 3 : 2));
    if (this.beatIndex >= n) this.beatIndex = 0;
    this._emit('change');
  }

  cycleAccent(i) {
    const order = [3, 2, 1, 0];
    this.accents[i] = order[(order.indexOf(this.accents[i]) + 1) % order.length];
    this._emit('change');
  }

  setSound(id) {
    this.sound = id;
    this.soundSet = null;
    this._loadSound();
    this._emit('change');
  }

  async _loadSound() {
    const ctx = getCtx();
    const id = this.sound;
    const set = await getSoundSet(id, ctx.sampleRate);
    if (this.sound === id) this.soundSet = set;
    return set;
  }

  /** Plays a single click now (preview when choosing a sound). */
  async preview(id = this.sound) {
    const ctx = await unlock();
    const set = await getSoundSet(id, ctx.sampleRate);
    this._play(set.accent, ctx.currentTime + 0.01, this.volume);
  }

  // ---- transport ----
  async start() {
    if (this.playing || this.group) return;
    const ctx = await unlock();
    if (!this.soundSet) await this._loadSound();
    this.playing = true;
    this.beatIndex = 0;
    this.subIndex = 0;
    this.bar = 0;
    this.countInBeats = this.countIn;
    this.count = 0; // counts played (after count-in)
    this.endTime = null;
    this.beatStart = ctx.currentTime + 0.08;
    this.startedAt = this.beatStart;
    this.events = [];
    this.worker.postMessage('start');
    this._schedule();
    this._emit('state');
  }

  stop() {
    if (!this.playing || this.group) return;
    this.playing = false;
    this.worker.postMessage('stop');
    this._silence();
    this._emit('state');
  }

  _silence() {
    const now = getCtx().currentTime;
    this.sources.forEach((s) => { try { s.stop(now); } catch { /* done */ } });
    this.sources.clear();
    this.events = [];
  }

  // ---- group mode ----
  /**
   * g = { clock (SyncClock), state (party state), delta (s, acoustic correction),
   *       audible (bool), isHost, controls }
   */
  enterGroup(g) {
    this.stop();
    this.group = g;
    this.groupUntil = null;
    this.events = [];
    if (!this.soundSet) this._loadSound();
    this.worker.postMessage('start');
  }

  exitGroup() {
    if (!this.group) return;
    this.worker.postMessage('stop');
    this._silence();
    this.group = null;
    if (this.playing) { this.playing = false; this._emit('state'); }
  }

  _scheduleGroup() {
    const g = this.group;
    g.clock.updateCtx();
    const s = g.state;
    if (!g.clock.ready || !s || s.status !== 'playing') {
      if (this.playing) { this._silence(); this.playing = false; this._emit('state'); }
      this.groupUntil = null;
      return;
    }
    if (!this.playing) { this.playing = true; this._emit('state'); }
    if (!this.soundSet) return;
    // Beats play at their server time + delta, so look for the beats whose
    // shifted time falls in the next LOOKAHEAD. Without this shift, a phone
    // whose own audio is much slower than the host's (delta < -LOOKAHEAD,
    // common on Android) scheduled every click in the past and stayed silent.
    const now = g.clock.serverNow() - (g.delta || 0) * 1000;
    const A = Math.max(this.groupUntil ?? now, now);
    const B = now + LOOKAHEAD * 1000;
    if (B <= A) return;
    for (const ev of groupEvents(s, A, B, this.pattern.pattern)) this._groupEvent(ev, s);
    this.groupUntil = B;
  }

  _groupEvent(ev, s) {
    const g = this.group;
    const ctx = getCtx();
    const t = g.clock.toCtx(ev.ts) + (g.delta || 0);
    if (t < ctx.currentTime + 0.003) return; // too late to play accurately
    const isMain = ev.sub === 0;
    const level = this.accents[ev.beat] ?? (ev.beat === 0 ? 3 : 2);
    const paused = isMutedAt(s, ev.ts);
    const silent = level === 0 || paused || !g.audible || (isMain && !!this.pattern.silentMain);
    if (!silent && !g.flashOnly) {
      if (isMain) this._play(level === 3 ? this.soundSet.accent : this.soundSet.normal, t, (level === 3 ? 1 : level === 2 ? 0.72 : 0.32) * this.volume);
      else {
        const gain = this.subVolume * this.volume * (level === 1 ? 0.6 : 1);
        if (gain > 0) this._play(this.soundSet.sub, t, gain);
      }
    }
    this.events.push({
      time: t, ts: ev.ts, beat: ev.beat, sub: ev.sub, main: isMain, level, silent,
      counting: false, bar: ev.bar, count: 0, countIn: 0, paused, unsynced: !g.audible, forceFlash: !!g.flashOnly,
    });
    // Nobody drains these while the screen is off; don't let a long rehearsal pile them up.
    if (this.events.length > 512) this.events.splice(0, this.events.length - 256);
  }

  toggle() { return this.playing ? this.stop() : this.start(); }

  get pattern() { return SUBDIVISIONS.find((s) => s.id === this.subdivision) || SUBDIVISIONS[0]; }

  _schedule() {
    if (!this.playing) return;
    const ctx = getCtx();
    if (this.endTime != null) {
      if (ctx.currentTime >= this.endTime) { this.stop(); this._emit('finished'); }
      return;
    }
    const horizon = ctx.currentTime + LOOKAHEAD;
    let guard = 0;
    while (guard++ < 64) {
      const sub = this.pattern;
      // A pattern change can leave subIndex out of range; clamp.
      if (this.subIndex >= sub.pattern.length) this._nextBeat(sub);
      const beatDur = 60 / this.bpm;
      const t = this.beatStart + sub.pattern[this.subIndex] * beatDur;
      if (t >= horizon) break;
      if (this.subIndex === 0 && this.countInBeats === 0 && this.drillCounts && this.count >= this.drillCounts) {
        this.endTime = t; // drill set finished: let the last count ring, then stop
        break;
      }
      this._event(t, sub);
      this.subIndex++;
      if (this.subIndex >= sub.pattern.length) this._nextBeat(sub);
    }
  }

  _nextBeat() {
    this.subIndex = 0;
    this.beatStart += 60 / this.bpm;
    if (this.countInBeats > 0) {
      this.countInBeats--;
      if (this.countInBeats === 0) this.beatIndex = 0;
      return;
    }
    this.beatIndex++;
    if (this.beatIndex >= this.beats) {
      this.beatIndex = 0;
      this.bar++;
      this._onBar();
    }
  }

  _onBar() {
    const tr = this.trainer;
    if (tr.enabled && tr.everyBars > 0 && this.bar % tr.everyBars === 0) {
      const dir = Math.sign(tr.target - this.bpm);
      if (dir !== 0) {
        const next = this.bpm + dir * Math.abs(tr.step || 1);
        this.bpm = dir > 0 ? Math.min(tr.target, next) : Math.max(tr.target, next);
        this._emit('change');
      }
    }
  }

  _event(t, sub) {
    const counting = this.countInBeats > 0;
    const countInPos = this.countIn - this.countInBeats;
    const beat = counting ? countInPos % this.beats : this.beatIndex;
    const isMain = this.subIndex === 0;
    const level = counting ? (beat === 0 ? 3 : 2) : this.accents[beat] ?? 2;
    if (isMain && !counting) this.count++;

    if (isMain) {
      this.beatSilenced = !counting && this.randomMute > 0 && Math.random() * 100 < this.randomMute;
    }
    const g = this.gap;
    const gapMuted = !counting && g.enabled && g.play > 0 && this.bar % (g.play + g.mute) >= g.play;
    // Always a real true/false: `undefined` here made the beat display flip its grey "silent" look on and off.
    const silent = !!(level === 0 || gapMuted || this.beatSilenced || (isMain && sub.silentMain && !counting));

    if (!silent && this.soundSet) {
      if (counting && !isMain) { /* count-in clicks beats only */ } else if (isMain) {
        const gain = (level === 3 ? 1 : level === 2 ? 0.72 : 0.32) * this.volume;
        this._play(level === 3 ? this.soundSet.accent : this.soundSet.normal, t, gain);
      } else {
        const gain = this.subVolume * this.volume * (level === 1 ? 0.6 : 1);
        if (gain > 0) this._play(this.soundSet.sub, t, gain);
      }
    }
    this.events.push({
      time: t, beat, sub: this.subIndex, main: isMain, level, silent, counting, bar: this.bar,
      count: this.count, countIn: counting ? countInPos + 1 : 0,
    });
  }

  _play(buffer, time, gain) {
    const ctx = getCtx();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(ctx.destination);
    src.start(time);
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** Returns visual events whose (heard) time has passed. */
  takeDueEvents(offsetSec = 0) {
    const ctx = getCtx();
    const latency = (ctx.outputLatency || ctx.baseLatency || 0) + offsetSec;
    const now = ctx.currentTime - latency;
    const due = [];
    while (this.events.length && this.events[0].time <= now) due.push(this.events.shift());
    return due;
  }

  _emit(type) { this.dispatchEvent(new Event(type)); }
}

const TEMPO_NAMES = [
  [24, 'Larghissimo'], [40, 'Grave'], [55, 'Largo'], [66, 'Larghetto'], [76, 'Adagio'],
  [92, 'Andante'], [108, 'Moderato'], [120, 'Allegretto'], [156, 'Allegro'], [176, 'Vivace'],
  [200, 'Presto'], [Infinity, 'Prestissimo'],
];
export const tempoName = (bpm) => TEMPO_NAMES.find(([max]) => bpm < max)[1];
