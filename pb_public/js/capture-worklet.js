// Records microphone samples together with the AudioContext time of the first
// sample, so click onsets can be timed precisely on the same clock that
// schedules the metronome.
class TTCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.t = 0;
  }

  flush() {
    if (!this.n) return;
    this.port.postMessage({ t: this.t, data: this.buf.slice(0, this.n) });
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) { this.flush(); return true; }
    if (this.n === 0) this.t = currentTime;
    // Keep chunks contiguous: if this block isn't where we expect, start a new chunk.
    else if (Math.abs(currentTime - (this.t + this.n / sampleRate)) > 1 / sampleRate) {
      this.flush();
      this.t = currentTime;
    }
    if (this.n + ch.length > this.size) { this.flush(); this.t = currentTime; }
    this.buf.set(ch, this.n);
    this.n += ch.length;
    if (this.n >= this.size) this.flush();
    return true;
  }
}

registerProcessor('tt-capture', TTCapture);
