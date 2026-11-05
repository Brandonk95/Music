import { settings, setSetting } from './settings.js';
import { initTuner, stopTuner } from './tuner.js';
import { initMetronome } from './metronome.js';
import { initPartyUI } from './party-ui.js';
import { initSettingsView } from './settings-view.js';
import { store } from './store.js';
import { tone } from './tone.js';
import { applyProfile, loadLocalProfile } from './personalize.js';
import { toast } from './ui.js';

const renderSettings = initSettingsView();
initTuner();
initMetronome();
initPartyUI();

function showTab(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tabbar button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
  if (name !== 'tuner') { stopTuner(); tone.stop(); }
  if (name === 'settings') renderSettings();
  if (name === 'tuner') window.dispatchEvent(new Event('resize')); // redraw canvases now visible
  setSetting('tab', name);
}

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
showTab(settings.tab === 'settings' ? 'settings' : settings.tab || 'tuner');

// Free the mic when the app is backgrounded.
document.addEventListener('visibilitychange', () => { if (document.hidden) stopTuner(); });

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
