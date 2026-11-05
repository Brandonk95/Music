// "Install app" support.
// Android / desktop Chrome & Edge: the browser fires `beforeinstallprompt`, which
// lets us show its install dialog from our own button.
// iPhone / iPad: there is no prompt API; installing is Share → Add to Home Screen,
// so we show those steps instead.
import { h, toast } from './ui.js';

const DISMISS_KEY = 'tt.installDismissed';

let deferred = null;
export const installEvents = new EventTarget();

const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = isIOS || /Android/i.test(ua);

export function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/** 'installed' | 'prompt' | 'ios' | 'insecure' | 'manual' */
export function installMode() {
  if (isInstalled()) return 'installed';
  if (deferred) return 'prompt';
  if (isIOS) return 'ios';
  if (!window.isSecureContext) return 'insecure';
  return 'manual';
}

export async function promptInstall() {
  if (!deferred) return false;
  const ev = deferred;
  deferred = null;
  ev.prompt();
  const { outcome } = await ev.userChoice.catch(() => ({ outcome: 'dismissed' }));
  installEvents.dispatchEvent(new Event('change'));
  return outcome === 'accepted';
}

/** Steps/button for the current browser, used by Settings and the banner. */
export function installHelp() {
  const mode = installMode();
  if (mode === 'installed') return h('p', { class: 'hint' }, 'Installed. TempoTune opens from your home screen like a normal app and works offline.');
  if (mode === 'prompt') {
    return h('button', { class: 'primary wide', onclick: () => promptInstall() }, 'Install TempoTune');
  }
  if (mode === 'ios') {
    return h('ol', { class: 'install-steps' },
      h('li', {}, 'Open this page in ', h('b', {}, 'Safari'), ' (or Chrome on iOS 16.4+).'),
      h('li', {}, 'Tap the ', h('b', {}, 'Share'), ' button ', h('span', { class: 'share-glyph', 'aria-hidden': 'true' }, '⬆'), '.'),
      h('li', {}, 'Choose ', h('b', {}, 'Add to Home Screen'), ', then ', h('b', {}, 'Add'), '.'));
  }
  if (mode === 'insecure') {
    return h('p', { class: 'hint' }, 'Installing needs a secure (https://) address. Open TempoTune through your https link to install it.');
  }
  return h('p', { class: 'hint' }, 'Open your browser menu (⋮) and choose ', h('b', {}, 'Install app'), ' or ', h('b', {}, 'Add to Home screen'), '.');
}

function showBanner() {
  if (document.getElementById('installBanner')) return;
  const close = () => { localStorage.setItem(DISMISS_KEY, '1'); banner.remove(); };
  const banner = h('div', { id: 'installBanner', class: 'install-banner', role: 'dialog', 'aria-label': 'Install TempoTune' },
    h('img', { src: 'icons/icon-192.png', alt: '', width: 40, height: 40 }),
    h('div', { class: 'install-text' }, h('b', {}, 'Install TempoTune'),
      h('small', {}, installMode() === 'ios' ? 'Share ⬆ → Add to Home Screen' : 'Full screen, offline, one tap away')),
    installMode() === 'prompt' && h('button', { class: 'primary', onclick: async () => { banner.remove(); if (await promptInstall()) toast('Installed'); } }, 'Install'),
    h('button', { class: 'icon-btn', 'aria-label': 'Not now', onclick: close }, '✕'));
  document.body.append(banner);
}

function maybeBanner() {
  if (!isMobile || isInstalled() || localStorage.getItem(DISMISS_KEY)) return;
  const mode = installMode();
  if (mode === 'prompt' || mode === 'ios') showBanner();
}

export function initInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own button instead of the mini-infobar
    deferred = e;
    installEvents.dispatchEvent(new Event('change'));
    maybeBanner();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    document.getElementById('installBanner')?.remove();
    installEvents.dispatchEvent(new Event('change'));
  });
  // iOS never fires beforeinstallprompt: offer the steps after a short look around.
  if (isIOS) setTimeout(maybeBanner, 4000);
}
