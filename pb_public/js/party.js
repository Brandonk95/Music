// Group metronome ("party"): a host and members share one beat grid.
//
// - The host's party record holds the grid (see metronome-engine.js) and the
//   sound settings. Members follow it over PocketBase realtime (+ polling).
// - Every device keeps a SyncClock locked to the server, so all of them
//   compute the same beat times.
// - Each member then listens to the host through the mic once (acoustic
//   sync) to cancel the last few ms of network and speaker latency.
// - Tempo/meter changes start on an agreed future downbeat and pause/resume
//   on an agreed beat, so nobody has to re-sync.
import { store } from './store.js';
import { met } from './metronome.js';
import { nextBeatAt, nextDownbeatAt, groupEvents, isMutedAt } from './metronome-engine.js';
import { SyncClock } from './clock.js';
import { getSoundSet } from './sounds.js';
import { getCtx, unlock } from './audio.js';
import { wake } from './wakelock.js';
import * as acoustic from './acoustic.js';
import { sustain } from './tone.js';
import { settings } from './settings.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LEAD_START = 2000; // ms between pressing play and the first beat
const LEAD_CHANGE = 900; // tempo/meter changes start on a downbeat at least this far ahead
const LEAD_MUTE = 300; // pause/resume on a beat at least this far ahead
const LOOPBACK_KEY = 'tt.loopback';
const SOUND_KEYS = ['accents', 'subdivision', 'sound', 'noteValue', 'volume', 'subVolume'];
const FLASH_ONLY_KEY = 'tt.groupFlashOnly';

/** Concert-pitch notes offered for the group tuning drone (pitch class, C = 0). */
export const DRONE_NOTES = [[10, 'B♭'], [5, 'F'], [3, 'E♭'], [8, 'A♭'], [0, 'C'], [7, 'G'], [2, 'D'], [9, 'A']];
export const droneName = (pc) => (DRONE_NOTES.find(([p]) => p === pc) || [pc, '?'])[1];

const CALIB_TIMEOUT = 45000; // ms the sync step may take before the host wraps it up
const ACTIVE_CALIB = ['gather', 'sync'];

/** Short rising chime that says "sync complete". */
export function playChime({ ok = true } = {}) {
  const ctx = getCtx();
  const t0 = ctx.currentTime + 0.05;
  const notes = ok ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 523.25];
  const out = ctx.createGain();
  out.gain.value = 0.5;
  out.connect(ctx.destination);
  notes.forEach((f, i) => {
    const t = t0 + i * 0.12;
    const last = i === notes.length - 1;
    const g = ctx.createGain();
    g.connect(out);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (last ? 1.6 : 0.7));
    for (const [type, mult, level] of [['sine', 1, 1], ['triangle', 2, 0.18], ['sine', 3, 0.06]]) {
      const o = ctx.createOscillator();
      const lg = ctx.createGain();
      o.type = type;
      o.frequency.value = f * mult;
      lg.gain.value = level;
      o.connect(lg).connect(g);
      o.start(t);
      o.stop(t + 1.7);
    }
  });
}

const makeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const memberName = () => store.user?.name || (store.user?.email || 'User').split('@')[0];
const GUEST_NAME_KEY = 'tt.guestName';
const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const makeGuestKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => KEY_CHARS[b % KEY_CHARS.length]).join('');

/** Name last used to join as a guest (no account). */
export const savedGuestName = () => localStorage.getItem(GUEST_NAME_KEY) || '';

class Party extends EventTarget {
  constructor() {
    super();
    this.record = null;
    this.isHost = false;
    this.state = null;
    this.members = [];
    this.member = null;
    this.sync = { status: 'idle' }; // idle | waiting | calibrating | listening | synced | network | failed
    this.timers = [];
    this.syncing = false;
    this._pushTimer = null;
    met.addEventListener('change', () => { if (this.isHost && this.record && !this._applying) this._hostEdited(); });
  }

  get active() { return !!this.record; }
  get code() { return this.record?.code; }

