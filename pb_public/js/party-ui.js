// Group metronome UI: the "Group" chip, the group bar, and its sheets.
import { party, savedGuestName } from './party.js';
import { met } from './metronome.js';
import { store } from './store.js';
import { h, fill, $, toast, openSheet } from './ui.js';

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

const MEMBER_TEXT = { joined: 'Joined', synced: 'In sync', failed: 'Can\'t hear you', network: 'No mic' };

let detailsSheet = null;

function syncLine() {
  if (party.isHost) {
    const n = party.members.length;
    return `Host · ${n} ${n === 1 ? 'user' : 'users'}`;
  }
  const s = party.sync;
  let text = SYNC_TEXT[s.status] || '';
  if (s.status === 'synced' && s.spreadMs != null) text += ` (±${Math.max(1, Math.round(s.spreadMs))} ms)`;
  return text;
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
    $('playIcon').textContent = playing ? '■' : '▶';
    $('playBtn').classList.toggle('on', playing);
    $('playBtn').setAttribute('aria-label', playing ? 'Stop for everyone' : 'Start for everyone');
    $('tapBtn').textContent = party.paused ? 'Resume' : 'Pause';
    $('tapBtn').classList.toggle('on', party.paused);
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

function openStartSheet() {
  const guest = !store.loggedIn;
  const codeInput = h('input', {
    class: 'code-input', placeholder: 'ABC123', maxlength: 6, autocapitalize: 'characters', autocomplete: 'off',
    spellcheck: false, 'aria-label': 'Group code',
    oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); },
    onkeydown: (e) => { if (e.key === 'Enter') join(); },
  });
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
      h('h3', {}, `Users (${party.members.length})`),
      h('div', { class: 'list' },
        party.members.map((m) => h('div', { class: 'list-row member' },
          h('span', { class: 'member-name' }, m.name || 'User'),
          h('span', { class: `member-status s-${m.status}` }, MEMBER_TEXT[m.status] || m.status,
            m.status === 'synced' && m.syncMs ? ` ±${Math.max(1, Math.round(m.syncMs))} ms` : ''),
          h('button', {
            class: 'icon-btn danger', 'aria-label': `Remove ${m.name || 'user'}`, title: 'Remove from group',
            onclick: () => { if (confirm(`Remove ${m.name || 'this user'} from the group?`)) party.kick(m.id); },
          }, '✕'))),
        !party.members.length && h('p', { class: 'hint' }, 'Nobody yet.')),
      h('p', { class: 'hint' },
        '▶ starts everyone after a short count-off. Pause silences every phone but keeps counting, so you can talk and come back in on the beat. ■ stops and resets.',
        ' Tempo or meter changes start on the next downbeat — nobody needs to re-sync.'),
      h('button', { class: 'ghost wide danger', onclick: async () => {
        if (!confirm('End the group for everyone?')) return;
        close(); await party.leave({ end: true }); toast('Group ended');
      } }, 'End group'));
  } else {
    const st = party.sync.status;
    const busy = st === 'listening' || st === 'calibrating';
    fill(body, ...common,
      st === 'failed' && h('p', { class: 'group-sub error' }, party.sync.message || ''),
      !playing && h('p', { class: 'group-sub' }, 'When the host starts, hold your phone near theirs for a few beats.'),
      h('button', { class: 'primary wide', disabled: busy || !playing, onclick: () => party.resync() },
        st === 'synced' ? 'Re-sync with host' : 'Sync with host'),
      h('button', { class: 'ghost wide', disabled: busy || playing, onclick: async () => {
        try { await party.calibrateDevice(); toast('Phone calibrated'); } catch (e) { toast(e.message); }
      } }, 'Recalibrate this phone'),
      st !== 'network' && h('button', { class: 'ghost wide', disabled: busy, onclick: () => party.useNetworkOnly() }, 'Follow without the mic (less exact)'),
      h('p', { class: 'hint' }, 'Recalibrating plays a few clicks to measure this phone\'s own speaker delay — do it in a quiet moment.'),
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

// ---------- init ----------

export function initPartyUI() {
  $('groupBtn').addEventListener('click', openDetails);
  $('groupBar').addEventListener('click', openDetails);
  $('tapBtn').addEventListener('pointerdown', (e) => {
    if (!party.active) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (party.isHost) party.togglePause(); else openDetails();
  }, true);

  let lastSync = null;
  party.addEventListener('change', () => {
    renderBar();
    refreshDetails();
    const st = party.active && !party.isHost ? party.sync.status : null;
    if (st !== lastSync) {
      if (st === 'synced') { toast('In sync with the host'); navigator.vibrate?.(60); }
      if (st === 'failed') toast(party.sync.message || 'Couldn\'t hear the host');
      lastSync = st;
    }
  });
  party.addEventListener('members', () => { renderBar(); refreshDetails(); });
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
