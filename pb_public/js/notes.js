// Note math, naming and the built-in tuning library.

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
// Everyday spelling: flats for band keys (B♭, E♭, A♭), sharps for F♯ and C♯.
const COMMON = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const SOLFEGE = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
const NAME_SETS = { common: COMMON, sharp: SHARP, flat: FLAT, solfege: SOLFEGE };

export const freqToMidi = (f, a4 = 440) => 69 + 12 * Math.log2(f / a4);
export const midiToFreq = (m, a4 = 440) => a4 * Math.pow(2, (m - 69) / 12);

/** Returns { name, octave } for a midi note number. */
export function noteLabel(midi, style = 'common') {
  const m = Math.round(midi);
  const names = NAME_SETS[style] || COMMON;
  return { name: names[((m % 12) + 12) % 12], octave: Math.floor(m / 12) - 1 };
}

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Parses "E2", "F#3", "Bb1", "C♯4" into a midi number, or null. */
export function parseNote(str) {
  const m = /^\s*([A-Ga-g])\s*([#♯b♭]?)\s*(-?\d)\s*$/.exec(str);
  if (!m) return null;
  let n = LETTER[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') n += 1;
  if (m[2] === 'b' || m[2] === '♭') n -= 1;
  return (parseInt(m[3], 10) + 1) * 12 + n;
}

export const TRANSPOSITIONS = [
  { value: 0, label: 'C (concert pitch)' },
  { value: 2, label: 'B♭ (trumpet, clarinet, tenor sax)' },
  { value: 9, label: 'E♭ (alto / bari sax)' },
  { value: 7, label: 'F (French horn)' },
];

const t = (id, instrument, name, notes) => ({ id, instrument, name, notes: notes.split(' ') });

// Band & orchestra instruments: chromatic tuner that shows the WRITTEN note.
// transpose = semitones added to concert pitch to get written pitch
// (e.g. B♭ clarinet: concert B♭ is written C, so +2). low = lowest concert midi,
// used to give the pitch detector a bigger window for low instruments.
const b = (id, instrument, name, transpose, key, low) =>
  ({ id, instrument, name, notes: [], transpose, key, low });

export const BAND = [
  b('piccolo', 'Woodwinds', 'Piccolo', -12, 'C · sounds 8va', 74),
  b('flute', 'Woodwinds', 'Flute', 0, 'C', 59),
  b('altoflute', 'Woodwinds', 'Alto flute', 5, 'G', 55),
  b('oboe', 'Woodwinds', 'Oboe', 0, 'C', 58),
  b('englishhorn', 'Woodwinds', 'English horn', 7, 'F', 52),
  b('bassoon', 'Woodwinds', 'Bassoon', 0, 'C', 34),
  b('contrabassoon', 'Woodwinds', 'Contrabassoon', 12, 'C · sounds 8vb', 22),
  b('clarinet-eb', 'Woodwinds', 'E♭ clarinet', -3, 'E♭', 51),
  b('clarinet', 'Woodwinds', 'B♭ clarinet', 2, 'B♭', 50),
  b('clarinet-a', 'Woodwinds', 'A clarinet', 3, 'A', 49),
  b('altoclarinet', 'Woodwinds', 'E♭ alto clarinet', 9, 'E♭', 43),
  b('bassclarinet', 'Woodwinds', 'B♭ bass clarinet', 14, 'B♭ · sounds 9th lower', 34),
  b('contraaltoclar', 'Woodwinds', 'E♭ contra-alto clarinet', 21, 'E♭', 31),
  b('contrabassclar', 'Woodwinds', 'B♭ contrabass clarinet', 26, 'B♭', 22),
  b('sopranosax', 'Woodwinds', 'B♭ soprano sax', 2, 'B♭', 56),
  b('altosax', 'Woodwinds', 'E♭ alto sax', 9, 'E♭', 49),
  b('tenorsax', 'Woodwinds', 'B♭ tenor sax', 14, 'B♭', 44),
  b('barisax', 'Woodwinds', 'E♭ baritone sax', 21, 'E♭', 36),

  b('trumpet', 'Brass', 'B♭ trumpet / cornet', 2, 'B♭', 52),
  b('flugelhorn', 'Brass', 'Flugelhorn', 2, 'B♭', 52),
  b('cornet-eb', 'Brass', 'E♭ soprano cornet', -3, 'E♭', 55),
  b('horn', 'Brass', 'F horn', 7, 'F', 34),
  b('mellophone', 'Brass', 'Mellophone', 7, 'F', 46),
  b('trombone', 'Brass', 'Trombone', 0, 'C · bass clef', 34),
  b('basstrombone', 'Brass', 'Bass trombone', 0, 'C · bass clef', 28),
  b('euphonium', 'Brass', 'Euphonium / baritone (bass clef)', 0, 'C · bass clef', 28),
  b('baritone-tc', 'Brass', 'Baritone / euphonium (treble clef)', 14, 'B♭', 28),
  b('tuba', 'Brass', 'Tuba / sousaphone', 0, 'C · bass clef', 22),

  b('timpani', 'Percussion', 'Timpani', 0, 'C', 38),
  b('glockenspiel', 'Percussion', 'Glockenspiel / bells', -24, 'C · sounds 2 oct. higher', 79),
  b('xylophone', 'Percussion', 'Xylophone', -12, 'C · sounds 8va', 65),
  b('marimba', 'Percussion', 'Marimba / vibraphone', 0, 'C', 45),
];

export const TUNINGS = [
  t('chromatic', 'Chromatic', 'Chromatic', ''),
  ...BAND,

  t('guitar-standard', 'Guitar', 'Standard', 'E2 A2 D3 G3 B3 E4'),
  t('guitar-dropd', 'Guitar', 'Drop D', 'D2 A2 D3 G3 B3 E4'),
  t('guitar-halfdown', 'Guitar', 'Half step down', 'Eb2 Ab2 Db3 Gb3 Bb3 Eb4'),
  t('guitar-fulldown', 'Guitar', 'Full step down', 'D2 G2 C3 F3 A3 D4'),
  t('guitar-dropcs', 'Guitar', 'Drop C♯', 'C#2 G#2 C#3 F#3 A#3 D#4'),
  t('guitar-dropc', 'Guitar', 'Drop C', 'C2 G2 C3 F3 A3 D4'),
  t('guitar-dropb', 'Guitar', 'Drop B', 'B1 F#2 B2 E3 G#3 C#4'),
  t('guitar-dadgad', 'Guitar', 'DADGAD', 'D2 A2 D3 G3 A3 D4'),
  t('guitar-openg', 'Guitar', 'Open G', 'D2 G2 D3 G3 B3 D4'),
  t('guitar-opend', 'Guitar', 'Open D', 'D2 A2 D3 F#3 A3 D4'),
  t('guitar-opene', 'Guitar', 'Open E', 'E2 B2 E3 G#3 B3 E4'),
  t('guitar-openc', 'Guitar', 'Open C', 'C2 G2 C3 G3 C4 E4'),
  t('guitar-opena', 'Guitar', 'Open A', 'E2 A2 E3 A3 C#4 E4'),
  t('guitar-7', 'Guitar', '7-string standard', 'B1 E2 A2 D3 G3 B3 E4'),
  t('guitar-8', 'Guitar', '8-string standard', 'F#1 B1 E2 A2 D3 G3 B3 E4'),

  t('bass-4', 'Bass', '4-string standard', 'E1 A1 D2 G2'),
  t('bass-dropd', 'Bass', 'Drop D', 'D1 A1 D2 G2'),
  t('bass-halfdown', 'Bass', 'Half step down', 'Eb1 Ab1 Db2 Gb2'),
  t('bass-5', 'Bass', '5-string standard', 'B0 E1 A1 D2 G2'),
  t('bass-6', 'Bass', '6-string standard', 'B0 E1 A1 D2 G2 C3'),

  t('uke-standard', 'Ukulele', 'Standard (high G)', 'G4 C4 E4 A4'),
  t('uke-lowg', 'Ukulele', 'Low G', 'G3 C4 E4 A4'),
  t('uke-d', 'Ukulele', 'D tuning', 'A4 D4 F#4 B4'),
  t('uke-baritone', 'Ukulele', 'Baritone', 'D3 G3 B3 E4'),

  t('violin', 'Strings', 'Violin', 'G3 D4 A4 E5'),
  t('viola', 'Strings', 'Viola', 'C3 G3 D4 A4'),
  t('cello', 'Strings', 'Cello', 'C2 G2 D3 A3'),
  t('doublebass', 'Strings', 'Double bass', 'E1 A1 D2 G2'),

  t('mandolin', 'Folk', 'Mandolin', 'G3 D4 A4 E5'),
  t('banjo-g', 'Folk', 'Banjo open G (5-string)', 'G4 D3 G3 B3 D4'),
  t('banjo-dc', 'Folk', 'Banjo double C', 'G4 C3 G3 C4 D4'),
  t('bouzouki', 'Folk', 'Irish bouzouki', 'G2 D3 A3 D4'),
];

/** Finds a built-in or custom tuning by id. */
export function findTuning(id, custom = []) {
  return TUNINGS.find((x) => x.id === id) || custom.find((x) => x.id === id) || null;
}

export const tuningTitle = (tu) =>
  tu.id === 'chromatic' ? 'Chromatic' : tu.transpose != null ? tu.name : `${tu.instrument} · ${tu.name}`;

// 5-limit just intonation (with a harmonic 7th), in cents relative to equal
// temperament, by interval above the chord/key root.
export const JUST = [
  { off: 0, role: 'root' }, { off: 11.7, role: '♭2' }, { off: 3.9, role: '2nd / 9th' },
  { off: 15.6, role: 'minor 3rd' }, { off: -13.7, role: 'major 3rd' }, { off: -2.0, role: '4th' },
  { off: -9.8, role: 'tritone' }, { off: 2.0, role: '5th' }, { off: 13.7, role: 'minor 6th' },
  { off: -15.6, role: 'major 6th' }, { off: -31.2, role: 'minor 7th' }, { off: -11.7, role: 'major 7th' },
];
