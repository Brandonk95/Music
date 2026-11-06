// App-wide settings persisted to localStorage.

const KEY = 'tt.settings';

const DEFAULTS = {
  // tuner
  a4: 440,
  noteNames: 'common', // common | sharp | flat | solfege
  transpose: 0,
  tolerance: 3, // cents considered "in tune"
  display: 'needle', // needle | strobe
  sensitivity: 6, // 1..10 (noise gate)
  toneTimbre: 'pluck', // sine | soft | pluck
  toneVolume: 0.6,
  playOnTap: true,
  tuningId: 'chromatic',
  justRoot: -1, // -1 = equal temperament, 0..11 = just intonation in that concert key
  droneFifth: false,
  // metronome
  flash: false,
  vibrate: false,
  visualOffset: 0, // ms, positive delays visuals (e.g. Bluetooth headphones)
  // general
  keepAwake: true,
  serverUrl: '', // empty = same origin as the app
  tab: 'tuner',
};

let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }

// v2: 'sharp' was the old default; move to the band-friendly 'common' spelling.
if ((saved.v || 1) < 2) {
  if (saved.noteNames === 'sharp') saved.noteNames = 'common';
  saved.v = 2;
}

export const settings = { ...DEFAULTS, ...saved };
const listeners = new Set();

export function setSetting(key, value) {
  settings[key] = value;
  localStorage.setItem(KEY, JSON.stringify(settings));
  listeners.forEach((fn) => fn(key, value));
}

/** Back to defaults (keeps the server, open tab and chosen instrument). */
export function resetSettings() {
  const keep = { serverUrl: settings.serverUrl, tab: settings.tab, tuningId: settings.tuningId };
  for (const [k, v] of Object.entries({ ...DEFAULTS, ...keep })) setSetting(k, v);
}

export function onSetting(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
