// Tuner view: microphone input -> pitch detection -> needle/strobe + history.
import { getCtx, unlock, setMicActive } from './audio.js';
import { PitchDetector } from './pitch.js';
import { TUNINGS, JUST, findTuning, tuningTitle, parseNote, noteLabel, freqToMidi, midiToFreq } from './notes.js';
import { settings, setSetting, onSetting } from './settings.js';
import { store } from './store.js';
import { tone } from './tone.js';
import { wake } from './wakelock.js';
import { h, fill, $, toast, openSheet, askText, sizeCanvas, cssVar, holdRepeat } from './ui.js';

const HISTORY_LEN = 300;
const DEFAULT_TUNING = TUNINGS[0]; // chromatic

let customTunings = [];
let tuning = DEFAULT_TUNING;
let stringMidis = [];
let selected = 0; // index into strings
let auto = true;
const tunedStrings = new Set();

let running = false;
let stream, source, analyser, buf, detector, rafId;
let freqWindow = [];
let smoothCents = 0;
let lastTarget = null;
let justOff = 0;
let groupTarget = null; // { pc, a4 } while the group host runs section tuning

/** Fires 'reading' (detail: { cents } or null) every frame while section tuning. */
export const tunerEvents = new EventTarget();

/** Group section tuning: lock the target to one concert pitch class (null = back to normal). */
export function setGroupTarget(t) {
  groupTarget = t ? { pc: t.pc, a4: t.a4 || settings.a4 } : null;
  lastTarget = null;
  current = null;
  freqWindow = [];
  if (running) updateReadout(performance.now());
  else if ($('noteDisplay')) $('concertLabel').textContent = sectionLine();
}

/** How a concert pitch class reads on this player's instrument: { yours, concert, transposed }. */
export function sectionNoteNames(pc) {
  const tr = stringMidis.length ? 0 : transposeOf();
  return {
    yours: noteLabel(60 + pc + tr, settings.noteNames).name,
    concert: noteLabel(60 + pc, settings.noteNames).name,
    transposed: !!tr,
  };
}

function sectionLine() {
  if (!groupTarget) return '';
  const tr = stringMidis.length ? 0 : transposeOf();
  const concert = noteLabel(60 + groupTarget.pc, settings.noteNames).name;
  const yours = noteLabel(60 + groupTarget.pc + tr, settings.noteNames).name;
  return tr ? `Section tuning: play your ${yours} (concert ${concert})` : `Section tuning: play ${concert}`;
}
let lastHeard = 0;
let inTuneSince = 0;
let current = null; // { freq, targetMidi, cents }
const history = new Float32Array(HISTORY_LEN).fill(NaN);
let histPos = 0;
let strobePhase = 0;
let lastFrameTime = 0;

// ---------- tuning selection ----------

function tuningToObj(p) {
  return { id: p.id, instrument: 'Custom', name: p.name, notes: p.data.notes, custom: p };
}

async function loadCustomTunings() {
  try { customTunings = (await store.list('tuning')).map(tuningToObj); } catch { customTunings = []; }
  const found = findTuning(settings.tuningId, customTunings);
  if (found && found.id !== tuning.id) setTuning(found, false);
}

function setTuning(tu, persist = true) {
  tuning = tu;
  stringMidis = tu.notes.map(parseNote).filter((m) => m != null);
  selected = 0;
  tunedStrings.clear();
  lastTarget = null;
  if (persist) setSetting('tuningId', tu.id);
  $('tuningLabel').textContent = tuningTitle(tu);
  $('concertLabel').textContent = '';
  renderStrings();
  if (running) configureAnalyser();
}

