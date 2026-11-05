// Keeps the screen on while the tuner or metronome is running.
import { settings } from './settings.js';

const reasons = new Set();
let sentinel = null;

async function acquire() {
  if (!('wakeLock' in navigator) || sentinel || !settings.keepAwake) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => { sentinel = null; });
  } catch { /* denied or not visible */ }
}

export const wake = {
  request(reason) { reasons.add(reason); acquire(); },
  release(reason) {
    reasons.delete(reason);
    if (!reasons.size && sentinel) { sentinel.release(); sentinel = null; }
  },
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && reasons.size) acquire();
});
