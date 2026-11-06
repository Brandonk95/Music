// Group metronome UI: the "Group" chip, the group bar, and its sheets.
import { party, savedGuestName, DRONE_NOTES, droneName } from './party.js';
import { qrSvg } from './qr.js';
import { met } from './metronome.js';
import { store } from './store.js';
import { h, fill, $, toast, openSheet } from './ui.js';
import { settings } from './settings.js';
import { sectionNoteNames } from './tuner.js';

const SYNC_TEXT = {
  idle: 'Joined',
  waiting: 'Waiting for the host to start',
  calibrating: 'Measuring this phone… keep quiet',
  listening: 'Listening to the host…',
  synced: 'In sync',
  network: 'Following without the mic',
  failed: 'Couldn\'t hear the host',
  host: 'You\'re the host',
};

const MEMBER_TEXT = { joined: 'Joined', ready: 'Ready', listening: 'Syncing…', synced: 'In sync', failed: 'Can\'t hear you', network: 'No mic' };

let detailsSheet = null;

function syncLine() {
  const drone = party.droneOn ? ` · Drone ${droneName(party.state.drone.pc)}` : '';
  if (party.isHost) {
    const n = party.members.length;
    return `Host · ${n} ${n === 1 ? 'user' : 'users'}${drone}`;
  }
  const s = party.sync;
  let text = SYNC_TEXT[s.status] || '';
  if (s.status === 'synced' && s.spreadMs != null) text += ` (±${Math.max(1, Math.round(s.spreadMs))} ms)`;
  if (party.flashOnly) text += ' · Flash only';
  return text + drone;
}

const joinLink = (code) => `${location.origin}${location.pathname}?join=${code}`;

function qrBlock(code) {
  const link = joinLink(code);
  const box = h('div', { class: 'qr-box', role: 'img', 'aria-label': `QR code to join group ${code}` });
  box.innerHTML = qrSvg(link); // built from our own URL, no outside input
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Join my TempoTune group', text: `Group code ${code}`, url: link });
      else { await navigator.clipboard.writeText(link); toast('Link copied'); }
    } catch { /* share sheet closed */ }
  };
  return h('div', { class: 'qr-wrap' }, box,
    h('p', { class: 'group-sub' }, 'Scan with the phone camera to join, or enter the code under 👥 Group.'),
    h('button', { class: 'ghost wide', onclick: share }, navigator.share ? 'Share join link' : 'Copy join link'));
}

/** Host view of one user's tuner during section tuning. */
function tuneBadge(m) {
  const fresh = m.tuneAt && (party.clock?.serverNow() ?? Date.now()) - Date.parse(m.updated) < 7000;
  if (!fresh) return h('span', { class: 'member-status tune-idle' }, 'Not playing');
  const c = Math.round(m.tuneCents);
  const a = Math.abs(c);
  const cls = a <= settings.tolerance ? 'good' : a <= 15 ? 'close' : 'far';
  const word = cls === 'good' ? 'In tune' : c < 0 ? 'Flat' : 'Sharp';
  return h('span', { class: `member-status tune-${cls}` }, `${word} ${c > 0 ? '+' : ''}${c}¢`);
}

function droneControls() {
  const d = party.state?.drone || {};
  const on = !!d.on;
  return h('div', { class: 'drone-box' },
    h('div', { class: 'chips drone-chips' },
      h('button', { class: 'chip' + (!on ? ' on' : ''), onclick: () => party.setDrone(null) }, 'Off'),
      DRONE_NOTES.map(([pc, name]) => h('button', {
        class: 'chip' + (on && d.pc === pc ? ' on' : ''), 'aria-label': `Drone concert ${name}`,
        onclick: () => party.setDrone({ pc, fifth: d.fifth }),
      }, name))),
    h('label', { class: 'field row toggle-row' }, 'Add a perfect 5th',
      h('input', { type: 'checkbox', class: 'switch', checked: !!d.fifth,
        onchange: (e) => party.setDroneFifth(e.target.checked) })),

    h('p', { class: 'hint' }, 'Concert pitch, on every phone, tuned to your A4. Runs until you turn it off, even while the metronome is stopped.'));
}