function renderStrings() {
  const wrap = $('strings');
  fill(wrap);
  $('autoBtn').hidden = stringMidis.length === 0;
  wrap.classList.toggle('empty', stringMidis.length === 0);
  stringMidis.forEach((m, i) => {
    const { name, octave } = noteLabel(m, settings.noteNames);
    wrap.append(h('button', {
      class: 'string-btn' + (i === selected && (!auto || current) ? ' active' : '') + (tunedStrings.has(i) ? ' tuned' : ''),
      dataset: { i },
      'aria-label': `String ${stringMidis.length - i}: ${name}${octave}`,
      onclick: () => {
        selected = i;
        setAuto(false);
        if (settings.playOnTap) tone.pluck(midiToFreq(m, settings.a4));
        renderStrings();
      },
    }, h('span', { class: 'sn' }, name), h('sub', {}, octave)));
  });
}

function setAuto(on) {
  auto = on;
  $('autoBtn').classList.toggle('on', on);
  $('autoBtn').setAttribute('aria-pressed', on);
}

function openTuningSheet() {
  const groups = {};
  for (const tu of TUNINGS) (groups[tu.instrument] ||= []).push(tu);
  const describe = (tu) => {
    if (tu.notes.length) return tu.notes.join(' ');
    if (tu.transpose == null) return 'Any note, concert pitch';
    return `${tu.key}${tu.transpose ? ' · shows written notes' : ''}`;
  };
  const item = (tu, onDelete) => h('div', { class: 'list-row' + (tu.id === tuning.id ? ' current' : '') },
    h('button', { class: 'list-main', onclick: () => { setTuning(tu); sheet.close(); } },
      h('b', {}, tu.name),
      h('small', {}, describe(tu))),
    onDelete && h('button', { class: 'icon-btn danger', 'aria-label': 'Delete', onclick: onDelete }, '🗑'));

  const custom = h('div', {},
    customTunings.map((tu) => item(tu, async () => {
      if (!confirm(`Delete tuning "${tu.name}"?`)) return;
      try { await store.remove(tu.custom); } catch (e) { return toast(e.message); }
      sheet.close();
      await loadCustomTunings();
      if (tuning.id === tu.id) setTuning(DEFAULT_TUNING);
    })),
    h('button', { class: 'ghost wide', onclick: () => { sheet.close(); newCustomTuning(); } }, '+ New custom tuning'));

  const content = h('div', { class: 'tuning-list' },
    Object.entries(groups).map(([inst, list]) => [h('h3', {}, inst), list.map((tu) => item(tu))]),
    h('h3', {}, 'My tunings'), custom);
  const sheet = openSheet('Instrument', content);
  // Jump to the selected instrument so long lists don't need scrolling.
  setTimeout(() => content.querySelector('.current')?.scrollIntoView({ block: 'center' }), 250);
}

/** Semitones from concert to written pitch for the current instrument. */
const transposeOf = () => tuning.transpose ?? (tuning.id === 'chromatic' ? +settings.transpose : 0);
const mod12 = (n) => ((n % 12) + 12) % 12;
const isWind = () => tuning.instrument === 'Woodwinds' || tuning.instrument === 'Brass';
const pitchClassName = (pc) => noteLabel(60 + pc, settings.noteNames).name;

async function newCustomTuning() {
  const name = await askText('Tuning name', { placeholder: 'e.g. Open D minor' });
  if (!name) return;
  const notesStr = await askText('Notes, low to high', { placeholder: 'D2 A2 D3 F3 A3 D4', ok: 'Create' });
  if (!notesStr) return;
  const notes = notesStr.split(/[\s,]+/).filter(Boolean);
  const bad = notes.filter((n) => parseNote(n) == null);
  if (!notes.length || bad.length) return toast(`Couldn't read: ${bad.join(' ') || 'notes'}. Use e.g. E2 F#3 Bb4`);
  if (notes.length > 12) return toast('Up to 12 strings');
  try {
    const saved = await store.save('tuning', name, { notes });
    await loadCustomTunings();
    setTuning(tuningToObj(saved));
    toast('Tuning saved');
  } catch (e) { toast(e.message); }
}

// ---------- A4 calibration ----------