  _emit() { this.dispatchEvent(new Event('change')); }

  // ---------- joining ----------

  async create() {
    if (!store.loggedIn) throw new Error('Sign in to start a group');
    await unlock();
    const clock = new SyncClock();
    await clock.start();
    const m = met.getState();
    const state = {
      v: 1, status: 'idle', t0: 0, prev: null, mute: null,
      bpm: m.bpm, beats: m.beats, ...Object.fromEntries(SOUND_KEYS.map((k) => [k, m[k]])),
    };
    let rec = null;
    for (let i = 0; i < 5 && !rec; i++) {
      try {
        rec = await store.api('/api/collections/parties/records', {
          method: 'POST', body: JSON.stringify({ host: store.user.id, code: makeCode(), state }),
        });
      } catch (e) { if (e.status !== 400 || i === 4) throw e; } // 400 = code taken, try another
    }
    await this._enter(rec, true, clock);
  }

  /** Join with a code. Without an account, `name` is required (guest). */
  async join(rawCode, { name } = {}) {
    const guest = !store.loggedIn;
    const guestName = String(name || '').trim().slice(0, 40);
    if (guest && !guestName) throw new Error('Enter your name to join');
    const code = String(rawCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) throw new Error('Codes are 6 letters/numbers');
    await unlock();
    const r = await store.api(`/api/collections/parties/records?code=${code}&perPage=1&filter=${encodeURIComponent(`code="${code}"`)}`);
    const rec = r.items[0];
    if (!rec || rec.state?.status === 'ended') throw new Error('No active group with that code');
    const clock = new SyncClock();
    await clock.start();
    if (!guest && rec.host === store.user.id) return this._enter(rec, true, clock); // host rejoining
    if (guest) {
      localStorage.setItem(GUEST_NAME_KEY, guestName);
      this.guestKey = makeGuestKey();
      this.member = await store.api('/api/collections/party_members/records', {
        method: 'POST',
        body: JSON.stringify({ party: rec.id, name: guestName, status: 'joined', seen: Date.now(), guestKey: this.guestKey }),
      });
    } else {
      this.guestKey = null;
      this.member = await this._upsertMember(rec);
    }
    await this._enter(rec, false, clock);
    this._afterGuestJoin();
  }

