// Optional setup questionnaire: a few questions about how you play, turned into
// tuner + metronome settings. Answers are kept on the device and, when signed in,
// on the account (so a new phone gets the same setup).
import { TUNINGS, BAND, findTuning, noteLabel } from './notes.js';
import { settings, setSetting } from './settings.js';
import { met } from './metronome.js';
import { h, fill, openSheet } from './ui.js';

const LOCAL_KEY = 'tt.profile';

export const ROLES = [
  ['player', 'I play an instrument'],
  ['director', 'I direct a band or orchestra'],
  ['teacher', 'I teach lessons'],
];

export const ENSEMBLES = [
  ['marching', 'Marching band'],
  ['concert', 'Concert / symphonic band'],
  ['orchestra', 'Orchestra'],
  ['jazz', 'Jazz band'],
  ['pep', 'Pep band'],
  ['rock', 'Rock / pop / worship band'],
  ['solo', 'Solo practice'],
];

export const LEVELS = [
  ['beginner', 'Beginner', 'Under 2 years'],
  ['intermediate', 'Intermediate', 'Middle / high school'],
  ['advanced', 'Advanced', 'All-state, college'],
  ['pro', 'Professional', 'Gigging / teaching'],
];

const BAND_IDS = new Set(BAND.map((b) => b.id));
const isBandEnsemble = (p) => p.ensembles.some((e) => ['marching', 'concert', 'pep', 'jazz'].includes(e));

/** Instrument choices: every band instrument, then one entry per other instrument. */
function instrumentGroups() {
  const groups = [['Woodwinds', []], ['Brass', []], ['Percussion', []], ['Strings', []], ['Guitar & more', []]];
  const get = (name) => groups.find(([g]) => g === name)[1];
  for (const b of BAND) get(b.instrument).push([b.id, b.name]);
  for (const id of ['violin', 'viola', 'cello', 'doublebass']) get('Strings').push([id, findTuning(id).name]);
  for (const [id, label] of [['guitar-standard', 'Guitar'], ['bass-4', 'Bass guitar'], ['uke-standard', 'Ukulele'],
    ['mandolin', 'Mandolin'], ['banjo-g', 'Banjo'], ['chromatic', 'Piano, voice or other']]) get('Guitar & more').push([id, label]);
  return groups;
}

export function loadLocalProfile() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch { return null; }
}

/** Turns answers into settings, applies them, and returns a readable summary. */
export function applyProfile(p) {
  const done = [];
  const primary = ENSEMBLES.map(([id]) => id).find((id) => p.ensembles.includes(id)) || 'solo';
  const director = p.role === 'director';

  // --- tuner ---
  const instrument = findTuning(p.instrument) ? p.instrument : 'chromatic';
  const tu = findTuning(instrument);
  setSetting('tuningId', instrument);
  done.push(`Tuner set to ${tu.id === 'chromatic' ? 'chromatic (concert pitch)' : tu.name}${tu.transpose ? ', showing your written notes' : ''}`);

  setSetting('a4', p.a4 || 440);
  done.push(`Tuned to A = ${p.a4 || 440} Hz`);

  const tol = { beginner: 5, intermediate: 3, advanced: 2, pro: 1 }[p.level] ?? 3;
  setSetting('tolerance', tol);
  done.push(`"In tune" means within ±${tol}¢${p.level === 'beginner' ? ' (relaxed while you build your ear)' : ''}`);

  setSetting('noteNames', p.solfege ? 'solfege' : 'common');
  if (p.solfege) done.push('Notes shown as Do Re Mi');

  if (p.justHints) {
    const root = isBandEnsemble(p) || director ? 10 : 0; // concert B♭ for bands, C otherwise
    setSetting('justRoot', root);
    done.push(`Chord-tuning hints on, in concert ${noteLabel(60 + root, 'common').name} (change under A4 = …)`);
  } else setSetting('justRoot', -1);

  setSetting('droneFifth', director || p.justHints);
  setSetting('playOnTap', !BAND_IDS.has(instrument));

  // --- metronome ---
  const state = met.getState();
  let sound = 'click';
  if (primary === 'marching') {
    Object.assign(state, { countIn: 8, bpm: 120 });
    sound = 'cowbell';
    done.push('Metronome: loud cowbell with an 8-count count-in (set drill length under Practice)');
  } else if (primary === 'concert' || primary === 'orchestra') {
    Object.assign(state, { countIn: state.beats });
    sound = 'wood';
    done.push('Metronome: woodblock with a 1-bar count-in');
  } else if (primary === 'jazz') {
    Object.assign(state, { beats: 4, noteValue: 4, accents: [2, 3, 2, 3], subdivision: 'swing', countIn: 4 });
    sound = 'hihat';
    done.push('Metronome: hi-hat accenting 2 and 4, swing feel');
  } else if (primary === 'pep' || primary === 'rock') {
    sound = 'drums';
    Object.assign(state, { countIn: 4 });
    done.push('Metronome: drum kit with a 4-count count-in');
  }
  state.sound = sound;
  if (p.level === 'beginner' && primary !== 'marching') {
    state.bpm = 72;
    done.push('Starting tempo 72 BPM; try the speed trainer under Practice');
  }
  met.setState(state);

  setSetting('flash', !!p.flash);
  setSetting('vibrate', !!p.vibrate);
  if (p.flash) done.push('Screen flashes on the beat');
  if (p.vibrate) done.push('Phone vibrates on the beat (Android)');

  localStorage.setItem(LOCAL_KEY, JSON.stringify(p));
  return done;
}