function updateRefLabel() {
  $('a4Label').textContent = settings.a4 + (settings.justRoot >= 0 ? ` · Just ${pitchClassName(settings.justRoot)}` : '');
}

function openA4Sheet() {
  const val = h('div', { class: 'big-value' });
  const show = () => { val.textContent = `${settings.a4} Hz`; updateRefLabel(); };
  const temperament = h('div', {});
  const drawTemperament = () => fill(temperament, 
    h('h3', {}, 'Temperament'),
    h('p', { class: 'hint' }, 'Just intonation shows how to adjust each note for pure-sounding chords in a key (concert pitch): e.g. play the major 3rd about 14¢ low and the 5th 2¢ high. Applies in chromatic and band instrument modes.'),
    h('div', { class: 'chips' },
      h('button', { class: 'chip' + (settings.justRoot < 0 ? ' on' : ''), onclick: () => { setSetting('justRoot', -1); drawTemperament(); show(); } }, 'Equal'),
      Array.from({ length: 12 }, (_, i) => (i + 10) % 12).map((pc) => h('button', {
        class: 'chip' + (settings.justRoot === pc ? ' on' : ''),
        onclick: () => { setSetting('justRoot', pc); drawTemperament(); show(); },
      }, `Just ${pitchClassName(pc)}`))));
  drawTemperament();
  const step = (d) => { setSetting('a4', Math.round(Math.min(480, Math.max(400, settings.a4 + d)) * 10) / 10); show(); };
  const minus = h('button', { class: 'round' }, '−');
  const plus = h('button', { class: 'round' }, '+');
  holdRepeat(minus, () => step(-1));
  holdRepeat(plus, () => step(1));
  show();
  openSheet('Pitch reference', h('div', {},
    h('h3', {}, 'Calibration (A4)'),
    h('div', { class: 'stepper' }, minus, val, plus),
    h('div', { class: 'chips' }, [415, 432, 440, 442, 443, 444].map((f) =>
      h('button', { class: 'chip', onclick: () => { setSetting('a4', f); show(); } }, f))),
    h('div', { class: 'chips' },
      h('button', { class: 'chip', onclick: () => step(-0.5) }, '−0.5'),
      h('button', { class: 'chip', onclick: () => step(0.5) }, '+0.5'),
      h('button', { class: 'chip', onclick: () => tone.drone(settings.a4) }, '▶ Play A4'),
      h('button', { class: 'chip', onclick: () => tone.stop() }, '■ Stop')),
    temperament), { onClose: () => tone.stop() });
}

// ---------- reference tone / pitch pipe ----------

function toneButton() {
  if (tone.droneFreq) { tone.stop(); updateToneBtn(); return; }
  if (stringMidis.length) {
    tone.drone(midiToFreq(stringMidis[selected], settings.a4));
    updateToneBtn();
  } else openPitchPipe();
}

function updateToneBtn() {
  $('toneBtn').classList.toggle('on', !!tone.droneFreq);
  $('toneBtn').textContent = tone.droneFreq ? '■ Tone' : '♪ Tone';
}

let pipeOctave = 4;

