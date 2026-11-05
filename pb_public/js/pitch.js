// Pitch detection using the McLeod Pitch Method (normalized square difference
// function), with the autocorrelation computed by FFT so it is cheap enough to
// run every animation frame on a phone.

function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  if (1 << levels !== n) throw new Error('FFT size must be a power of two');
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  return function fft(re, im, inverse) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cos[k];
          const s = inverse ? sin[k] : -sin[k];
          const tre = re[l] * c - im[l] * s;
          const tim = re[l] * s + im[l] * c;
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

export class PitchDetector {
  constructor(size, sampleRate) {
    this.n = size;
    this.sr = sampleRate;
    this.m = size * 2;
    this.fft = makeFFT(this.m);
    this.re = new Float64Array(this.m);
    this.im = new Float64Array(this.m);
    this.x = new Float64Array(size);
    this.nsdf = new Float64Array(size);
  }

  /**
   * @param {Float32Array} buf time-domain samples (length === size)
   * @returns {{freq:number, clarity:number, rms:number} | {freq:0, clarity:0, rms:number}}
   */
  detect(buf, { minFreq = 27, maxFreq = 4200, minRms = 0.002 } = {}) {
    const { n, sr, re, im, x, nsdf } = this;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += buf[i];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) { const v = buf[i] - mean; x[i] = v; energy += v * v; }
    const rms = Math.sqrt(energy / n);
    if (rms < minRms) return { freq: 0, clarity: 0, rms };

    // Autocorrelation via FFT of the zero-padded signal.
    re.fill(0); im.fill(0);
    re.set(x);
    this.fft(re, im, false);
    for (let i = 0; i < this.m; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    this.fft(re, im, true);

    const maxTau = Math.min(n >> 1, Math.ceil(sr / minFreq));
    const minTau = Math.max(2, Math.floor(sr / maxFreq));

    // NSDF: n'(tau) = 2 r(tau) / m(tau), where m is updated incrementally.
    // Computed to n/2 (beyond maxTau) so the multi-period refinement can use it.
    const lastTau = n >> 1;
    let mt = 2 * energy;
    for (let tau = 0; tau <= lastTau; tau++) {
      const r = re[tau] / this.m;
      nsdf[tau] = mt > 0 ? (2 * r) / mt : 0;
      mt -= x[tau] * x[tau] + x[n - 1 - tau] * x[n - 1 - tau];
    }

    // Key maxima: highest point of each positive lobe after the first negative crossing.
    const peaks = [];
    let tau = 1;
    while (tau < maxTau && nsdf[tau] > 0) tau++;
    let best = -1, bestTau = -1;
    for (; tau < maxTau - 1; tau++) {
      if (nsdf[tau] > 0) {
        if (nsdf[tau] > best) { best = nsdf[tau]; bestTau = tau; }
      } else if (bestTau >= 0) {
        peaks.push(bestTau);
        best = -1; bestTau = -1;
      }
    }
    if (bestTau >= 0) peaks.push(bestTau);
    if (!peaks.length) return { freq: 0, clarity: 0, rms };

    let globalMax = 0;
    for (const p of peaks) if (nsdf[p] > globalMax) globalMax = nsdf[p];
    const threshold = globalMax * 0.9;
    let chosen = -1;
    for (const p of peaks) {
      if (p >= minTau && nsdf[p] >= threshold) { chosen = p; break; }
    }
    if (chosen < 0) return { freq: 0, clarity: 0, rms };

    const first = this._interp(chosen);
    let period = first.tau;

    // Refine: the peak k periods out has the same interpolation error but
    // divided by k, which removes most of the bias for short periods.
    const maxK = Math.floor((lastTau - 2) / period);
    for (let k = Math.min(maxK, 16); k >= 2; k--) {
      const guess = Math.round(k * period);
      let p = guess;
      for (let i = guess - 2; i <= guess + 2; i++) if (nsdf[i] > nsdf[p]) p = i;
      if (p <= 0 || p >= lastTau || nsdf[p] < first.value * 0.85) continue;
      const pk = this._interp(p);
      const refined = pk.tau / k;
      if (Math.abs(refined - period) / period < 0.01) { period = refined; break; }
    }
    return { freq: sr / period, clarity: first.value, rms };
  }

  /** Parabolic interpolation around a local maximum. */
  _interp(i) {
    const s = this.nsdf;
    const a = s[i - 1], b = s[i], c = s[i + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    return { tau: i + shift, value: b - 0.25 * (a - c) * shift };
  }
}