function renderBar() {
  const view = $('view-metronome');
  view.classList.toggle('group-on', party.active);
  view.classList.toggle('group-guest', party.active && !party.isHost);
  $('groupBtn').classList.toggle('on', party.active);
  $('groupBtn').textContent = party.active ? `👥 ${party.code}` : '👥 Group';
  const bar = $('groupBar');
  bar.hidden = !party.active;
  if (!party.active) { renderControls(); return; }
  bar.dataset.sync = party.isHost ? 'host' : party.sync.status;
  $('groupCode').textContent = party.code;
  $('groupStatus').textContent = syncLine();
  renderControls();
}

/** Repurposes Play / Tap for the group (runs after metronome.js's own render). */
function renderControls() {
  if (!party.active) {
    $('tapBtn').textContent = 'Tap';
    $('tapBtn').disabled = false;
    $('tapBtn').classList.remove('on');
    $('playIcon').textContent = met.playing ? '■' : '▶';
    $('playBtn').classList.toggle('on', met.playing);
    $('playBtn').setAttribute('aria-label', met.playing ? 'Stop' : 'Play');
    return;
  }
  const playing = party.state?.status === 'playing';
  if (party.isHost) {
    // Pause is the main button: it keeps everyone counting, so coming back in is instant.
    const paused = playing && party.paused;
    $('playIcon').textContent = playing && !paused ? '❚❚' : '▶';
    $('playBtn').classList.toggle('on', playing && !paused);
    $('playBtn').setAttribute('aria-label', !playing ? 'Start for everyone' : paused ? 'Resume for everyone' : 'Pause for everyone');
    $('tapBtn').textContent = 'Stop';
    $('tapBtn').classList.remove('on');
    $('tapBtn').disabled = !playing;
  } else {
    const st = party.sync.status;
    $('playIcon').textContent = st === 'synced' || st === 'network' ? (playing ? '♪' : '✓') : st === 'listening' || st === 'calibrating' ? '…' : '⟳';
    $('playBtn').classList.toggle('on', playing && (st === 'synced' || st === 'network'));
    $('playBtn').setAttribute('aria-label', 'Re-sync with the host');
    $('tapBtn').textContent = 'Group';
    $('tapBtn').classList.remove('on');
    $('tapBtn').disabled = false;
  }
}

function goToSettings() {
  document.querySelector('.tabbar button[data-tab="settings"]').click();
}

// ---------- sheets ----------

function openStartSheet(prefillCode = '') {
  const guest = !store.loggedIn;
  const codeInput = h('input', {
    class: 'code-input', placeholder: 'ABC123', maxlength: 6, autocapitalize: 'characters', autocomplete: 'off',
    spellcheck: false, 'aria-label': 'Group code',
    oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); },
    onkeydown: (e) => { if (e.key === 'Enter') join(); },
  });
  codeInput.value = prefillCode;
  const nameInput = guest && h('input', {
    class: 'text-input', placeholder: 'Your name', maxlength: 40, autocomplete: 'given-name', value: savedGuestName(),
    'aria-label': 'Your name', onkeydown: (e) => { if (e.key === 'Enter') codeInput.focus(); },
  });
  const err = h('p', { class: 'hint error' });
  const busy = (on) => sheet.body.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  const run = async (fn) => {
    busy(true);
    err.textContent = '';
    try { await fn(); sheet.close(); openDetails(); } catch (e) { err.textContent = e.message; } finally { busy(false); }
  };
  const join = () => run(() => party.join(codeInput.value, { name: nameInput?.value }));
  const sheet = openSheet('Group metronome', h('div', { class: 'form' },
    h('p', {}, 'One phone hosts. Everyone else joins with the code, then holds their phone near the host’s while it plays — each phone listens for a few beats and locks on.'),
    h('h3', {}, 'Join a group'),
    nameInput,
    h('div', { class: 'join-row' }, codeInput, h('button', { class: 'primary', onclick: join }, 'Join')),
    err,
    h('p', { class: 'hint' }, 'Joining uses the microphone for a few seconds to line up with the host’s speaker.'),
    h('h3', {}, 'Host a group'),
    guest
      ? [h('p', { class: 'hint' }, 'Starting a group needs an account. Joining doesn’t.'),
        h('button', { class: 'ghost wide', onclick: () => { sheet.close(); goToSettings(); } }, 'Sign in or create account')]
      : h('button', { class: 'primary wide', onclick: () => run(() => party.create()) }, 'Start a group')));
  setTimeout(() => (nameInput && !nameInput.value ? nameInput : codeInput).focus(), 50);
}