function openPitchPipe() {
  let playing = null;
  const tr = transposeOf();
  const grid = h('div', { class: 'pipe-grid' });
  const octLabel = h('b', {});
  const play = (midi) => {
    if (playing === midi) { tone.stop(); playing = null; } else { tone.drone(midiToFreq(midi, settings.a4)); playing = midi; }
    draw();
    updateToneBtn();
  };
  const draw = () => {
    octLabel.textContent = `Octave ${pipeOctave}`;
    fill(grid, ...Array.from({ length: 12 }, (_, i) => {
      const midi = (pipeOctave + 1) * 12 + i;
      const { name } = noteLabel(midi, settings.noteNames);
      const sub = tr ? `you play ${noteLabel(midi + tr, settings.noteNames).name}` : midiToFreq(midi, settings.a4).toFixed(1);
      return h('button', {
        class: 'pipe-key' + (playing === midi ? ' on' : '') + ([1, 3, 6, 8, 10].includes(i) ? ' sharp' : ''),
        onclick: () => play(midi),
      }, name, h('small', {}, sub));
    }));
  };
  draw();
  const quick = (pc, label) => h('button', { class: 'chip', onclick: () => play((pipeOctave + 1) * 12 + pc) }, label);
  openSheet('Tuning notes & drone', h('div', {},
    h('p', { class: 'hint' }, tr
      ? `Big letters are concert pitch; the small line is the written note for ${tuning.name}.`
      : 'Tap a note to start a drone; tap again to stop.'),
    h('div', { class: 'chips' }, quick(10, 'Concert B♭'), quick(9, 'Concert A'), quick(5, 'Concert F'), quick(3, 'Concert E♭')),
    h('div', { class: 'stepper' },
      h('button', { class: 'round', 'aria-label': 'Lower octave', onclick: () => { pipeOctave = Math.max(1, pipeOctave - 1); draw(); } }, '−'),
      octLabel,
      h('button', { class: 'round', 'aria-label': 'Higher octave', onclick: () => { pipeOctave = Math.min(7, pipeOctave + 1); draw(); } }, '+')),
    grid,
    h('label', { class: 'field row toggle-row' }, 'Add a perfect 5th to the drone',
      h('input', { type: 'checkbox', class: 'switch', checked: settings.droneFifth, onchange: (e) => {
        setSetting('droneFifth', e.target.checked);
        if (playing != null) { tone.drone(midiToFreq(playing, settings.a4)); }
      } }))), { onClose: () => { tone.stop(); updateToneBtn(); } });
}

// ---------- microphone ----------

function configureAnalyser() {
  const lowest = stringMidis.length ? Math.min(...stringMidis) : tuning.low ?? 99;
  const size = lowest < 40 ? 8192 : 4096; // more samples for bass instruments
  analyser.fftSize = size;
  buf = new Float32Array(size);
  detector = new PitchDetector(size, getCtx().sampleRate);
  freqWindow = [];
}

let starting = false, wanted = false, tapRetry = null;

const IN_APP = /FBAN|FBAV|Instagram|Snapchat|Line\/|TikTok|musical_ly|; wv\)/i.test(navigator.userAgent);

async function micPermission() {
  try { return (await navigator.permissions.query({ name: 'microphone' })).state; } catch { return 'unknown'; }
}

/** Called when the Tuner tab is shown. Listens at once if the mic is already allowed;
 * otherwise waits for a tap, so the browser's permission prompt shows up when the
 * user expects it (prompts dismissed by accident get the site blocked for days). */
export async function startTuner() {
  wanted = true;
  if (running || starting) return;
  if (IN_APP) return needTap('Open this page in Chrome or Safari to use the mic. Tap for help', showMicHelp);
  const p = await micPermission();
  if (!wanted) return;
  if (p === 'granted') return start();
  if (p === 'denied') return needTap('Microphone is blocked. Tap here to fix it', showMicHelp);
  needTap('Tap anywhere to turn on the microphone');
}

/** Wait for a tap anywhere, then run `action` inside that tap (browsers only allow
 * audio and permission prompts from a real tap; pointerdown doesn't count on phones). */
function needTap(text, action = start) {
  $('tuneHint').textContent = text;
  if (tapRetry) document.removeEventListener('click', tapRetry, true);
  tapRetry = () => { document.removeEventListener('click', tapRetry, true); tapRetry = null; if (wanted) action(); };
  document.addEventListener('click', tapRetry, true);
}

