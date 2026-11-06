import { settings, setSetting } from './settings.js';
import { initTuner, startTuner, stopTuner } from './tuner.js';
import { initMetronome } from './metronome.js';
import { initPartyUI, openJoinLink } from './party-ui.js';
import { initSettingsView } from './settings-view.js';
import { store } from './store.js';
import { tone } from './tone.js';
import { applyProfile, loadLocalProfile } from './personalize.js';
import { toast } from './ui.js';
import { initInstall } from './install.js';
import { initFit } from './fit.js';

const renderSettings = initSettingsView();
initTuner();
initMetronome();
initPartyUI();

function showTab(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tabbar button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
  if (name !== 'tuner') { stopTuner(); tone.stop(); }
  if (name === 'settings') renderSettings();
  if (name === 'tuner') { window.dispatchEvent(new Event('resize')); startTuner(); } // redraw canvases, listen
  setSetting('tab', name);
}

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
// Home-screen shortcuts open a specific tab (?tab=tuner / ?tab=metronome).
// Join links (?join=CODE, e.g. from the group QR code) open the join sheet.
const params = new URLSearchParams(location.search);
const startTab = params.get('tab');
const joinCode = params.get('join');
if (startTab || joinCode) history.replaceState(null, '', location.pathname);
showTab(joinCode ? 'metronome' : ['tuner', 'metronome'].includes(startTab) ? startTab
  : settings.tab === 'settings' ? 'settings' : settings.tab || 'tuner');
if (joinCode) openJoinLink(joinCode);
initInstall();
initFit();

// Free the mic when the app is backgrounded.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTuner();
  else if (document.getElementById('view-tuner').classList.contains('active')) startTuner();
});

// Signing in on a new device: bring over the setup answers saved on the account.
store.addEventListener('change', () => {
  if (store.profile && !loadLocalProfile()) {
    applyProfile(store.profile);
    toast('Applied your saved setup');
  }
});

store.refresh();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
