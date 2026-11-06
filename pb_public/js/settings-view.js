// Settings tab: account, tuner and metronome preferences.
import { settings, setSetting, resetSettings } from './settings.js';
import { installHelp, installMode, installEvents } from './install.js';
import { store } from './store.js';
import { TRANSPOSITIONS, noteLabel } from './notes.js';
import { h, fill, $, toast } from './ui.js';
import { openQuestionnaire, loadLocalProfile, describeProfile } from './personalize.js';

function select(key, options, { num = false } = {}) {
  return h('select', { class: 'select', onchange: (e) => setSetting(key, num ? +e.target.value : e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: settings[key] === v }, label)));
}

function range(key, min, max, step, fmt = (v) => v) {
  const out = h('b', {}, fmt(settings[key]));
  return [out, h('input', { type: 'range', min, max, step, value: settings[key],
    oninput: (e) => { setSetting(key, +e.target.value); out.textContent = fmt(+e.target.value); } })];
}

function toggle(key) {
  return h('input', { type: 'checkbox', class: 'switch', checked: settings[key], onchange: (e) => setSetting(key, e.target.checked) });
}

/** A row of chips for picking one value. Highlights the current one (none if it's a custom value). */
function choice(key, options) {
  const box = h('div', { class: 'chips seg' });
  const draw = () => fill(box, options.map(([v, label]) => h('button', {
    class: 'chip' + (settings[key] === v ? ' on' : ''), type: 'button',
    onclick: () => { setSetting(key, v); draw(); },
  }, label)));
  draw();
  return box;
}

/** − value + buttons, for numbers that need exact values (like A4). */
function stepper(key, min, max, step, fmt, reset) {
  const out = h('b', { class: 'step-val' });
  const set = (v) => { v = Math.round(Math.min(max, Math.max(min, v)) / step) * step; setSetting(key, v); out.textContent = fmt(v); };
  out.textContent = fmt(settings[key]);
  return h('div', { class: 'stepper-row' },
    h('button', { class: 'round', type: 'button', 'aria-label': 'Lower', onclick: () => set(settings[key] - step) }, '−'),
    out,
    h('button', { class: 'round', type: 'button', 'aria-label': 'Higher', onclick: () => set(settings[key] + step) }, '+'),
    reset != null && h('button', { class: 'chip', type: 'button', onclick: () => set(reset) }, `Reset ${fmt(reset)}`));
}

const stackRow = (label, control, hint) => h('div', { class: 'set-row stack' },
  h('div', { class: 'set-label' }, label, hint && h('small', {}, hint)), control);

const row = (label, control, hint) => h('div', { class: 'set-row' },
  h('div', { class: 'set-label' }, label, hint && h('small', {}, hint)), control);

const rangeRow = (label, key, min, max, step, fmt, hint) => {
  const [out, input] = range(key, min, max, step, fmt);
  return h('div', { class: 'set-row stack' },
    h('div', { class: 'set-label' }, h('span', {}, label, ' ', out), hint && h('small', {}, hint)), input);
};

async function accountSection() {
  const box = h('div', { class: 'card' }, h('p', { class: 'hint' }, 'Checking connection…'));
  const online = await store.health();
  const status = h('div', { class: 'status ' + (online ? 'ok' : 'off') }, online ? 'Online' : 'Offline: using this device only');

  if (store.loggedIn) {
    const local = store.localCount();
    fill(box, status,
      h('p', {}, 'Signed in as ', h('b', {}, store.user?.email || 'user')),
      h('p', { class: 'hint' }, 'Presets, setlists and custom tunings sync to your account.'),
      local > 0 && h('button', { class: 'primary wide', onclick: async () => {
        try { const n = await store.uploadLocal(); toast(`Moved ${n} item(s) to your account`); render(); } catch (e) { toast(e.message); }
      } }, `Upload ${local} item(s) saved on this device`),
      h('button', { class: 'ghost wide', onclick: () => { store.logout(); render(); } }, 'Sign out'));
    return box;
  }

  const email = h('input', { class: 'text-input', type: 'email', placeholder: 'Email', autocomplete: 'email', required: true });
  const pass = h('input', { class: 'text-input', type: 'password', placeholder: 'Password (8+ characters)', autocomplete: 'current-password', minlength: 8, required: true });
  const submit = async (mode) => {
    if (!email.value || pass.value.length < 8) return toast('Enter an email and a password of 8+ characters');
    try {
      if (mode === 'signup') {
        await store.signup(email.value.trim(), pass.value);
        render();
        openQuestionnaire({
          intro: 'Account created! Answer a few optional questions and we\'ll set up the tuner and metronome for you. Takes about a minute — or skip.',
          onFinish: saveAnswers,
        });
        return;
      }
      await store.login(email.value.trim(), pass.value);
      toast('Signed in');
      render();
    } catch (e) { toast(e.message, 4000); }
  };
  fill(box, status,
    h('p', { class: 'hint' }, 'Optional. Sign in to sync presets, setlists and tunings between your devices.'),
    h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); submit('login'); } },
      email, pass,
      h('div', { class: 'chips' },
        h('button', { class: 'primary', type: 'submit', disabled: !online }, 'Sign in'),
        h('button', { class: 'ghost', type: 'button', disabled: !online, onclick: () => submit('signup') }, 'Create account'))));
  return box;
}