function showMicHelp() {
  const android = /Android/i.test(navigator.userAgent);
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const steps = IN_APP
    ? ['This page is open inside another app (like Instagram or Snapchat), which can’t use the microphone.',
      `Tap the ⋮ or share menu and choose “Open in ${ios ? 'Safari' : 'Chrome'}” (or copy the link into ${ios ? 'Safari' : 'Chrome'}).`]
    : ios
      ? ['Tap “aA” (or the page settings icon) in the address bar → Website Settings → Microphone → Allow.',
        'Or open the Settings app → Safari → Microphone → Ask or Allow.',
        'Then come back and tap Try again.']
      : android
        ? ['Tap the icon left of the web address (🔒 or ⚙) → Permissions → Microphone → Allow.',
          'Installed app: open Chrome → ⋮ → Settings → Site settings → Microphone, find this site and allow it.',
          'If you closed the permission popup a few times, Chrome blocks it for a while; allowing it here fixes that.',
          'Also check Android Settings → Apps → Chrome → Permissions → Microphone is allowed.']
        : ['Click the icon left of the web address → Site settings → Microphone → Allow, then reload.'];
  const sheet = openSheet('Turn on the microphone', h('div', { class: 'form' },
    h('ol', { class: 'steps' }, steps.map((t) => h('li', {}, t))),
    !IN_APP && h('button', { class: 'primary wide', onclick: () => { sheet.close(); wanted = true; start(); } }, 'Try again')));
}

async function start() {
  if (running || starting) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    $('tuneHint').textContent = 'Microphone needs HTTPS';
    return;
  }
  starting = true;
  try {
    const ctx = getCtx();
    // Both calls start right away, inside the user's tap when there is one.
    const resumed = ctx.state !== 'running' ? ctx.resume().catch(() => {}) : null;
    let s;
    try {
      setMicActive(true);
      s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      setMicActive(false);
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
        return needTap('Microphone is blocked. Tap here to fix it', showMicHelp);
      }
      return needTap(e.name === 'NotFoundError' ? 'No microphone found. Tap to try again' : `Mic error: ${e.message}. Tap to retry`);
    }
    if (resumed) await Promise.race([resumed, new Promise((r) => setTimeout(r, 500))]);
    if (!wanted || ctx.state !== 'running') {
      s.getTracks().forEach((t) => t.stop());
      setMicActive(false);
      if (wanted) needTap('Tap anywhere to start tuning');
      return;
    }
    stream = s;
    listen(ctx);
  } finally { starting = false; }
}

function listen(ctx) {
  source = ctx.createMediaStreamSource(stream);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 4500;
  analyser = ctx.createAnalyser();
  source.connect(lp).connect(analyser);
  configureAnalyser();
  running = true;
  wake.request('tuner');
  $('view-tuner').classList.add('listening');
  $('tuneHint').textContent = 'Play a note…';
  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(frame);
}

export function stopTuner() {
  wanted = false;
  if (tapRetry) { document.removeEventListener('click', tapRetry, true); tapRetry = null; }
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  stream?.getTracks().forEach((t) => t.stop());
  source?.disconnect();
  setMicActive(false);
  wake.release('tuner');
  current = null;
  $('view-tuner').classList.remove('listening');
  $('tuneHint').textContent = 'Paused';
  $('noteDisplay').className = 'note-display idle';
  draw();
}

let jumpTo = 0;
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
};