function drawDetails(body) {
  if (!party.active) return;
  const playing = party.state?.status === 'playing';
  const close = () => detailsSheet?.close();
  const common = [
    h('div', { class: 'group-code-big', 'aria-label': `Group code ${party.code}` }, party.code),
    h('p', { class: 'group-sub' }, party.isHost ? 'Others join with this code (👥 Group → Join).' : syncLine()),
  ];
  if (party.isHost) {
    fill(body, ...common,
      qrBlock(party.code),
      h('button', { class: 'primary wide', disabled: party.calibActive || !party.members.length, onclick: () => { close(); party.startCalibration(); } },
        '🔊 Sync everyone by sound'),
      h('button', { class: 'primary wide', disabled: !party.members.length || party.calibActive,
        onclick: () => { close(); party.tuneSession ? openTuneProgress() : openTuneSetup(); } },
        party.tuneSession ? '🎯 Section tuning (running)' : '🎯 Tune the section'),
      h('h3', {}, 'Tuning drone'),
      droneControls(),
      h('h3', {}, `Users (${party.members.length})`),
      h('div', { class: 'list' },
        party.members.map((m) => h('div', { class: 'list-row member' },
          h('span', { class: 'member-name' }, m.name || 'User'),
          party.sectionTune ? tuneBadge(m) : h('span', { class: `member-status s-${m.status}` }, MEMBER_TEXT[m.status] || m.status,
            m.status === 'synced' && m.syncMs ? ` ±${Math.max(1, Math.round(m.syncMs))} ms` : ''),
          h('button', {
            class: 'icon-btn danger', 'aria-label': `Remove ${m.name || 'user'}`, title: 'Remove from group',
            onclick: () => { if (confirm(`Remove ${m.name || 'this user'} from the group?`)) party.kick(m.id); },
          }, '✕'))),
        !party.members.length && h('p', { class: 'hint' }, 'Nobody yet.')),
      h('p', { class: 'hint' },
        '▶ starts everyone after a short count-off. The big button then pauses: every phone goes silent but keeps counting, so you can talk and ▶ comes back in on the beat. Stop (beside it) ends the beat and resets.',
        ' Tempo or meter changes start on the next downbeat — nobody needs to re-sync.'),
      h('label', { class: 'field row toggle-row' }, 'Warn me before I could spoil someone’s sync',
        h('input', { type: 'checkbox', class: 'switch', checked: !warningsOff(),
          onchange: (e) => { if (e.target.checked) localStorage.removeItem(WARN_OFF_KEY); else localStorage.setItem(WARN_OFF_KEY, '1'); } })),
      h('button', { class: 'ghost wide danger', onclick: async () => {
        if (!confirm('End the group for everyone?')) return;
        close(); await party.leave({ end: true }); toast('Group ended');
      } }, 'End group'));
  } else {
    const st = party.sync.status;
    const busy = st === 'listening' || st === 'calibrating';
    fill(body, ...common,
      st === 'failed' && h('p', { class: 'group-sub error' }, party.sync.message || ''),
      party.calib?.phase === 'gather' && !party.calibReady
        && h('button', { class: 'primary wide', onclick: () => { close(); party.markReady(); } }, 'Ready to sync (device next to the host’s)'),
      !playing && h('p', { class: 'group-sub' }, 'When the host starts, hold your phone near theirs for a few beats.'),
      h('button', { class: 'primary wide', disabled: busy || !playing, onclick: () => party.resync() },
        st === 'synced' ? 'Re-sync with host' : 'Sync with host'),
      h('button', { class: 'ghost wide', disabled: busy || playing, onclick: async () => {
        try { await party.calibrateDevice(); toast('Phone calibrated'); } catch (e) { toast(e.message); }
      } }, 'Recalibrate this phone'),
      st !== 'network' && h('button', { class: 'ghost wide', disabled: busy, onclick: () => party.useNetworkOnly() }, 'Follow without the mic (less exact)'),
      h('p', { class: 'hint' }, 'Recalibrating plays a few clicks to measure this phone\'s own speaker delay — do it in a quiet moment.'),
      h('label', { class: 'field row toggle-row' }, 'Flash and vibrate only (no clicks)',
        h('input', { type: 'checkbox', class: 'switch', checked: party.flashOnly, onchange: (e) => { party.flashOnly = e.target.checked; } })),
      party.droneOn && h('p', { class: 'hint' }, `The host is playing a concert ${droneName(party.state.drone.pc)} drone.`),
      h('button', { class: 'ghost wide danger', onclick: async () => { close(); await party.leave(); toast('Left the group'); } }, 'Leave group'));
  }
}

