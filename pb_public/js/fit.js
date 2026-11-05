// Keeps the Tuner and Metronome on one screen, no scrolling.
// CSS sizes things from the screen size; when the content still doesn't fit
// (notch/home bar, large system text, the group or setlist bar), this steps
// the view through .fit-1 .. .fit-3, each more compact, until it does.
const LEVELS = ['fit-1', 'fit-2', 'fit-3'];

function overflows(view) {
  if (view.scrollHeight > view.clientHeight + 1) return true;
  // Flexible blocks shrink instead of pushing the page; check they still hold their content.
  for (const el of view.querySelectorAll('.bpm-block, .tuner-main')) {
    if (el.offsetParent && el.scrollHeight > el.clientHeight + 1) return true;
  }
  return false;
}

function fit(view) {
  if (!view.classList.contains('active')) return;
  const before = LEVELS.findIndex((c) => view.classList.contains(c));
  view.classList.remove(...LEVELS);
  let level = -1;
  while (overflows(view) && level < LEVELS.length - 1) {
    level++;
    view.classList.add(LEVELS[level]);
  }
  // Canvases (tuner gauge) redraw at their new size.
  if (level !== before) window.dispatchEvent(new Event('resize'));
}

export function initFit() {
  const views = ['view-tuner', 'view-metronome'].map((id) => document.getElementById(id)).filter(Boolean);
  // Observer callbacks run after layout but before paint, so fitting here never flickers.
  const fitAll = () => views.forEach(fit);
  const fitNow = fitAll;
  const ro = new ResizeObserver(fitAll);
  ro.observe(document.getElementById('views'));
  views.forEach((v) => ro.observe(v)); // content box: changes with safe-area padding too
  // Our own .fit-* changes don't count, or we'd loop.
  const sig = (cls) => (cls || '').split(/\s+/).filter((c) => !LEVELS.includes(c)).sort().join(' ');
  const watch = new MutationObserver((records) => {
    if (records.some((r) => !views.includes(r.target) || sig(r.oldValue) !== sig(r.target.className))) fitAll();
  });
  // Shown/hidden bars, the active tab, group mode, string buttons.
  views.forEach((v) => watch.observe(v, { attributes: true, attributeFilter: ['class'], attributeOldValue: true }));
  for (const id of ['groupBar', 'setlistBar', 'strings']) {
    const el = document.getElementById(id);
    if (el) watch.observe(el, { attributes: true, attributeFilter: ['hidden', 'class'], childList: true });
  }
  document.fonts?.ready.then(fitNow);
  window.addEventListener('orientationchange', () => setTimeout(fitNow, 300));
  fitNow();
}