function frame(now) {
  if (!running) return;
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  analyser.getFloatTimeDomainData(buf);
  const gateDb = -74 + (10 - settings.sensitivity) * 4.5; // sensitivity 10 => -74 dBFS
  const minRms = Math.pow(10, gateDb / 20);
  const minFreq = stringMidis.length ? Math.max(25, midiToFreq(Math.min(...stringMidis) - 7, settings.a4))
    : tuning.low != null ? Math.max(25, midiToFreq(tuning.low - 5, settings.a4)) : 27;
  const r = detector.detect(buf, { minFreq, maxFreq: 4200, minRms });

  // Sensitivity also sets how clean the sound must be: higher = keeps listening
  // through other players. Once locked on a note, slightly messier frames near
  // it still count, so the reading doesn't drop out when the room gets loud.
  const needClarity = 0.93 - (settings.sensitivity - 1) * 0.025; // 0.93 .. 0.705
  const med0 = freqWindow.length ? median(freqWindow) : 0;
  const nearLock = med0 && r.freq && Math.abs(1200 * Math.log2(r.freq / med0)) < 60;
  const ok = r.freq && r.clarity > (nearLock ? needClarity - 0.15 : needClarity);

  let freq = 0;
  if (ok) {
    if (!med0 || nearLock) {
      freqWindow.push(r.freq);
      if (freqWindow.length > 7) freqWindow.shift();
      jumpTo = 0;
      freq = median(freqWindow);
    } else if (jumpTo && Math.abs(1200 * Math.log2(r.freq / jumpTo)) < 60) {
      // A new note, heard twice in a row: switch to it.
      freqWindow = [jumpTo, r.freq];
      jumpTo = 0;
      freq = r.freq;
    } else {
      jumpTo = r.freq; // one stray frame from someone else: ignore unless it repeats
      if (current) freq = current.freq;
    }
  }

  if (freq) {
    const midiF = freqToMidi(freq, groupTarget?.a4 || settings.a4);

    let target;
    if (groupTarget) {
      target = Math.round((midiF - groupTarget.pc) / 12) * 12 + groupTarget.pc; // nearest octave of the host's note
      justOff = 0;
    } else if (stringMidis.length) {
      if (auto) {
        let best = 0;
        stringMidis.forEach((m, i) => { if (Math.abs(midiF - m) < Math.abs(midiF - stringMidis[best])) best = i; });
        selected = best;
      }
      target = stringMidis[selected];
    } else if (settings.justRoot >= 0) {
      // Nearest just-intonation target in the chosen key.
      let best = null;
      for (let n = Math.round(midiF) - 1; n <= Math.round(midiF) + 1; n++) {
        const off = JUST[mod12(n - settings.justRoot)].off / 100;
        const d = Math.abs(midiF - (n + off));
        if (!best || d < best.d) best = { n, d, off };
      }
      target = best.n;
      justOff = best.off * 100;
    } else target = Math.round(midiF);
    if (groupTarget || stringMidis.length || settings.justRoot < 0) justOff = 0;

    const cents = (midiF - target) * 100 - justOff;
    if (target !== lastTarget) { smoothCents = cents; lastTarget = target; inTuneSince = 0; }
    else smoothCents += (cents - smoothCents) * 0.3;
    current = { freq, target, cents: smoothCents, justOff };
    lastHeard = now;
    history[histPos] = smoothCents;
  } else {
    history[histPos] = NaN;
    if (current && now - lastHeard > 900) { current = null; freqWindow = []; jumpTo = 0; }
  }
  histPos = (histPos + 1) % HISTORY_LEN;
  if (current) strobePhase += current.cents * dt * 2.2;
  if (groupTarget) tunerEvents.dispatchEvent(new CustomEvent('reading', { detail: current && { cents: current.cents } }));
  updateReadout(now);
  draw();
}