function openDetails() {
  if (!party.active) return openStartSheet();
  const body = h('div', { class: 'form' });
  detailsSheet = openSheet(party.isHost ? 'Your group' : 'Group', body);
  const prevClose = detailsSheet.close;
  detailsSheet.close = () => { detailsSheet = null; prevClose(); };
  drawDetails(body);
}

function refreshDetails() {
  if (!detailsSheet) return;
  if (!document.body.contains(detailsSheet.body)) { detailsSheet = null; return; }
  if (!party.active) { detailsSheet.close(); return; }
  drawDetails(detailsSheet.body);
}

/** Opened from a ?join=CODE link (e.g. a scanned QR code). Joining still needs a tap,
 * since browsers only allow audio after a user gesture. */
export function openJoinLink(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!c || party.code === c) return;
  if (party.active) { toast(`Leave group ${party.code} first to join ${c}`); return; }
  openStartSheet(c);
}

// ---------- host warnings ----------

const WARN_OFF_KEY = 'tt.groupWarningsOff';
const warningsOff = () => localStorage.getItem(WARN_OFF_KEY) === '1';

function names(list) {
  const n = list.map((m) => m.name || 'A user');
  if (n.length === 1) return n[0];
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  return `${n[0]}, ${n[1]} and ${n.length - 2} more`;
}
const isAre = (list) => (list.length === 1 ? 'is' : 'are');

const WARNINGS = {
  pause: (who) => ({ title: 'Pause during a sync?', ok: 'Pause anyway',
    text: `${names(who)} ${isAre(who)} syncing to your clicks right now. Pausing goes silent, so their sync will fail and they’ll need to try again.` }),
  stop: (who) => ({ title: 'Stop during a sync?', ok: 'Stop anyway',
    text: `${names(who)} ${isAre(who)} syncing to your clicks right now. Stopping will make their sync fail and they’ll need to try again.` }),
  drone: (who) => ({ title: 'Start the drone during a sync?', ok: 'Start drone',
    text: `${names(who)} ${isAre(who)} listening for your clicks right now, and the drone can drown them out. Waiting a few seconds is safer.` }),
  tempo: (who) => ({ title: 'Change tempo during a sync?', ok: 'Change it',
    text: `${names(who)} ${isAre(who)} syncing to your clicks right now. Changing the tempo or meter can make their sync fail. Cancel puts it back.` }),
  output: (who) => ({ title: 'Your audio output changed', ok: 'OK', notice: true,
    text: `This phone seems to have switched speakers (for example Bluetooth or headphones). ${names(who)} ${isAre(who)} synced to the old speaker, so they may now be off the beat. Switch back, or ask everyone to tap Re-sync.` }),
};