/**
 * Opens the questionnaire. onFinish(profile) is called after the user applies it.
 * Everything is optional; closing the sheet at any point skips it.
 */
export function openQuestionnaire({ onFinish, intro } = {}) {
  const prev = loadLocalProfile();
  const p = {
    role: prev?.role || 'player',
    instrument: prev?.instrument || settings.tuningId || 'chromatic',
    ensembles: prev?.ensembles || [],
    level: prev?.level || 'intermediate',
    a4: prev?.a4 || settings.a4 || 440,
    justHints: prev?.justHints ?? false,
    flash: prev?.flash ?? settings.flash,
    vibrate: prev?.vibrate ?? settings.vibrate,
    solfege: prev?.solfege ?? settings.noteNames === 'solfege',
    version: 1,
  };
  let step = 0;
  let a4Touched = !!prev;
  const body = h('div', { class: 'quiz' });
  const sheet = openSheet('Personalize TempoTune', body);

  const choice = (value, label, sub, selected, onPick, cls = 'quiz-opt') => h('button', {
    class: cls + (selected ? ' on' : ''), type: 'button', 'aria-pressed': selected,
    onclick: () => { onPick(value); render(); },
  }, h('b', {}, label), sub && h('small', {}, sub));

  const toggle = (key, label, sub) => h('label', { class: 'field row toggle-row quiz-toggle' },
    h('span', { class: 'set-label' }, label, sub && h('small', {}, sub)),
    h('input', { type: 'checkbox', class: 'switch', checked: p[key], onchange: (e) => { p[key] = e.target.checked; } }));

  const steps = [
    () => [
      h('h3', { class: 'quiz-q' }, 'What best describes you?'),
      intro && h('p', { class: 'hint' }, intro),
      h('div', { class: 'quiz-list' }, ROLES.map(([v, l]) => choice(v, l, null, p.role === v, (x) => {
        p.role = x;
        if (x === 'director' && !prev) { p.instrument = 'chromatic'; p.justHints = true; }
      }))),
    ],
    () => [
      h('h3', { class: 'quiz-q' }, p.role === 'director' ? 'What do you mostly tune?' : 'What do you play?'),
      p.role === 'director' && h('p', { class: 'hint' }, 'Pick "Piano, voice or other" to tune the whole ensemble in concert pitch.'),
      instrumentGroups().map(([group, list]) => [
        h('div', { class: 'quiz-group' }, group),
        h('div', { class: 'chips' }, list.map(([id, label]) =>
          choice(id, label, null, p.instrument === id, (x) => { p.instrument = x; }, 'chip'))),
      ]),
    ],
    () => [
      h('h3', { class: 'quiz-q' }, 'Which groups do you play in?'),
      h('p', { class: 'hint' }, 'Pick all that apply. The first one sets up your metronome.'),
      h('div', { class: 'quiz-list' }, ENSEMBLES.map(([v, l]) => choice(v, l, null, p.ensembles.includes(v), (x) => {
        p.ensembles = p.ensembles.includes(x) ? p.ensembles.filter((e) => e !== x) : [...p.ensembles, x];
        if (!a4Touched) p.a4 = p.ensembles.includes('orchestra') && !isBandEnsemble(p) ? 442 : 440;
        if (x === 'marching' && p.ensembles.includes('marching') && !prev) p.flash = true;
      }))),
    ],
    () => [
      h('h3', { class: 'quiz-q' }, 'How long have you been playing?'),
      h('div', { class: 'quiz-list' }, LEVELS.map(([v, l, sub]) => choice(v, l, sub, p.level === v, (x) => {
        p.level = x;
        if (!prev && (x === 'advanced' || x === 'pro') && p.ensembles.some((e) => ['concert', 'orchestra'].includes(e))) p.justHints = true;
      }))),
    ],
    () => [
      h('h3', { class: 'quiz-q' }, 'What A does your group tune to?'),
      h('p', { class: 'hint' }, 'Most bands use 440. Many orchestras use 442. Ask your director if unsure.'),
      h('div', { class: 'chips' }, [440, 441, 442, 443].map((f) =>
        choice(f, `${f} Hz`, null, p.a4 === f, (x) => { p.a4 = x; a4Touched = true; }, 'chip'))),
    ],
    () => [
      h('h3', { class: 'quiz-q' }, 'A few extras'),
      toggle('justHints', 'Chord-tuning hints', 'Shows how to bend notes for pure chords (just intonation)'),
      toggle('flash', 'Flash the screen on the beat', 'Easy to see on a field or in a loud room'),
      toggle('vibrate', 'Vibrate on the beat', 'Android only'),
      toggle('solfege', 'Show notes as Do Re Mi', null),
    ],
  ];

  function summary() {
    // Preview what will change, without applying yet.
    const tu = findTuning(p.instrument) || TUNINGS[0];
    const ens = ENSEMBLES.filter(([id]) => p.ensembles.includes(id)).map(([, l]) => l);
    return [
      h('h3', { class: 'quiz-q' }, 'Ready to set things up'),
      h('ul', { class: 'quiz-summary' },
        h('li', {}, h('b', {}, 'Instrument: '), tu.id === 'chromatic' ? 'Chromatic (concert pitch)' : tu.name),
        ens.length > 0 && h('li', {}, h('b', {}, 'Groups: '), ens.join(', ')),
        h('li', {}, h('b', {}, 'Level: '), LEVELS.find(([v]) => v === p.level)[1]),
        h('li', {}, h('b', {}, 'Tuning: '), `A = ${p.a4} Hz`)),
      h('p', { class: 'hint' }, 'You can change anything later in Settings, or retake this from there.'),
    ];
  }

  function render() {
    const total = steps.length;
    const last = step === total;
    fill(body, 
      h('div', { class: 'quiz-progress', 'aria-label': `Step ${Math.min(step + 1, total)} of ${total}` },
        Array.from({ length: total + 1 }, (_, i) => h('i', { class: i <= step ? 'on' : '' }))),
      h('div', { class: 'quiz-step' }, last ? summary() : steps[step]()),
      h('div', { class: 'quiz-nav' },
        step > 0 ? h('button', { class: 'ghost', type: 'button', onclick: () => { step--; render(); } }, 'Back')
          : h('button', { class: 'ghost', type: 'button', onclick: () => sheet.close() }, 'Skip'),
        last
          ? h('button', { class: 'primary', type: 'button', onclick: finish }, 'Apply my settings')
          : h('button', { class: 'primary', type: 'button', onclick: () => { step++; render(); } }, 'Next')));
    body.closest('.sheet-body')?.scrollTo(0, 0);
  }

  function finish() {
    const done = applyProfile(p);
    fill(body, 
      h('h3', { class: 'quiz-q' }, 'All set'),
      h('ul', { class: 'quiz-summary' }, done.map((d) => h('li', {}, d))),
      h('button', { class: 'primary wide', type: 'button', onclick: () => sheet.close() }, 'Start playing'));
    onFinish?.(p);
  }

  render();
  return sheet;
}

/** One-line description of a saved profile for the Settings page. */
export function describeProfile(p) {
  if (!p) return null;
  const tu = findTuning(p.instrument);
  const ens = ENSEMBLES.filter(([id]) => p.ensembles?.includes(id)).map(([, l]) => l.split(' /')[0]);
  const level = LEVELS.find(([v]) => v === p.level)?.[1];
  return [tu && (tu.id === 'chromatic' ? 'Chromatic' : tu.name), ens.join(', '), level].filter(Boolean).join(' · ');
}
