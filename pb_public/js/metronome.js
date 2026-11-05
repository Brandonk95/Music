// Metronome view: tempo controls, beat accents, subdivisions, trainers, presets, setlists.
import { Metronome, SUBDIVISIONS, tempoName } from './metronome-engine.js';
import { SOUNDS } from './sounds.js';
import { settings } from './settings.js';
import { store } from './store.js';
import { wake } from './wakelock.js';
import { h, fill, $, toast, openSheet, askText, holdRepeat } from './ui.js';

const STATE_KEY = 'tt.metronome';
export const met = new Metronome();

let setlist = null; // { item, index }
let taps = [];
let rafId = null;
let practice = { elapsed: 0, since: null, limitMin: 0 };

// ---------- rendering ----------

function renderBeats() {
  const wrap = $('beats');
  if (wrap.children.length !== met.beats) {
    fill(wrap, ...met.accents.map((_, i) => h('button', {
      class: 'beat', dataset: { i }, onclick: () => met.cycleAccent(i), 'aria-label': `Beat ${i + 1} accent`,
    }, h('i'), h('i'), h('i'), h('span', { class: 'beat-num' }, i + 1))));
  }
  [...wrap.children].forEach((el, i) => { el.dataset.level = met.accents[i]; });
  wrap.dataset.count = met.beats;
}

function render() {
  $('bpmValue').textContent = Number.isInteger(met.bpm) ? met.bpm : met.bpm.toFixed(1);
  $('bpmSlider').value = met.bpm;
  $('tempoName').textContent = tempoName(met.bpm);
  $('tsLabel').textContent = `${met.beats}/${met.noteValue}`;
  const sub = met.pattern;
  $('subLabel').textContent = sub.label;
  $('soundLabel').textContent = SOUNDS.find((s) => s.id === met.sound)?.name || 'Click';
  const extras = [met.drillCounts && `Set ${met.drillCounts}`, met.trainer.enabled && 'Speed', met.gap.enabled && 'Gap',
    met.randomMute > 0 && 'Random', met.countIn && `In ${met.countIn}`].filter(Boolean);
  $('trainerLabel').textContent = extras.length ? extras.join(' · ') : 'Off';
  renderBeats();
  localStorage.setItem(STATE_KEY, JSON.stringify(met.getState()));
}

function renderTransport() {
  $('playBtn').classList.toggle('on', met.playing);
  $('playBtn').setAttribute('aria-label', met.playing ? 'Stop' : 'Play');
  $('playIcon').textContent = met.playing ? '■' : '▶';
  if (met.playing) {
    wake.request('metronome');
    practice.since = performance.now();
    loop();
  } else {
    wake.release('metronome');
    if (practice.since) practice.elapsed += performance.now() - practice.since;
    practice.since = null;
    cancelAnimationFrame(rafId);
    document.querySelectorAll('.beat.now').forEach((b) => b.classList.remove('now'));
    $('countInLabel').textContent = '';
    updateTimer();
  }
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : mm) + `:${String(ss).padStart(2, '0')}`;
}

function practiceMs() {
  return practice.elapsed + (practice.since ? performance.now() - practice.since : 0);
}

function updateTimer() {
  const ms = practiceMs();
  if (practice.limitMin) {
    const left = practice.limitMin * 60000 - ms;
    $('timerLabel').textContent = '⏱ ' + fmtTime(Math.max(0, left));
    if (left <= 0 && met.playing) {
      met.stop();
      practice.limitMin = 0;
      toast('Practice timer finished');
      navigator.vibrate?.([200, 100, 200]);
    }
  } else $('timerLabel').textContent = fmtTime(ms);
}

function loop() {
  rafId = requestAnimationFrame(loop);
  const due = met.takeDueEvents(settings.visualOffset / 1000);
  for (const ev of due) {
    if (!ev.main) continue;
    const beats = $('beats').children;
    for (const b of beats) b.classList.remove('now');
    const el = beats[ev.beat];
    if (el) {
      el.classList.add('now');
      el.classList.toggle('silent', ev.silent);
      el.classList.toggle('counting', ev.counting);
    }
    if (!ev.silent) {
      if (settings.flash) {
        const f = $('flash');
        f.className = ev.level === 3 ? 'flash strong' : 'flash';
        void f.offsetWidth; // restart animation
        f.classList.add('go');
      }
      if (settings.vibrate) navigator.vibrate?.(ev.level === 3 ? 35 : 15);
    }
    const status = $('countInLabel');
    status.textContent = ev.counting ? `Count-in ${ev.countIn}`
      : met.drillCounts ? `Count ${ev.count} of ${met.drillCounts}` : `Bar ${ev.bar + 1}`;
    status.classList.toggle('counting', ev.counting);

  }
  updateTimer();
}