/** Host warning sheet: resolves true to go ahead, false to cancel. */
function warn(kind, who) {
  if (warningsOff()) return Promise.resolve(true);
  const w = WARNINGS[kind](who);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); sheet.close(); };
    const sheet = openSheet(w.title, h('div', { class: 'form' },
      h('p', {}, w.text),
      h('div', { class: 'warn-actions' },
        !w.notice && h('button', { class: 'ghost', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => finish(true) }, w.ok)),
      h('button', { class: 'link-btn', onclick: () => { localStorage.setItem(WARN_OFF_KEY, '1'); finish(true); toast('Sync warnings turned off'); } },
        'Don’t show these warnings again')),
    { onClose: () => { if (!done) { done = true; resolve(!!w.notice); } } }); // closing = cancel
  });
}

// ---------- sync everyone by sound ----------

/** Host pressed Start with users not yet synced. Resolves 'sound', 'skip' or null. */
function askCalib(need) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); sheet.close(); };
    const sheet = openSheet('Sync everyone by sound?', h('div', { class: 'form' },
      h('p', {}, `${names(need)} ${isAre(need)} not synced yet. Syncing by sound lines every device up with yours: `,
        'everyone holds their device next to yours and taps Ready, then the room stays quiet for a few seconds.'),
      h('button', { class: 'primary wide', onclick: () => finish('sound') }, '🔊 Sync by sound'),
      h('button', { class: 'ghost wide', onclick: () => finish('skip') }, 'Skip, just start'),
      h('p', { class: 'hint' }, 'Skipping uses the network only, which can be a few milliseconds off.')),
    { onClose: () => { if (!done) { done = true; resolve(null); } } });
  });
}

let calibSheet = null, calibSheetKey = null, dismissedKey = null;

function calibRows() {
  const live = party.liveMembers;
  if (!live.length) return h('p', { class: 'hint' }, 'Nobody has joined yet.');
  return h('div', { class: 'list' }, live.map((m) => h('div', { class: 'list-row member' },
    h('span', { class: 'member-name' }, m.name || 'User'),
    h('span', { class: `member-status s-${m.status}` }, MEMBER_TEXT[m.status] || m.status))));
}

function drawCalib(body) {
  const c = party.calib;
  if (party.isHost) {
    const live = party.liveMembers;
    const ready = live.filter((m) => m.status === 'ready').length;
    if (c.phase === 'gather') {
      fill(body,
        h('div', { class: 'calib-big' }, '📲'),
        h('p', { class: 'calib-lead' }, 'Everyone: put your device right next to this one and tap Ready.'),
        h('p', { class: 'group-sub' }, `${ready} of ${live.length} ready. Sync starts by itself when everyone is.`),
        calibRows(),
        h('button', { class: 'primary wide', disabled: !ready, onclick: () => party.beginCalibSync() }, 'Start sync now'),
        h('button', { class: 'ghost wide', onclick: () => party.cancelCalibration() }, 'Cancel'));
    } else {
      fill(body,
        h('div', { class: 'calib-big pulse' }, '🤫'),
        h('p', { class: 'calib-lead' }, 'Syncing… keep the room quiet and the devices still.'),
        calibRows(),
        h('button', { class: 'ghost wide', onclick: () => party.cancelCalibration() }, 'Cancel'));
    }
    return;
  }
  if (c.phase === 'gather') {
    fill(body,
      h('div', { class: 'calib-big' }, party.calibReady ? '✅' : '📲'),
      party.calibReady
        ? h('p', { class: 'calib-lead' }, 'Ready! Keep your device next to the host’s and wait for the others.')
        : h('p', { class: 'calib-lead' }, 'Put this device right next to the host’s device, then tap Ready.'),
      !party.calibReady && h('button', { class: 'primary wide big-ready', onclick: () => party.markReady() }, 'Ready'),
      !party.calibReady && party.sync.status !== 'network'
        && h('button', { class: 'ghost wide', onclick: () => party.useNetworkOnly() }, 'Skip, follow without the mic'));
  } else {
    const st = party.sync.status;
    fill(body,
      h('div', { class: 'calib-big pulse' }, '🤫'),
      h('p', { class: 'calib-lead' }, 'Shh… stay quiet and keep your device still until you hear the chime.'),
      h('p', { class: 'group-sub' }, st === 'network' ? 'Following without the mic.' : st === 'synced' ? 'This device is synced. Waiting for the others…' : SYNC_TEXT[st] || ''));
  }
}