function updateReadout(now) {
  const disp = $('noteDisplay');
  if (!current) {
    disp.className = 'note-display idle';
    if (groupTarget) $('concertLabel').textContent = sectionLine();
    if (!lastTarget) $('tuneHint').textContent = 'Play a note…';
    return;
  }
  const { cents, freq, target } = current;
  const tr = stringMidis.length ? 0 : transposeOf();
  const { name, octave } = noteLabel(target + tr, settings.noteNames);
  $('noteName').textContent = name;
  $('noteOct').textContent = octave;
  const extra = [];
  if (tr) { const cn = noteLabel(target, settings.noteNames); extra.push(`Concert ${cn.name}${cn.octave}`); }
  if (!stringMidis.length && settings.justRoot >= 0) {
    const j = JUST[mod12(target - settings.justRoot)];
    const o = Math.round(j.off);
    extra.push(`${j.role} of ${pitchClassName(settings.justRoot)}${o ? ` (${o > 0 ? '+' : ''}${o}¢)` : ''}`);
  }
  if (groupTarget) { extra.length = 0; extra.push(sectionLine()); }
  $('concertLabel').textContent = extra.join(' · ');
  const c = Math.round(cents);
  $('centsLabel').textContent = `${c > 0 ? '+' : ''}${c}¢`;
  $('freqLabel').textContent = `${freq.toFixed(1)} Hz`;

  const abs = Math.abs(cents);
  const tol = settings.tolerance;
  let state = abs <= tol ? 'good' : abs <= 15 ? 'close' : 'far';
  disp.className = `note-display ${state}`;
  let hint;
  if (state === 'good') hint = 'In tune';
  else if (abs > 50 && stringMidis.length) hint = cents < 0 ? 'Way too low — tune up ↑' : 'Way too high — tune down ↓';
  else if (isWind()) hint = cents < 0 ? 'Flat — push in ↑' : 'Sharp — pull out ↓';
  else hint = cents < 0 ? 'Flat — tune up ↑' : 'Sharp — tune down ↓';
  $('tuneHint').textContent = hint;

  if (state === 'good') {
    if (!inTuneSince) inTuneSince = now;
    if (stringMidis.length && now - inTuneSince > 700 && !tunedStrings.has(selected)) {
      tunedStrings.add(selected);
      if (settings.vibrate) navigator.vibrate?.(40);
    }
  } else inTuneSince = 0;

  // Re-render strings only when the highlighted one changes.
  const key = `${selected}|${[...tunedStrings].join(',')}`;
  if (key !== renderStrings.key) { renderStrings.key = key; renderStrings(); }
}

// ---------- drawing ----------

function colorFor(cents) {
  if (cents == null) return cssVar('--muted');
  const a = Math.abs(cents);
  return a <= settings.tolerance ? cssVar('--good') : a <= 15 ? cssVar('--close') : cssVar('--far');
}

function draw() {
  if ($('gauge').clientWidth < 60) return; // view hidden
  if (settings.display === 'strobe') drawStrobe(); else drawNeedle();
  drawHistory();
}

function drawNeedle() {
  const { g, w, h: hgt } = sizeCanvas($('gauge'));
  g.clearRect(0, 0, w, hgt);
  const cx = w / 2, cy = hgt - 12;
  const R = Math.min(w / 2 - 16, hgt - 28);
  const span = Math.PI * 0.36;
  const ang = (c) => -Math.PI / 2 + (Math.max(-50, Math.min(50, c)) / 50) * span;
  const fg = cssVar('--text'), muted = cssVar('--muted');

  // in-tune zone
  g.beginPath();
  g.strokeStyle = cssVar('--good');
  g.globalAlpha = 0.35;
  g.lineWidth = 14;
  g.arc(cx, cy, R - 7, ang(-settings.tolerance), ang(settings.tolerance));
  g.stroke();
  g.globalAlpha = 1;

  for (let c = -50; c <= 50; c += 5) {
    const a = ang(c);
    const major = c % 25 === 0;
    const len = major ? 18 : c % 10 === 0 ? 12 : 7;
    g.beginPath();
    g.strokeStyle = major ? fg : muted;
    g.lineWidth = major ? 2.5 : 1.5;
    g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    g.lineTo(cx + Math.cos(a) * (R - len), cy + Math.sin(a) * (R - len));
    g.stroke();
    if (major) {
      g.fillStyle = muted;
      g.font = '600 12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(c > 0 ? `+${c}` : `${c}`, cx + Math.cos(a) * (R + 12), cy + Math.sin(a) * (R + 12) + 4);
    }
  }
  g.fillStyle = muted;
  g.font = '600 13px system-ui, sans-serif';
  g.textAlign = 'left';  g.fillText('♭', cx - R, cy);
  g.textAlign = 'right'; g.fillText('♯', cx + R, cy);

  const cents = current ? current.cents : 0;
  const a = ang(cents);
  g.beginPath();
  g.strokeStyle = current ? colorFor(cents) : muted;
  g.lineCap = 'round';
  g.lineWidth = 4;
  g.moveTo(cx, cy);
  g.lineTo(cx + Math.cos(a) * (R - 22), cy + Math.sin(a) * (R - 22));
  g.stroke();
  g.lineCap = 'butt';
  g.beginPath();
  g.fillStyle = current ? colorFor(cents) : muted;
  g.arc(cx, cy, 8, 0, Math.PI * 2);
  g.fill();
}