// ---------- tempo input ----------

function bumpBpm(d) { met.setBpm(Math.round(met.bpm) + d); }

function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 6) taps.shift();
  $('tapBtn').classList.remove('pulse');
  void $('tapBtn').offsetWidth;
  $('tapBtn').classList.add('pulse');
  if (taps.length >= 2) {
    const intervals = taps.slice(1).map((t, i) => t - taps[i]);
    const avg = intervals.reduce((a, b) => a + b) / intervals.length;
    met.setBpm(Math.round(60000 / avg));
  }
}

function enableBpmDrag() {
  const el = $('bpmValue');
  let startY = null, startX = null, startBpm = 0, moved = false;
  el.addEventListener('pointerdown', (e) => {
    startY = e.clientY; startX = e.clientX; startBpm = met.bpm; moved = false;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    const d = (startY - e.clientY) + (e.clientX - startX);
    if (Math.abs(d) > 6) moved = true;
    if (moved) met.setBpm(Math.round(startBpm + d / 6));
  });
  el.addEventListener('pointerup', async () => {
    startY = null;
    if (moved) return;
    const v = await askText('Tempo (BPM)', { value: String(met.bpm), inputmode: 'decimal', ok: 'Set' });
    if (v && Number.isFinite(+v)) met.setBpm(+v);
  });
  el.addEventListener('pointercancel', () => { startY = null; });
}

// ---------- sheets ----------

function openTimeSigSheet() {
  const content = h('div', {});
  const draw = () => {
    const minus = h('button', { class: 'round', 'aria-label': 'Fewer beats' }, '−');
    const plus = h('button', { class: 'round', 'aria-label': 'More beats' }, '+');
    minus.onclick = () => { met.setBeats(Math.max(1, met.beats - 1)); draw(); };
    plus.onclick = () => { met.setBeats(Math.min(16, met.beats + 1)); draw(); };
    fill(content, 
      h('div', { class: 'stepper' }, minus, h('div', { class: 'big-value' }, `${met.beats} beats`), plus),
      h('label', { class: 'field' }, 'Beat unit',
        h('div', { class: 'seg' }, [2, 4, 8, 16].map((v) => h('button', {
          class: met.noteValue === v ? 'on' : '', onclick: () => { met.noteValue = v; met._emit('change'); draw(); },
        }, `/${v}`)))),
      h('h3', {}, 'Common'),
      h('div', { class: 'chips' }, ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8'].map((ts) => {
        const [b, n] = ts.split('/').map(Number);
        return h('button', {
          class: 'chip' + (met.beats === b && met.noteValue === n ? ' on' : ''),
          onclick: () => {
            const acc = Array.from({ length: b }, (_, i) => (i === 0 ? 3 : n === 8 && b % 3 === 0 && i % 3 === 0 ? 3 : 2));
            met.setBeats(b, acc);
            met.noteValue = n;
            met._emit('change');
            draw();
          },
        }, ts);
      })),
      h('p', { class: 'hint' }, 'Tip: tap the beat bars to cycle accent → normal → soft → silent.'));
  };
  draw();
  openSheet('Time signature', content);
}

function openSubdivisionSheet() {
  const grid = h('div', { class: 'sub-grid' });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: met.subVolume, oninput: (e) => { met.subVolume = +e.target.value; render(); } });
  const draw = () => fill(grid, ...SUBDIVISIONS.map((s) => h('button', {
    class: 'sub-btn' + (met.subdivision === s.id ? ' on' : ''),
    onclick: () => { met.subdivision = s.id; met._emit('change'); draw(); },
  }, h('b', {}, s.label), h('small', {}, s.name))));
  draw();
  openSheet('Subdivision', h('div', {}, grid, h('label', { class: 'field' }, 'Subdivision volume', vol)));
}

function openSoundSheet() {
  const list = h('div', { class: 'sub-grid' });
  const draw = () => fill(list, ...SOUNDS.map((s) => h('button', {
    class: 'sub-btn' + (met.sound === s.id ? ' on' : ''),
    onclick: () => { met.setSound(s.id); met.preview(s.id); draw(); },
  }, h('b', {}, s.name))));
  draw();
  openSheet('Sound', h('div', {}, list,
    h('label', { class: 'field' }, 'Volume',
      h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: met.volume, oninput: (e) => { met.volume = +e.target.value; render(); } }))));
}