/** Opens, updates or closes the calibration sheet to match the group's state. */
function renderCalib() {
  const c = party.active ? party.calib : null;
  const active = c && (c.phase === 'gather' || c.phase === 'sync');
  const key = active ? `${c.id}:${c.phase}` : null;
  if (!active) { calibSheet?.close(); calibSheet = null; calibSheetKey = null; return; }
  if (key === dismissedKey) return;
  if (calibSheet && calibSheetKey !== key) { const s = calibSheet; calibSheet = null; s.close(); }
  if (!calibSheet) {
    const body = h('div', { class: 'form' });
    calibSheetKey = key;
    const sheet = openSheet(c.phase === 'gather' ? 'Sync by sound' : 'Syncing', body,
      { onClose: () => { if (calibSheet === sheet) { calibSheet = null; dismissedKey = key; } } });
    calibSheet = sheet;
  }
  drawCalib(calibSheet.body.firstChild);
}

function showCalibDone({ calib: c, mine }) {
  calibSheet?.close();
  calibSheet = null;
  let title, text;
  if (party.isHost) {
    title = c.failedCount ? 'Sync finished' : 'Everyone’s in sync!';
    text = c.failedCount
      ? `${c.ok} synced. Couldn’t hear you: ${c.failed.join(', ')}${c.failedCount > c.failed.length ? ' and others' : ''}. They can tap Re-sync while you play.`
      : `${c.ok} ${c.ok === 1 ? 'device is' : 'devices are'} locked to your beat.`;
    text += ' The beat is paused; tap ▶ Resume when you’re ready.';
  } else if (mine) {
    title = 'You’re in sync!';
    text = 'This device is locked to the host’s beat. Wait for the host to start.';
  } else {
    title = 'Couldn’t sync';
    text = party.sync.message || 'This device couldn’t hear the host. Move closer and tap Re-sync once the host plays.';
  }
  const sheet = openSheet(title, h('div', { class: 'form' },
    h('div', { class: mine ? 'calib-big done' : 'calib-big' }, mine ? '✓' : '⚠️'),
    h('p', { class: 'calib-lead' }, text),
    h('button', { class: 'primary wide', onclick: () => sheet.close() }, 'OK')));
  if (mine) setTimeout(() => sheet.close(), 6000);
}

// ---------- section tuning ----------

const TUNE_NOTE_KEY = 'tt.sectionNote';
const TUNE_HOLD_KEY = 'tt.sectionHold';