  async _upsertMember(rec) {
    const body = { party: rec.id, user: store.user.id, name: memberName(), status: 'joined', seen: Date.now() };
    try {
      return await store.api('/api/collections/party_members/records', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      if (e.status !== 400) throw e;
      const f = encodeURIComponent(`party="${rec.id}" && user="${store.user.id}"`);
      const list = await store.api(`/api/collections/party_members/records?filter=${f}&perPage=1`);
      return list.items[0];
    }
  }

  async _enter(rec, isHost, clock) {
    this.record = rec;
    this.isHost = isHost;
    this.clock = clock;
    this.state = rec.state;
    this.savedMet = met.getState();
    this.sync = isHost ? { status: 'host' } : { status: 'idle' };
    this.calibReady = false;
    this._calibKey = ACTIVE_CALIB.includes(rec.state.calib?.phase) ? null : calibKey(rec.state.calib);
    if (!isHost || rec.state.status !== 'idle') this._applyToMet(rec.state);
    met.enterGroup({
      clock, state: this.state, delta: 0, audible: isHost, isHost, flashOnly: !isHost && this.flashOnly,
      controls: { play: () => this.primaryAction(), pause: () => this.pause(), stop: () => this.stop() },
    });
    this._subscribe();
    this._onCalib(rec.state.calib);
    this.timers.push(setInterval(() => this._poll(), 4000));
    if (isHost) {
      this._loadMembers();
      let tick = 0;
      this.timers.push(setInterval(() => {
        if (this.calibActive || ++tick % 3 === 0) this._loadMembers();
      }, 1000));
      this._unwatchOutput = this._watchOutput();
    }
    else this.timers.push(setInterval(() => this._heartbeat(), 20000));
    wake.request('group');
    this._emit();
  }

  async leave({ end = false } = {}) {
    if (!this.record) return;
    const rec = this.record;
    this.timers.forEach(clearInterval);
    clearTimeout(this._deferTimer);
    this.timers = [];
    this._unwatchOutput?.();
    this._unwatchOutput = null;
    this.es?.close();
    this.es = null;
    this.clock?.stop();
    acoustic.closeMic();
    met.exitGroup();
    this._applying = true;
    if (this.savedMet) met.setState(this.savedMet);
    this._applying = false;
    wake.release('group');
    this._applyDrone(null);
    this.record = null;
    this.state = null;
    this.members = [];
    try {
      if (this.isHost && end) {
        await store.api(`/api/collections/parties/records/${rec.id}`, { method: 'DELETE' });
      } else if (this.member) {
        await store.api(`/api/collections/party_members/records/${this.member.id}`, { method: 'DELETE', headers: this._memberHeaders() });
      }
    } catch { /* best effort */ }
    this.member = null;
    this.guestKey = null;
    this.isHost = false;
    this._emit();
  }

  // ---------- receiving state ----------

  _subscribe() {
    const id = this.record.id;
    this.es = new EventSource(`${store.base}/api/realtime`);
    this.es.addEventListener('PB_CONNECT', async (e) => {
      try {
        const { clientId } = JSON.parse(e.data);
        await store.api('/api/realtime', { method: 'POST', body: JSON.stringify({ clientId, subscriptions: [`parties/${id}`] }) });
      } catch { /* polling still covers us */ }
    });
    this.es.addEventListener(`parties/${id}`, (e) => {
      const d = JSON.parse(e.data);
      if (d.action === 'delete') this._ended();
      else this._remote(d.record);
    });
  }

  async _poll() {
    if (!this.record) return;
    try {
      this._remote(await store.api(`/api/collections/parties/records/${this.record.id}`));
    } catch (e) { if (e.status === 404) this._ended(); }
  }

  _remote(rec) {
    if (!this.record || !rec?.state) return;
    if (rec.state.status === 'ended') return this._ended();
    if ((rec.state.v || 0) <= (this.state?.v || 0)) return;
    this._setState(rec.state);
  }

  _ended({ kicked = false } = {}) {
    if (!this.record) return;
    const wasHost = this.isHost;
    this.leave();
    this.dispatchEvent(new CustomEvent('ended', { detail: { wasHost, kicked } }));
  }

  _setState(state) {
    // The host removed us: the record is deleted and our id is listed in state.kicked.
    if (!this.isHost && this.member && state.kicked?.includes(this.member.id)) return this._ended({ kicked: true });
    this.state = state;
    if (met.group) met.group.state = state;
    this._applyDrone(state);
    if (!this.isHost) this._applyToMet(state);
    this._onCalib(state.calib);
    if (!this.isHost) this._maybeSync();
    this._emit();
  }

  /** Mirror the party's settings into the metronome UI (members). */
  _applyToMet(s) {
    this._applying = true;
    const cur = met.getState();
    const next = { ...cur, bpm: s.bpm, beats: s.beats };
    for (const k of SOUND_KEYS) if (s[k] != null) next[k] = s[k];
    const changed = Object.keys(next).some((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
    if (changed) met.setState(next);
    this._applying = false;
  }

  // ---------- host controls ----------

  _push(state, { immediate = false } = {}) {
    state.v = (this.state?.v || 0) + 1;
    this._setState(state);
    clearTimeout(this._pushTimer);
    const send = () => store.api(`/api/collections/parties/records/${this.record.id}`, {
      method: 'PATCH', body: JSON.stringify({ state: this.state }),
    }).catch((e) => this.dispatchEvent(new CustomEvent('error', { detail: e.message })));
    if (immediate) send(); else this._pushTimer = setTimeout(send, 150);
  }

  /** Host edited the metronome: share it. Grid changes start on a future downbeat. */
  async _hostEdited() {
    if (this._editGuard) return; // a warning is open; looked at again once it's answered
    const m = met.getState();
    if (this.state.status === 'playing' && (m.bpm !== this.state.bpm || m.beats !== this.state.beats)
        && this.warn && this.listeningMembers.length) {
      this._editGuard = true;
      const ok = await this._guard('tempo');
      this._editGuard = false;
      if (!this.record) return;
      if (!ok) { this._applyToMet(this.state); return; } // put the old tempo back
    }
    this._shareEdit();
  }

  _shareEdit() {
    const m = met.getState();
    const s = { ...this.state };
    for (const k of SOUND_KEYS) s[k] = m[k];
    const gridChanged = m.bpm !== s.bpm || m.beats !== s.beats;
    if (gridChanged) {
      if (s.status === 'playing') {
        const now = this.clock.serverNow();
        if (s.prev && s.t0 > now + LEAD_CHANGE) {
          // A change is already queued and hasn't started: just update it.
        } else if (s.prev && s.t0 > now) {
          // A change starts any moment now: let it land, then queue this one.
          clearTimeout(this._deferTimer);
          this._deferTimer = setTimeout(() => this.record && this._shareEdit(), s.t0 - now + 60);
          this._push(s);
          return;
        } else {
          const at = nextDownbeatAt(s, now + LEAD_CHANGE);
          s.prev = { t0: s.t0, bpm: s.bpm, beats: s.beats };
          s.t0 = at;
        }
      }
      s.bpm = m.bpm;
      s.beats = m.beats;
    }
    this._push(s);
  }

  /** Main button. Host: start, then pause / resume (keeps everyone counting). Member: re-sync. */
  async primaryAction() {
    if (!this.isHost) return this.resync();
    if (this.state.status === 'playing') return this.pause();
    if (this.calibActive) return;
    // Anyone not yet synced? Offer to sync everyone by sound first.
    const need = this.liveMembers.filter((m) => !['synced', 'network'].includes(m.status));
    if (need.length && this.askCalib) {
      const a = await this.askCalib(need);
      if (!this.record || this.state.status === 'playing') return;
      if (a === 'sound') return this.startCalibration();
      if (a !== 'skip') return; // closed the question
      return this.togglePlay({ calib: { phase: 'off', id: Date.now() } });
    }
    return this.togglePlay();
  }

  // ---------- sync everyone by sound (host-led calibration) ----------

  get calibActive() { return ACTIVE_CALIB.includes(this.state?.calib?.phase); }
  get calib() { return this.state?.calib || null; }

  /** Users whose device has checked in recently. */
  get liveMembers() {
    const now = this.clock?.serverNow() ?? Date.now();
    return this.members.filter((m) => now - Date.parse(m.updated) < 50000);
  }

  /** Host: ask everyone to bring their device close and tap Ready. */
  startCalibration() {
    if (!this.isHost || this.calibActive) return;
    this._push({
      ...this.state, status: 'idle', prev: null, mute: null,
      drone: { ...(this.state.drone || {}), on: false },
      calib: { phase: 'gather', id: Date.now() },
    }, { immediate: true });
    this._loadMembers();
  }

  /** Host: everyone's ready (or the host didn't want to wait): play clicks and let phones listen. */
  beginCalibSync() {
    const c = this.state?.calib;
    if (!this.isHost || c?.phase !== 'gather') return;
    const m = met.getState();
    const now = this.clock.serverNow();
    this._push({
      ...this.state, status: 'playing', prev: null, mute: null,
      t0: Math.round(now + LEAD_START), bpm: m.bpm, beats: m.beats,
      calib: { phase: 'sync', id: c.id, at: Math.round(now) },
    }, { immediate: true });
  }

  /** Host: give up on the sync step. */
  cancelCalibration() {
    if (!this.isHost || !this.calibActive) return;
    const playing = this.state.status === 'playing';
    this._push({ ...this.state, status: 'idle', prev: null, mute: null, calib: null }, { immediate: true });
    if (playing) this._loadMembers();
  }

  /** Host: called whenever the member list refreshes during a calibration. */
  _checkCalib() {
    const c = this.state?.calib;
    if (!this.isHost || !c) return;
    const live = this.liveMembers;
    if (c.phase === 'gather') {
      // Everyone tapped Ready (users who chose "no mic" don't need to).
      if (live.some((m) => m.status === 'ready') && live.every((m) => m.status === 'ready' || m.status === 'network')) this.beginCalibSync();
    } else if (c.phase === 'sync') {
      const elapsed = this.clock.serverNow() - c.at;
      const settled = (m) => ['synced', 'failed', 'network'].includes(m.status);
      if ((elapsed > LEAD_START + 2000 && live.every(settled)) || elapsed > CALIB_TIMEOUT) this._finishCalib(live);
    }
  }

  _finishCalib(live) {
    const c = this.state.calib;
    const ok = live.filter((m) => m.status === 'synced' || m.status === 'network').length;
    const failed = live.filter((m) => m.status !== 'synced' && m.status !== 'network').map((m) => m.name || 'A user');
    // Pause (silent but still counting) so the chime is clear and nobody has to re-sync.
    const at = nextBeatAt(this.state, this.clock.serverNow() + LEAD_MUTE);
    this._push({
      ...this.state, mute: { on: true, at },
      calib: { phase: 'done', id: c.id, ok, failed: failed.slice(0, 6), failedCount: failed.length },
    }, { immediate: true });
  }

  /** Member: tapped Ready with the device next to the host's. */
  markReady() {
    if (this.isHost || this.calib?.phase !== 'gather') return;
    this.calibReady = true;
    this._updateMember({ status: 'ready' });
    this._emit();
  }

  /** Reacts once to each new calibration phase (both host and members). */
  _onCalib(c) {
    const key = calibKey(c);
    if (key === this._calibKey) return;
    this._calibKey = key;
    if (!c) { this.calibReady = false; this._emit(); return; }
    if (!this.isHost) {
      if (c.phase === 'gather') {
        this.calibReady = false;
        if (!this.syncing && this.sync.status !== 'network') this._setSync({ status: 'waiting' });
        this._updateMember({ status: 'joined' });
      } else if (c.phase === 'sync') {
        // Sync again even if this phone was synced before (it may have moved).
        if (!this.syncing && this.sync.status !== 'network') this._setSync({ status: 'waiting' });
      }
    }
    if (c.phase === 'done') {
      const mine = this.isHost ? true : this.sync.status === 'synced' || this.sync.status === 'network';
      try { playChime({ ok: mine }); } catch { /* audio not available */ }
      navigator.vibrate?.(mine ? [40, 60, 40] : 200);
      this.dispatchEvent(new CustomEvent('calibdone', { detail: { calib: c, mine } }));
    }
    this._emit();
  }

  /** Host pause/resume, with a warning if pausing would interrupt someone's sync. */
  async pause() {
    if (!this.isHost || this.state.status !== 'playing') return;
    if (!this.state.mute?.on && !(await this._guard('pause'))) return;
    if (this.record && this.state.status === 'playing') this.togglePause();
  }

  /** Host: stop and reset the beat for everyone. */
  async stop() {
    if (!this.isHost || this.state.status !== 'playing') return;
    if (!(await this._guard('stop'))) return;
    if (this.record && this.state.status === 'playing') this.togglePlay();
  }

  // ---------- host warnings (things that can spoil users' acoustic sync) ----------

  /** Users listening to the host's clicks right now (status fresh within 45 s). */
  get listeningMembers() {
    const now = this.clock?.serverNow() ?? Date.now();
    return this.members.filter((m) => m.status === 'listening' && now - Date.parse(m.updated) < 45000);
  }

  get syncedMembers() { return this.members.filter((m) => m.status === 'synced'); }

  /** Asks the UI (party.warn) whether to go ahead with a risky host action. */
  async _guard(kind) {
    if (!this.isHost || !this.warn) return true;
    const who = kind === 'output' ? this.syncedMembers : this.listeningMembers;
    if (!who.length) return true;
    return this.warn(kind, who);
  }

  /** Host: notice when this phone's audio output changes (Bluetooth, headphones),
   * since users synced to the old speaker would then be off by its latency. */
  _watchOutput() {
    const ctx = getCtx();
    const latency = () => (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const devices = async () => {
      try {
        const d = await navigator.mediaDevices.enumerateDevices();
        return d.filter((x) => x.kind === 'audiooutput' || x.kind === 'audioinput').map((x) => x.deviceId + x.label).join('|');
      } catch { return ''; }
    };
    let lastLat = latency(), lastDev = null, busy = false;
    devices().then((d) => { lastDev = d; });
    const check = async (fromEvent) => {
      if (busy || !this.isHost || !this.record) return;
      busy = true;
      try {
        if (fromEvent) await new Promise((r) => setTimeout(r, 800)); // let the route settle
        const lat = latency(), dev = await devices();
        const changed = Math.abs(lat - lastLat) > 0.015 || (fromEvent && lastDev != null && dev !== lastDev);
        lastLat = lat; lastDev = dev;
        if (changed) await this._guard('output');
      } finally { busy = false; }
    };
    const onChange = () => check(true);
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    const t = setInterval(() => check(false), 5000);
    return () => { clearInterval(t); navigator.mediaDevices?.removeEventListener?.('devicechange', onChange); };
  }

  togglePlay(extra = {}) {
    if (!this.isHost) return;
    const m = met.getState();
    if (this.state.status === 'playing') {
      this._push({ ...this.state, status: 'idle', prev: null, mute: null, calib: this.calibActive ? null : this.state.calib, ...extra }, { immediate: true });
    } else {
      this._push({
        ...this.state, status: 'playing', prev: null, mute: null, ...extra,
        t0: Math.round(this.clock.serverNow() + LEAD_START), bpm: m.bpm, beats: m.beats,
      }, { immediate: true });
    }
  }

  /** Pause = everyone goes silent on the next beat but keeps counting. */
  togglePause() {
    if (!this.isHost || this.state.status !== 'playing') return;
    const s = this.state;
    const target = s.mute ? !s.mute.on : true;
    const at = nextBeatAt(s, this.clock.serverNow() + LEAD_MUTE);
    this._push({ ...s, mute: { on: target, at } }, { immediate: true });
  }

  /** Host: start/stop the shared tuning drone. note = { pc, fifth } or null. */
  async setDrone(note) {
    if (!this.isHost) return;
    if (note && !this.droneOn && !(await this._guard('drone'))) return;
    if (!this.record) return;
    const drone = note ? { on: true, pc: note.pc, fifth: !!note.fifth } : { ...(this.state.drone || {}), on: false };
    this._push({ ...this.state, drone, a4: settings.a4 }, { immediate: true });
  }

  /** Plays the drone described by the party state on this phone (C4–B4, tuned to the host's A4). */
  _applyDrone(s) {
    const d = s?.drone?.on ? s.drone : null;
    const a4 = s?.a4 || 440;
    const key = d ? `${d.pc}:${d.fifth ? 1 : 0}:${a4}` : null;
    if (key === this._droneKey) return;
    this._drone?.stop();
    this._drone = null;
    this._droneKey = key;
    if (!d) return;
    const midi = 60 + d.pc;
    this._drone = sustain(a4 * 2 ** ((midi - 69) / 12), { fifth: d.fifth, timbre: 'soft' });
  }

  /** Host: toggle the drone's 5th (remembered even while the drone is off). */
  setDroneFifth(fifth) {
    if (!this.isHost) return;
    this._push({ ...this.state, drone: { ...(this.state.drone || { on: false, pc: 10 }), fifth: !!fifth }, a4: settings.a4 }, { immediate: true });
  }

  get droneOn() { return !!this.state?.drone?.on; }

  /** Member option: show the beat as flash + vibration, no click sound. Saved on the device. */
  get flashOnly() { return localStorage.getItem(FLASH_ONLY_KEY) === '1'; }
  set flashOnly(on) {
    localStorage.setItem(FLASH_ONLY_KEY, on ? '1' : '0');
    if (met.group && !this.isHost) met.group.flashOnly = on;
    this._emit();
  }

  get paused() {
    return !!this.state && this.state.status === 'playing' && !!this.state.mute?.on;
  }

  get pausedNow() {
    return !!this.state && this.clock && isMutedAt(this.state, this.clock.serverNow());
  }

  // ---------- members ----------

  /** Host: remove a user. They drop out at once (via state.kicked) and their record is deleted. */
  async kick(memberId) {
    if (!this.isHost) return;
    const kicked = [...(this.state.kicked || []).filter((id) => id !== memberId), memberId].slice(-50);
    this._push({ ...this.state, kicked }, { immediate: true });
    this.members = this.members.filter((m) => m.id !== memberId);
    this.dispatchEvent(new Event('members'));
    try {
      await store.api(`/api/collections/party_members/records/${memberId}`, { method: 'DELETE' });
    } catch (e) { if (e.status !== 404) this.dispatchEvent(new CustomEvent('error', { detail: e.message })); }
  }

  async _loadMembers() {
    try {
      const f = encodeURIComponent(`party="${this.record.id}"`);
      const r = await store.api(`/api/collections/party_members/records?filter=${f}&perPage=200&sort=created`);
      this.members = r.items;
      this.dispatchEvent(new Event('members'));
      this._checkCalib();
    } catch { /* keep last list */ }
  }

  /** Updates are sent one at a time so a later status can't be overwritten by an earlier one. */
  _updateMember(fields) {
    this._memberQ = (this._memberQ || Promise.resolve()).then(() => this._sendMember(fields));
    return this._memberQ;
  }

  async _sendMember(fields) {
    if (!this.member) return;
    try {
      this.member = await store.api(`/api/collections/party_members/records/${this.member.id}`, {
        method: 'PATCH', body: JSON.stringify({ ...fields, seen: Date.now() }), headers: this._memberHeaders(),
      });
    } catch { /* best effort */ }
  }

  _heartbeat() { this._updateMember({}); }

  /** Guests prove which member record is theirs with their secret key. */
  _memberHeaders() { return this.guestKey ? { 'X-Guest-Key': this.guestKey } : {}; }

  get isGuest() { return !!this.guestKey; }

  // ---------- acoustic sync (members) ----------

  _setSync(sync) {
    this.sync = sync;
    if (met.group) {
      met.group.audible = sync.status === 'synced' || sync.status === 'network';
      if (sync.delta != null) met.group.delta = sync.delta;
    }
    this._emit();
  }

  get loopback() {
    try { return JSON.parse(localStorage.getItem(LOOPBACK_KEY))?.r ?? null; } catch { return null; }
  }

  async _afterGuestJoin() {
    // Measure this phone's own speaker->mic delay while things are quiet.
    if (this.loopback == null && this.state.status !== 'playing') {
      try { await this.calibrateDevice(); } catch { /* fall back to reported latency */ }
    }
    this._maybeSync();
  }

  /** Measures and stores this phone's own output+input latency. */
  async calibrateDevice() {
    if (this.syncing) return;
    this.syncing = true;
    const prev = this.sync;
    this._setSync({ status: 'calibrating' });
    try {
      await acoustic.openMic();
      const set = await getSoundSet('click', getCtx().sampleRate);
      const r = await acoustic.measureLoopback((t) => met._play(set.accent, t, 0.9));
      if (r == null) throw new Error('Could not hear this phone\'s own clicks');
      localStorage.setItem(LOOPBACK_KEY, JSON.stringify({ r, at: Date.now() }));
      this._setSync(prev.status === 'calibrating' ? { status: 'idle' } : prev);
      return r;
    } catch (e) {
      this._setSync(prev.status === 'calibrating' ? { status: 'idle' } : prev);
      throw e;
    } finally {
      acoustic.closeMic();
      this.syncing = false;
    }
  }

  _maybeSync() {
    if (this.isHost || this.syncing) return;
    const st = this.sync.status;
    const c = this.state.calib;
    if (c?.phase === 'gather') return;
    if (c?.phase === 'off' && this.state.status === 'playing' && (st === 'idle' || st === 'waiting')) return this.useNetworkOnly();
    if (this.state.status !== 'playing') {
      if (st === 'idle' || st === 'failed') this._setSync({ ...this.sync, status: 'waiting' });
      return;
    }
    if (st === 'idle' || st === 'waiting') this.resync();
  }

  /** Estimated speaker+mic latency when the phone hasn't been calibrated. */
  _reportedLatency() {
    const ctx = getCtx();
    return (ctx.outputLatency || ctx.baseLatency || 0.01) + 0.01;
  }

  /** Listens to the host for a few beats and aligns this phone to it. */
  async resync() {
    if (this.isHost || this.syncing || !this.record) return;
    if (this.state.status !== 'playing') { this._setSync({ status: 'waiting' }); return; }
    this.syncing = true;
    this._setSync({ status: 'listening' });
    this._updateMember({ status: 'listening' }); // lets the host warn before interrupting
    let result = null, error = null;
    try {
      await acoustic.openMic();
      let R = this.loopback;
      if (R == null) {
        this._setSync({ status: 'calibrating' });
        const set = await getSoundSet('click', getCtx().sampleRate);
        R = await acoustic.measureLoopback((t) => met._play(set.accent, t, 0.9));
        if (R != null) localStorage.setItem(LOOPBACK_KEY, JSON.stringify({ r: R, at: Date.now() }));
        else R = this._reportedLatency();
        this._setSync({ status: 'listening' });
      }
      for (let attempt = 0; attempt < 3 && !result && this.record; attempt++) {
        result = await this._measureHost();
      }
      if (result) result.delta = result.m - R;
    } catch (e) {
      error = e.message;
    } finally {
      acoustic.closeMic();
      this.syncing = false;
    }
    // Left, or chose "follow without the mic" meanwhile: keep that choice.
    if (!this.record || this.sync.status === 'network') return;
    if (result) {
      this._setSync({ status: 'synced', delta: result.delta, spreadMs: result.spread * 1000, heard: result.n });
      this._updateMember({ status: 'synced', syncMs: Math.round(result.spread * 10000) / 10 });
    } else {
      this._setSync({ status: 'failed', message: error || 'Couldn\'t hear the host. Move closer and try again.' });
      this._updateMember({ status: 'failed' });
    }
  }

  /** Times the host's next 8 audible clicks. Returns { m, spread, n } or null. */
  async _measureHost() {
    const s = this.state;
    const now = this.clock.serverNow();
    const beats = groupEvents(s, now + 300, now + 300 + 20000, [0])
      .filter((e) => !isMutedAt(s, e.ts) && (met.accents[e.beat] ?? 2) > 0)
      .slice(0, 8);
    if (beats.length < 5) return null;
    await acoustic.waitForAudio(this.clock.toCtx(beats[beats.length - 1].ts) + 0.4, 25000);
    const offs = [];
    for (const b of beats) {
      const pred = this.clock.toCtx(b.ts);
      const o = acoustic.detectOnset(pred - 0.08, pred + Math.min(0.3, (b.P / 1000) * 0.45));
      if (o) offs.push(o.time - pred);
    }
    if (offs.length < 5) return null;
    const sp = acoustic.spread(offs);
    if (sp > 0.006) return null;
    return { m: acoustic.median(offs), spread: sp, n: offs.length };
  }

  /** Member gave up on acoustic sync: follow the network clock only. */
  useNetworkOnly() {
    if (this.isHost) return;
    // Without hearing the host, assume its speaker latency matches ours.
    this._setSync({ status: 'network', delta: 0 });
    this._updateMember({ status: 'network' });
  }
}

function calibKey(c) { return c ? `${c.id}:${c.phase}` : null; }

export const party = new Party();