function numField(label, value, onChange, { min = 1, max = 400, step = 1 } = {}) {
  return h('label', { class: 'field row' }, label,
    h('input', { type: 'number', class: 'num-input', inputmode: 'numeric', min, max, step, value,
      onchange: (e) => { const v = Math.min(max, Math.max(min, +e.target.value || min)); e.target.value = v; onChange(v); } }));
}

function toggleField(label, checked, onChange) {
  return h('label', { class: 'field row toggle-row' }, label,
    h('input', { type: 'checkbox', class: 'switch', checked, onchange: (e) => onChange(e.target.checked) }));
}

function openTrainerSheet() {
  const tr = met.trainer, g = met.gap;
  const changed = () => met._emit('change');
  const chipGroup = (options, get, set) => {
    const wrap = h('div', { class: 'chips' });
    const draw = () => fill(wrap, ...options.map(([v, label]) => h('button', {
      class: 'chip' + (get() === v ? ' on' : ''), onclick: () => { set(v); changed(); draw(); },
    }, label)));
    draw();
    return wrap;
  };
  openSheet('Practice tools', h('div', { class: 'form' },
    h('h3', {}, 'Count-in'),
    chipGroup([[0, 'Off'], [met.beats, '1 bar'], [met.beats * 2, '2 bars'], [4, '4 counts'], [8, '8 counts']],
      () => met.countIn, (v) => { met.countIn = v; }),

    h('h3', {}, 'Drill set length'),
    h('p', { class: 'hint' }, 'Stops automatically after this many counts, for running marching drill sets.'),
    chipGroup([[0, 'Off'], [8, '8'], [16, '16'], [24, '24'], [32, '32'], [48, '48'], [64, '64']],
      () => met.drillCounts, (v) => { met.drillCounts = v; }),
    numField('Custom counts', met.drillCounts, (v) => { met.drillCounts = v; changed(); }, { min: 0, max: 999 }),

    h('h3', {}, 'Speed trainer'),
    h('p', { class: 'hint' }, 'Starts at the current tempo and steps toward the target.'),
    toggleField('Enabled', tr.enabled, (v) => { tr.enabled = v; changed(); }),
    numField('Target BPM', tr.target, (v) => { tr.target = v; changed(); }, { min: 20, max: 400 }),
    numField('Change by (BPM)', tr.step, (v) => { tr.step = v; changed(); }, { min: 1, max: 50 }),
    numField('Every (bars)', tr.everyBars, (v) => { tr.everyBars = v; changed(); }, { min: 1, max: 64 }),

    h('h3', {}, 'Gap trainer'),
    h('p', { class: 'hint' }, 'Plays some bars, then goes silent so you keep time on your own.'),
    toggleField('Enabled', g.enabled, (v) => { g.enabled = v; changed(); }),
    numField('Play (bars)', g.play, (v) => { g.play = v; changed(); }, { min: 1, max: 32 }),
    numField('Mute (bars)', g.mute, (v) => { g.mute = v; changed(); }, { min: 1, max: 32 }),

    h('h3', {}, 'Random mute'),
    h('label', { class: 'field' }, h('span', {}, 'Silence ', h('b', { id: 'rmVal' }, `${met.randomMute}%`), ' of beats'),
      h('input', { type: 'range', min: 0, max: 80, step: 5, value: met.randomMute,
        oninput: (e) => { met.randomMute = +e.target.value; $('rmVal').textContent = `${met.randomMute}%`; changed(); } }))));
}

function openTimerSheet() {
  const draw = () => fill(content, 
    h('div', { class: 'big-value' }, `Practiced ${fmtTime(practiceMs())}`),
    h('h3', {}, 'Stop automatically after'),
    h('div', { class: 'chips' }, [0, 5, 10, 15, 20, 30, 45, 60].map((m) => h('button', {
      class: 'chip' + (practice.limitMin === m ? ' on' : ''),
      onclick: () => { practice.limitMin = m; if (m) { practice.elapsed = 0; if (practice.since) practice.since = performance.now(); } updateTimer(); draw(); },
    }, m ? `${m} min` : 'Off'))),
    h('button', { class: 'ghost wide', onclick: () => { practice.elapsed = 0; if (practice.since) practice.since = performance.now(); updateTimer(); draw(); } }, 'Reset timer'));
  const content = h('div', {});
  draw();
  openSheet('Practice timer', content);
}

// ---------- presets & setlists ----------

const summary = (s) => `${s.bpm} BPM · ${s.beats}/${s.noteValue} · ${SUBDIVISIONS.find((x) => x.id === s.subdivision)?.name || 'Quarter'}`;