/** Host step 1: pick the note and how long everyone must hold it. */
function openTuneSetup() {
  let pc = Number(localStorage.getItem(TUNE_NOTE_KEY) ?? 10);
  let hold = Number(localStorage.getItem(TUNE_HOLD_KEY) || 5);
  const body = h('div', { class: 'form' });
  const draw = () => fill(body,
    h('ol', { class: 'steps' },
      h('li', {}, 'Pick the note. Everyone’s phone opens the tuner locked to it (shown as their own written note).'),
      h('li', {}, 'Only your phone plays the drone, so everyone can hear the pitch.'),
      h('li', {}, `Each player holds the note in tune for ${hold} seconds. You see everyone live.`),
      h('li', {}, 'When everyone has, all phones celebrate and the drone stops.')),
    h('h3', {}, 'Note (concert pitch)'),
    h('div', { class: 'chips drone-chips' }, DRONE_NOTES.map(([p, name]) => h('button', {
      class: 'chip' + (p === pc ? ' on' : ''), onclick: () => { pc = p; draw(); } }, name))),
    h('h3', {}, 'Hold in tune for'),
    h('div', { class: 'chips' }, [3, 5, 10].map((s) => h('button', {
      class: 'chip' + (s === hold ? ' on' : ''), onclick: () => { hold = s; draw(); } }, `${s} s`))),
    h('button', { class: 'primary wide', onclick: async () => {
      localStorage.setItem(TUNE_NOTE_KEY, pc);
      localStorage.setItem(TUNE_HOLD_KEY, hold);
      sheet.close();
      await party.startSectionTuning({ pc, hold });
      if (party.tuneSession) openTuneProgress();
    } }, `Start tuning to concert ${droneName(pc)}`));
  const sheet = openSheet('Tune the section', body);
  draw();
}

let tuneSheet = null;

function tuneRow(m, id) {
  const tuned = m.tunedId === id;
  return h('div', { class: 'list-row member' },
    h('span', { class: 'member-name' }, m.name || 'User'),
    tuned ? h('span', { class: 'member-status tune-good' }, '✓ In tune') : tuneBadge(m));
}

/** Host: live view of everyone during section tuning. */
function openTuneProgress() {
  if (tuneSheet) return;
  const body = h('div', { class: 'form' });
  tuneSheet = openSheet('Section tuning', body, { onClose: () => { tuneSheet = null; } });
  drawTuneProgress();
}

function drawTuneProgress() {
  const d = party.tuneSession;
  if (!tuneSheet) return;
  if (!d) { tuneSheet.close(); return; }
  const live = party.liveMembers;
  const done = party.tunedMembers.length;
  fill(tuneSheet.body.firstChild,
    h('div', { class: 'tune-note' }, droneName(d.pc), h('small', {}, 'concert')),
    h('p', { class: 'calib-lead' }, `${done} of ${live.length} in tune`),
    h('div', { class: 'tune-bar' }, h('div', { style: `width:${live.length ? (100 * done) / live.length : 0}%` })),
    h('p', { class: 'group-sub' }, `Each player holds the note in tune for ${d.hold || 5} s.`),
    live.length ? h('div', { class: 'list' }, live.map((m) => tuneRow(m, d.tuneId))) : h('p', { class: 'hint' }, 'Nobody has joined yet.'),
    h('button', { class: 'ghost wide danger', onclick: () => party.endSectionTuning() }, 'End tuning'));
}

let introSheet = null;

/** Users: what to do, shown when the host starts section tuning. */
function showTuneIntro(pc, hold) {
  introSheet?.close();
  const n = sectionNoteNames(pc);
  const bar = h('div', {});
  const sheet = openSheet('Section tuning', h('div', { class: 'form' },
    h('div', { class: 'tune-note' }, n.yours, h('small', {}, n.transposed ? `your note · concert ${n.concert}` : 'concert')),
    h('ol', { class: 'steps' },
      h('li', {}, `Play your ${n.yours} and hold it steady.`),
      h('li', {}, 'Watch the tuner: push in or pull out until it turns green.'),
      h('li', {}, `Hold it green for ${hold} seconds. You’ll hear a chime.`)),
    h('div', { class: 'tune-bar' }, bar),
    h('button', { class: 'primary wide', onclick: () => sheet.close() }, 'Got it')),
  { onClose: () => { clearInterval(t); if (introSheet === sheet) introSheet = null; } });
  introSheet = sheet;
  const t = setInterval(() => { bar.style.width = `${Math.round((party.tuneProgress || 0) * 100)}%`; }, 150);
}