async function saveAnswers(profile) {
  try { await store.saveProfile(profile); } catch (e) { toast(`Saved on this device only: ${e.message}`, 4000); }
  render();
}

function setupSection() {
  const profile = store.profile || loadLocalProfile();
  return h('div', { class: 'card' },
    h('p', {}, profile ? describeProfile(profile) : 'Tell us what you play and we\'ll pick good tuner and metronome settings for you.'),
    h('button', { class: profile ? 'ghost wide' : 'primary wide', onclick: () => openQuestionnaire({ onFinish: saveAnswers }) },
      profile ? 'Retake setup questions' : 'Personalize (1 minute)'));
}

async function render() {
  const root = $('settingsBody');
  const account = await accountSection();
  fill(root, 
    installMode() !== 'installed' && h('h2', { class: 'section' }, 'Install app'),
    installMode() !== 'installed' && h('div', { class: 'card' },
      h('p', {}, 'Add TempoTune to your home screen: it opens full screen like a normal app and works offline.'),
      installHelp()),

    h('h2', { class: 'section' }, 'Account'),
    account,

    h('h2', { class: 'section' }, 'Your setup'),
    setupSection(),

    h('h2', { class: 'section' }, 'Tuner'),
    h('div', { class: 'card' },
      row('Note names', select('noteNames', [['common', 'B♭ E♭ F♯ (common)'], ['sharp', 'C♯ (all sharps)'], ['flat', 'D♭ (all flats)'], ['solfege', 'Do Re Mi']])),
      row('Transposition', select('transpose', TRANSPOSITIONS.map((t) => [t.value, t.label]), { num: true }), 'For plain Chromatic mode. Band instruments set their own.'),
      stackRow('Where are you playing?', choice('sensitivity', [[4, 'Quiet room'], [6, 'Normal'], [9, 'Band room']]),
        'Band room keeps listening through other players. A quiet room never shows background noise.'),
      stackRow('How close counts as in tune', choice('tolerance', [[2, '±2¢ strict'], [3, '±3¢'], [5, '±5¢'], [10, '±10¢ relaxed']])),
      stackRow('Tuning pitch (A4)', stepper('a4', 415, 466, 0.5, (v) => `${v} Hz`, 440), 'Most bands use 440. Some orchestras use 442.')),

    h('h2', { class: 'section' }, 'Reference tone'),
    h('div', { class: 'card' },
      row('Sound', select('toneTimbre', [['pluck', 'Plucked string'], ['soft', 'Soft organ'], ['sine', 'Pure sine']])),
      rangeRow('Volume', 'toneVolume', 0.1, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      row('Play the note when I tap a string', toggle('playOnTap'))),

    h('h2', { class: 'section' }, 'Metronome'),
    h('div', { class: 'card' },
      row('Flash the screen on each beat', toggle('flash')),
      'vibrate' in navigator && row('Vibrate on each beat', toggle('vibrate')),
      rangeRow('Light delay', 'visualOffset', -100, 300, 5, (v) => `${v} ms`, 'Only if the flashes run ahead of the sound, e.g. with Bluetooth speakers or headphones')),

    h('h2', { class: 'section' }, 'General'),
    h('div', { class: 'card' },
      row('Keep the screen on while playing or tuning', toggle('keepAwake'))),

    h('details', { class: 'card advanced' },
      h('summary', {}, 'Advanced'),
      row('Temperament', select('justRoot', [[-1, 'Equal'], ...[10, 11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((pc) =>
        [pc, `Just in ${noteLabel(60 + pc, settings.noteNames).name}`])], { num: true }), 'Concert key for pure chords'),
      row('Meter style', select('display', [['needle', 'Needle'], ['strobe', 'Strobe']]), 'You can also tap the meter to switch'),
      rangeRow('Exact mic sensitivity', 'sensitivity', 1, 10, 1, (v) => v, 'Fine-tunes “Where are you playing?” above'),
      h('button', { class: 'ghost wide danger', type: 'button', onclick: () => {
        if (!confirm('Reset all tuner and metronome settings to their defaults? Your account, presets and setlists stay.')) return;
        resetSettings();
        render();
        toast('Settings reset');
      } }, 'Reset settings to defaults')),
    h('p', { class: 'hint center' }, 'TempoTune · no ads, no tracking'));
}

export function initSettingsView() {
  store.addEventListener('change', () => { if ($('view-settings').classList.contains('active')) render(); });
  installEvents.addEventListener('change', () => { if ($('view-settings').classList.contains('active')) render(); });
  return render;
}