async function savePreset() {
  const name = await askText('Save preset', { placeholder: 'Song or exercise name' });
  if (!name) return;
  try { await store.save('metronome', name, met.getState()); toast(`Saved "${name}"`); } catch (e) { toast(e.message); }
}

async function openLibrary(tab = 'presets') {
  const body = h('div', {});
  const sheet = openSheet('Library', body);
  const draw = async () => {
    const seg = h('div', { class: 'seg' },
      h('button', { class: tab === 'presets' ? 'on' : '', onclick: () => { tab = 'presets'; draw(); } }, 'Presets'),
      h('button', { class: tab === 'setlists' ? 'on' : '', onclick: () => { tab = 'setlists'; draw(); } }, 'Setlists'));
    const list = h('div', { class: 'list' }, h('p', { class: 'hint' }, 'Loading…'));
    fill(body, seg, list,
      !store.loggedIn && h('p', { class: 'hint' }, 'Saved on this device. Sign in under Settings to sync across devices.'));
    let items;
    try { items = await store.list(tab === 'presets' ? 'metronome' : 'setlist'); } catch (e) { fill(list, h('p', { class: 'hint' }, e.message)); return; }
    if (tab === 'presets') {
      fill(list, 
        ...items.map((p) => h('div', { class: 'list-row' },
          h('button', { class: 'list-main', onclick: () => { met.setState(p.data); setlistOff(); sheet.close(); toast(`Loaded "${p.name}"`); } },
            h('b', {}, p.name), h('small', {}, summary(p.data))),
          h('button', { class: 'icon-btn', 'aria-label': 'Overwrite with current settings', title: 'Update with current settings',
            onclick: async () => { if (confirm(`Overwrite "${p.name}" with the current settings?`)) { await store.save('metronome', p.name, met.getState(), p.id); draw(); } } }, '⟳'),
          h('button', { class: 'icon-btn danger', 'aria-label': 'Delete', onclick: async () => { if (confirm(`Delete "${p.name}"?`)) { await store.remove(p); draw(); } } }, '🗑'))),
        !items.length && h('p', { class: 'hint' }, 'No presets yet.'),
        h('button', { class: 'primary wide', onclick: async () => { await savePreset(); draw(); } }, '+ Save current settings'));
    } else {
      fill(list, 
        ...items.map((sl) => h('div', { class: 'list-row' },
          h('button', { class: 'list-main', onclick: () => { sheet.close(); editSetlist(sl); } },
            h('b', {}, sl.name), h('small', {}, `${sl.data.items?.length || 0} songs`)),
          h('button', { class: 'icon-btn', 'aria-label': 'Play setlist', onclick: () => { startSetlist(sl, 0); sheet.close(); } }, '▶'),
          h('button', { class: 'icon-btn danger', 'aria-label': 'Delete', onclick: async () => { if (confirm(`Delete setlist "${sl.name}"?`)) { await store.remove(sl); draw(); } } }, '🗑'))),
        !items.length && h('p', { class: 'hint' }, 'No setlists yet. A setlist is an ordered list of tempos you can step through on stage.'),
        h('button', { class: 'primary wide', onclick: async () => {
          const name = await askText('New setlist', { placeholder: 'e.g. Friday gig' });
          if (!name) return;
          try { const sl = await store.save('setlist', name, { items: [] }); sheet.close(); editSetlist(sl); } catch (e) { toast(e.message); }
        } }, '+ New setlist'));
    }
  };
  draw();
}