function celebrate(title, text, { big = true } = {}) {
  introSheet?.close();
  const sheet = openSheet(title, h('div', { class: 'form' },
    h('div', { class: 'calib-big done' + (big ? ' big' : '') }, '✓'),
    h('p', { class: 'calib-lead' }, text),
    h('button', { class: 'primary wide', onclick: () => sheet.close() }, 'OK')));
  setTimeout(() => sheet.close(), big ? 6000 : 4000);
}

// ---------- init ----------

export function initPartyUI() {
  party.warn = warn;
  party.askCalib = askCalib;
  party.addEventListener('calibdone', (e) => showCalibDone(e.detail));
  $('groupBtn').addEventListener('click', openDetails);
  $('groupBar').addEventListener('click', openDetails);
  $('tapBtn').addEventListener('pointerdown', (e) => {
    if (!party.active) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (party.isHost) party.stop(); else openDetails();
  }, true);

  let lastSync = null;
  party.addEventListener('change', () => {
    renderBar();
    refreshDetails();
    renderCalib();
    drawTuneProgress();
    const st = party.active && !party.isHost ? party.sync.status : null;
    if (st !== lastSync) {
      if (st === 'synced' && !party.calib?.phase?.match(/sync|done/)) { toast('In sync with the host'); navigator.vibrate?.(60); }
      if (st === 'failed') toast(party.sync.message || 'Couldn\'t hear the host');
      lastSync = st;
    }
  });
  let sectionFrom = null;
  party.addEventListener('tuned', () => celebrate('You’re in tune!', 'Nice. Waiting for the others…', { big: false }));
  party.addEventListener('tunedone', (e) => {
    tuneSheet?.close();
    const n = e.detail.n;
    celebrate('Everyone’s in tune!', party.isHost
      ? `All ${n} ${n === 1 ? 'player' : 'players'} held concert ${droneName(e.detail.pc)} in tune.`
      : 'The whole section is in tune. 🎉');
  });
  party.addEventListener('section', (e) => {
    const { on, pc, hold, changed, fresh } = e.detail;
    if (on && fresh) setTimeout(() => party.sectionTune && showTuneIntro(pc, hold), changed ? 350 : 0);
    const tab = (name) => document.querySelector(`.tabbar button[data-tab="${name}"]`);
    const current = document.querySelector('.tabbar button[aria-selected="true"]')?.dataset.tab;
    if (on) {
      if (changed) { sectionFrom = current; tab('tuner')?.click(); navigator.vibrate?.(80); }
      toast(`Section tuning: concert ${droneName(pc)}`, 4000);
    } else if (changed) {
      toast('Section tuning ended');
      if (sectionFrom && sectionFrom !== 'tuner' && current === 'tuner') tab(sectionFrom)?.click();
      sectionFrom = null;
    }
  });
  party.addEventListener('members', () => { renderBar(); refreshDetails(); renderCalib(); drawTuneProgress(); });
  party.addEventListener('ended', (e) => {
    if (e.detail.kicked) toast('The host removed you from the group');
    else if (!e.detail.wasHost) toast('The host ended the group');
  });
  party.addEventListener('error', (e) => toast(e.detail));
  met.addEventListener('state', renderControls);
  met.addEventListener('change', () => party.active && renderControls());
  // Signing out leaves a group joined with the account (guests aren't affected).
  store.addEventListener('change', () => { if (!store.loggedIn && party.active && !party.isGuest) party.leave(); });
  window.addEventListener('pagehide', () => { if (party.active && !party.isHost) party.leave(); });
  renderBar();
}
