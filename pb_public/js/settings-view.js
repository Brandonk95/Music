// Settings tab: account (PocketBase), tuner and metronome preferences.
import { settings, setSetting } from './settings.js';
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

const row = (label, control, hint) => h('div', { class: 'set-row' },
  h('div', { class: 'set-label' }, label, hint && h('small', {}, hint)), control);

const rangeRow = (label, key, min, max, step, fmt, hint) => {
  const [out, input] = range(key, min, max, step, fmt);
  return h('div', { class: 'set-row stack' },
    h('div', { class: 'set-label' }, h('span', {}, label, ' ', out), hint && h('small', {}, hint)), input);
};

async function accountSection() {
  const box = h('div', { class: 'card' }, h('p', { class: 'hint' }, 'Checking server…'));
  const online = await store.health();
  const status = h('div', { class: 'status ' + (online ? 'ok' : 'off') }, online ? 'Server connected' : 'Server offline — using this device only');

  if (store.loggedIn) {
    const local = store.localCount();
    fill(box, status,
      h('p', {}, 'Signed in as ', h('b', {}, store.user?.email || 'user')),
      h('p', { class: 'hint' }, 'Presets, setlists and custom tunings sync to your PocketBase account.'),
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
    h('h2', { class: 'section' }, 'Account'),
    account,

    h('h2', { class: 'section' }, 'Your setup'),
    setupSection(),

    h('h2', { class: 'section' }, 'Tuner'),
    h('div', { class: 'card' },
      rangeRow('Calibration A4', 'a4', 415, 466, 0.5, (v) => `${v} Hz`),
      row('Note names', select('noteNames', [['common', 'B♭ E♭ F♯ (common)'], ['sharp', 'C♯ (all sharps)'], ['flat', 'D♭ (all flats)'], ['solfege', 'Do Re Mi']])),
      row('Transposition', select('transpose', TRANSPOSITIONS.map((t) => [t.value, t.label]), { num: true }), 'For plain Chromatic mode. Band instruments set their own.'),
      row('Temperament', select('justRoot', [[-1, 'Equal'], ...[10, 11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((pc) =>
        [pc, `Just in ${noteLabel(60 + pc, settings.noteNames).name}`])], { num: true }), 'Concert key for pure chords'),
      row('Display', select('display', [['needle', 'Needle'], ['strobe', 'Strobe']]), 'Tap the meter to switch'),
      rangeRow('In-tune range', 'tolerance', 1, 10, 1, (v) => `±${v}¢`),
      rangeRow('Mic sensitivity', 'sensitivity', 1, 10, 1, (v) => v, 'Lower it in noisy rooms'),
      row('Reference tone', select('toneTimbre', [['pluck', 'Plucked string'], ['soft', 'Soft organ'], ['sine', 'Pure sine']])),
      rangeRow('Tone volume', 'toneVolume', 0.1, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      row('Play note when tapping a string', toggle('playOnTap'))),

    h('h2', { class: 'section' }, 'Metronome'),
    h('div', { class: 'card' },
      row('Flash screen on beat', toggle('flash')),
      row('Vibrate on beat', toggle('vibrate'), 'Android only'),
      rangeRow('Visual delay', 'visualOffset', -100, 300, 5, (v) => `${v} ms`, 'Raise if lights run ahead of the sound (Bluetooth)')),

    h('h2', { class: 'section' }, 'General'),
    h('div', { class: 'card' },
      row('Keep screen awake while running', toggle('keepAwake')),
      h('div', { class: 'set-row stack' },
        h('div', { class: 'set-label' }, 'Server URL', h('small', {}, 'Leave blank when PocketBase serves this app')),
        h('input', { class: 'text-input', placeholder: location.origin, value: settings.serverUrl, inputmode: 'url',
          onchange: (e) => { setSetting('serverUrl', e.target.value.trim()); render(); } }))),
    h('p', { class: 'hint center' }, 'TempoTune · no ads, no tracking'));
}

export function initSettingsView() {
  store.addEventListener('change', () => { if ($('view-settings').classList.contains('active')) render(); });
  return render;
}