function drawStrobe() {
  const { g, w, h: hgt } = sizeCanvas($('gauge'));
  g.clearRect(0, 0, w, hgt);
  const rows = 3, pad = 10;
  const rowH = (hgt - pad * (rows + 1)) / rows;
  const color = current ? colorFor(current.cents) : cssVar('--muted');
  for (let r = 0; r < rows; r++) {
    const y = pad + r * (rowH + pad);
    const period = 48 / (r + 1);
    const speed = r + 1;
    const off = ((strobePhase * speed) % period + period) % period;
    g.save();
    g.beginPath();
    g.roundRect(0, y, w, rowH, 8);
    g.clip();
    g.fillStyle = cssVar('--surface-2');
    g.fillRect(0, y, w, rowH);
    g.fillStyle = color;
    g.globalAlpha = current ? 0.9 : 0.25;
    for (let x = -period + off; x < w; x += period) g.fillRect(x, y, period / 2, rowH);
    g.restore();
  }
}

function drawHistory() {
  const { g, w, h: hgt } = sizeCanvas($('history'));
  g.clearRect(0, 0, w, hgt);
  const mid = hgt / 2;
  const scale = (hgt / 2 - 3) / 50;
  g.fillStyle = cssVar('--good');
  g.globalAlpha = 0.18;
  g.fillRect(0, mid - settings.tolerance * scale, w, settings.tolerance * 2 * scale);
  g.globalAlpha = 1;
  g.strokeStyle = cssVar('--muted');
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();

  g.lineWidth = 2;
  let drawing = false;
  for (let i = 0; i < HISTORY_LEN; i++) {
    const v = history[(histPos + i) % HISTORY_LEN];
    const x = (i / (HISTORY_LEN - 1)) * w;
    if (Number.isNaN(v)) { if (drawing) g.stroke(); drawing = false; continue; }
    const y = mid - Math.max(-50, Math.min(50, v)) * scale;
    if (!drawing) { g.beginPath(); g.strokeStyle = cssVar('--accent'); g.moveTo(x, y); drawing = true; } else g.lineTo(x, y);
  }
  if (drawing) g.stroke();
}

// ---------- init ----------

export function initTuner() {
  tuning = findTuning(settings.tuningId) || DEFAULT_TUNING;
  setTuning(tuning, false);
  updateRefLabel();
  $('autoBtn').addEventListener('click', () => { setAuto(!auto); renderStrings(); });
  $('toneBtn').addEventListener('click', toneButton);
  $('tuningBtn').addEventListener('click', openTuningSheet);
  $('a4Btn').addEventListener('click', openA4Sheet);
  $('gauge').addEventListener('click', () => setSetting('display', settings.display === 'needle' ? 'strobe' : 'needle'));
  onSetting((k) => {
    if (['a4', 'justRoot', 'noteNames'].includes(k)) updateRefLabel();
    if (k === 'tuningId' && settings.tuningId !== tuning.id) {
      const tu = findTuning(settings.tuningId, customTunings);
      if (tu) setTuning(tu, false);
    }
    if (k === 'noteNames') renderStrings();
    if (['display', 'tolerance', 'noteNames'].includes(k)) draw();
  });
  store.addEventListener('change', loadCustomTunings);
  window.addEventListener('resize', draw);
  loadCustomTunings();
  draw();
}

export const tunerRunning = () => running;
