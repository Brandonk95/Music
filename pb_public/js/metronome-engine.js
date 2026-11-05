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
    this.worker.onmessage = () => this._schedule();
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
    if (this.playing) return;
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
    if (!this.playing) return;
    this.playing = false;
    this.worker.postMessage('stop');
    const now = getCtx().currentTime;
    this.sources.forEach((s) => { try { s.stop(now); } catch { /* done */ } });
    this.sources.clear();
    this.events = [];
    this._emit('state');
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
    const silent = level === 0 || gapMuted || this.beatSilenced || (isMain && sub.silentMain && !counting);

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
