// One shared AudioContext for the whole app (tuner input, metronome, reference tones).

let ctx = null;
let micActive = false;

export function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  return ctx;
}

/** Resume the context; must be called from a user gesture the first time (iOS). */
export async function unlock() {
  const c = getCtx();
  if (c.state !== 'running') await c.resume();
  return c;
}

// iOS Safari: "playback" lets sound play with the ring/silent switch on.
// While the mic is open we need "play-and-record".
function applySession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = micActive ? 'play-and-record' : 'playback';
  } catch { /* not supported */ }
}

export function setMicActive(on) {
  micActive = on;
  applySession();
}

applySession();
