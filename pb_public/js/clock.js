// Shared time for the group metronome.
//
// serverNow():  the PocketBase server's clock, estimated NTP-style from
//               round trips to /api/time (lowest-latency samples win).
// toCtx(ms):    converts a server time to the AudioContext time at which a
//               sound must be scheduled to be *heard* at that moment.
//
// Both mappings are filtered and slewed gently so the beat grid never jumps.
import { getCtx } from './audio.js';
import { store } from './store.js';

export class SyncClock {
  constructor() {
    this.offset = 0; // server ms - performance.now() ms
    this.ready = false;
    this.samples = [];
    this.rtt = null;
    this.ctxOff = null; // performance ms at which ctx time 0 is heard
    this.ctxOutliers = 0;
    this.timer = null;
  }

  async _sample() {
    const t1 = performance.now();
    const res = await fetch(`${store.base}/api/time`, { cache: 'no-store' });
    const { t } = await res.json();
    const t2 = performance.now();
    return { rtt: t2 - t1, off: t - (t1 + t2) / 2, at: t2 };
  }

  async burst(n) {
    for (let i = 0; i < n; i++) {
      try { this.samples.push(await this._sample()); } catch { /* offline: keep last estimate */ }
    }
    const now = performance.now();
    this.samples = this.samples.filter((s) => now - s.at < 45000).slice(-40);
    if (!this.samples.length) return;
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.rtt = best.rtt;
    const d = best.off - this.offset;
    // First estimate (or a big jump, e.g. device clock change): take it.
    // Otherwise slew at most 2 ms per update so scheduled beats stay smooth.
    if (!this.ready || Math.abs(d) > 80) this.offset = best.off;
    else this.offset += Math.max(-2, Math.min(2, d));
    this.ready = true;
  }

  async start() {
    await this.burst(10);
    if (!this.ready) throw new Error('Could not reach the server clock');
    clearInterval(this.timer);
    this.timer = setInterval(() => this.burst(3), 5000);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  serverNow() { return performance.now() + this.offset; }

  /** Call often (every scheduler tick) to track the audio clock. */
  updateCtx() {
    const ctx = getCtx();
    let s;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) s = ts.performanceTime - ts.contextTime * 1000;
    else s = performance.now() - ctx.currentTime * 1000;
    if (this.ctxOff == null) { this.ctxOff = s; return; }
    if (Math.abs(s - this.ctxOff) > 25) {
      // A sustained jump means the audio device changed or resumed; re-anchor.
      if (++this.ctxOutliers > 15) { this.ctxOff = s; this.ctxOutliers = 0; }
      return;
    }
    this.ctxOutliers = 0;
    this.ctxOff += (s - this.ctxOff) * 0.03;
  }

  toCtx(serverMs) {
    if (this.ctxOff == null) this.updateCtx();
    return (serverMs - this.offset - this.ctxOff) / 1000;
  }
}
