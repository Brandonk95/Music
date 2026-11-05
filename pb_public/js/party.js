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

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LEAD_START = 2000; // ms between pressing play and the first beat
const LEAD_CHANGE = 900; // tempo/meter changes start on a downbeat at least this far ahead
const LEAD_MUTE = 300; // pause/resume on a beat at least this far ahead
const LOOPBACK_KEY = 'tt.loopback';
const SOUND_KEYS = ['accents', 'subdivision', 'sound', 'noteValue', 'volume', 'subVolume'];

const makeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const memberName = () => store.user?.name || (store.user?.email || 'Player').split('@')[0];
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
    if (!isHost || rec.state.status !== 'idle') this._applyToMet(rec.state);
    met.enterGroup({
      clock, state: this.state, delta: 0, audible: isHost, isHost,
      controls: { play: () => this.primaryAction(), pause: () => this.togglePause() },
    });
    this._subscribe();
    this.timers.push(setInterval(() => this._poll(), 4000));
    if (isHost) { this._loadMembers(); this.timers.push(setInterval(() => this._loadMembers(), 3000)); }
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
    this.es?.close();
    this.es = null;
    this.clock?.stop();
    acoustic.closeMic();
    met.exitGroup();
    this._applying = true;
    if (this.savedMet) met.setState(this.savedMet);
    this._applying = false;
    wake.release('group');
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

  _ended() {
    if (!this.record) return;
    const wasHost = this.isHost;
    this.leave();
    this.dispatchEvent(new CustomEvent('ended', { detail: { wasHost } }));
  }

  _setState(state) {
    this.state = state;
    if (met.group) met.group.state = state;
    if (!this.isHost) this._applyToMet(state);
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
  _hostEdited() {
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
          this._deferTimer = setTimeout(() => this.record && this._hostEdited(), s.t0 - now + 60);
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

  primaryAction() {
    if (this.isHost) return this.togglePlay();
    return this.resync();
  }

  togglePlay() {
    if (!this.isHost) return;
    const m = met.getState();
    if (this.state.status === 'playing') {
      this._push({ ...this.state, status: 'idle', prev: null, mute: null }, { immediate: true });
    } else {
      this._push({
        ...this.state, status: 'playing', prev: null, mute: null,
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

  get paused() {
    return !!this.state && this.state.status === 'playing' && !!this.state.mute?.on;
  }

  get pausedNow() {
    return !!this.state && this.clock && isMutedAt(this.state, this.clock.serverNow());
  }

  // ---------- members ----------

  async _loadMembers() {
    try {
      const f = encodeURIComponent(`party="${this.record.id}"`);
      const r = await store.api(`/api/collections/party_members/records?filter=${f}&perPage=200&sort=created`);
      this.members = r.items;
      this.dispatchEvent(new Event('members'));
    } catch { /* keep last list */ }
  }

  async _updateMember(fields) {
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

export const party = new Party();