function editSetlist(sl) {
  sl = { ...sl, data: { items: [...(sl.data.items || [])] } };
  const body = h('div', {});
  const persist = async () => {
    try { const saved = await store.save('setlist', sl.name, sl.data, sl.id); sl.id = saved.id; } catch (e) { toast(e.message); }
    if (setlist?.item.id === sl.id) { setlist.item = sl; renderSetlistBar(); }
  };
  const move = (i, d) => { const arr = sl.data.items; const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; persist(); draw(); };
  const draw = () => fill(body, 
    h('div', { class: 'list' },
      sl.data.items.map((it, i) => h('div', { class: 'list-row' },
        h('span', { class: 'idx' }, i + 1),
        h('button', { class: 'list-main', onclick: () => { startSetlist(sl, i); sheet.close(); } }, h('b', {}, it.name), h('small', {}, summary(it.state))),
        h('button', { class: 'icon-btn', 'aria-label': 'Move up', onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'icon-btn', 'aria-label': 'Move down', onclick: () => move(i, 1) }, '↓'),
        h('button', { class: 'icon-btn danger', 'aria-label': 'Remove', onclick: () => { sl.data.items.splice(i, 1); persist(); draw(); } }, '✕'))),
      !sl.data.items.length && h('p', { class: 'hint' }, 'Empty. Add the current metronome settings or one of your presets.')),
    h('div', { class: 'chips' },
      h('button', { class: 'chip', onclick: async () => {
        const name = await askText('Song name', { placeholder: 'Song title' });
        if (!name) return;
        sl.data.items.push({ name, state: met.getState() }); persist(); draw();
      } }, '+ Current settings'),
      h('button', { class: 'chip', onclick: async () => {
        const presets = await store.list('metronome').catch(() => []);
        if (!presets.length) return toast('No presets saved yet');
        const pick = openSheet('Add preset', h('div', { class: 'list' }, presets.map((p) => h('button', { class: 'list-main', onclick: () => {
          sl.data.items.push({ name: p.name, state: p.data }); persist(); draw(); pick.close();
        } }, h('b', {}, p.name), h('small', {}, summary(p.data))))));
      } }, '+ From presets'),
      h('button', { class: 'chip', onclick: async () => {
        const name = await askText('Rename setlist', { value: sl.name });
        if (name) { sl.name = name; persist(); sheet.body.closest('.sheet').querySelector('h2').textContent = name; }
      } }, 'Rename')),
    sl.data.items.length > 0 && h('button', { class: 'primary wide', onclick: () => { startSetlist(sl, 0); sheet.close(); } }, '▶ Play setlist'));
  const sheet = openSheet(sl.name, body);
  draw();
}

function startSetlist(sl, index) {
  if (!sl.data.items?.length) return toast('Setlist is empty');
  setlist = { item: sl, index };
  loadSetlistIndex(index);
}

function loadSetlistIndex(i) {
  const items = setlist.item.data.items;
  setlist.index = Math.max(0, Math.min(items.length - 1, i));
  const wasPlaying = met.playing;
  met.stop();
  met.setState(items[setlist.index].state);
  if (wasPlaying) met.start();
  renderSetlistBar();
}

function setlistOff() { setlist = null; renderSetlistBar(); }

function renderSetlistBar() {
  const bar = $('setlistBar');
  bar.hidden = !setlist;
  if (!setlist) return;
  const items = setlist.item.data.items;
  $('slName').textContent = `${setlist.index + 1}/${items.length} · ${items[setlist.index].name}`;
  $('slPrev').disabled = setlist.index === 0;
  $('slNext').disabled = setlist.index === items.length - 1;
}

// ---------- init ----------

export function initMetronome() {
  try { met.setState(JSON.parse(localStorage.getItem(STATE_KEY))); } catch { /* defaults */ }
  met.addEventListener('change', render);
  met.addEventListener('state', renderTransport);
  met.addEventListener('finished', () => { toast(`Set complete: ${met.drillCounts} counts`); navigator.vibrate?.(150); });

  $('playBtn').addEventListener('click', () => met.toggle());
  holdRepeat($('bpmMinus'), () => bumpBpm(-1));
  holdRepeat($('bpmPlus'), () => bumpBpm(1));
  $('bpmSlider').addEventListener('input', (e) => met.setBpm(+e.target.value));
  $('tapBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); tap(); });
  enableBpmDrag();
  $('tsBtn').addEventListener('click', openTimeSigSheet);
  $('subBtn').addEventListener('click', openSubdivisionSheet);
  $('soundBtn').addEventListener('click', openSoundSheet);
  $('moreBtn').addEventListener('click', openTrainerSheet);
  $('timerBtn').addEventListener('click', openTimerSheet);
  $('libraryBtn').addEventListener('click', () => openLibrary());
  $('savePresetBtn').addEventListener('click', savePreset);
  $('slPrev').addEventListener('click', () => loadSetlistIndex(setlist.index - 1));
  $('slNext').addEventListener('click', () => loadSetlistIndex(setlist.index + 1));
  $('slClose').addEventListener('click', setlistOff);

  document.addEventListener('keydown', (e) => {
    if (!$('view-metronome').classList.contains('active') || e.target.closest('input, textarea, .sheet')) return;
    if (e.code === 'Space') { e.preventDefault(); met.toggle(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') bumpBpm(e.shiftKey ? 10 : 1);
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') bumpBpm(e.shiftKey ? -10 : -1);
    if (e.key.toLowerCase() === 't') tap();
  });

  render();
  renderTransport();
}
