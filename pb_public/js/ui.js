// Tiny DOM helpers: element builder, bottom sheets, toasts, text prompts.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const $ = (id) => document.getElementById(id);

/** Like el.replaceChildren, but skips null/false (so `cond && el` works, as in h()). */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false)
    .map((c) => (c instanceof Node ? c : String(c))));
  return el;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** Opens a bottom sheet. Returns { close, body }. */
export function openSheet(title, content, { onClose } = {}) {
  const body = h('div', { class: 'sheet-body' }, content);
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
    h('div', { class: 'sheet-grip' }),
    h('div', { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, '✕')),
    body);
  const backdrop = h('div', { class: 'sheet-backdrop' }, sheet);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 220);
    onClose?.();
  }
  return { close, body };
}

/** Asks for a line of text in a sheet. Resolves to the string, or null if cancelled. */
export function askText(title, { placeholder = '', value = '', ok = 'Save', inputmode } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'text-input', placeholder, value, inputmode, enterkeyhint: 'done' });
    const finish = (v) => { if (!done) { done = true; resolve(v); sheet.close(); } };
    const form = h('form', { class: 'ask-form', onsubmit: (e) => { e.preventDefault(); finish(input.value.trim() || null); } },
      input,
      h('button', { class: 'primary', type: 'submit' }, ok));
    const sheet = openSheet(title, form, { onClose: () => { if (!done) { done = true; resolve(null); } } });
    setTimeout(() => { input.focus(); input.select(); }, 80);
  });
}

/** Calls fn repeatedly (accelerating) while the button is held. */
export function holdRepeat(btn, fn) {
  let timer, delay;
  const stop = () => clearTimeout(timer);
  const tick = () => { fn(); delay = Math.max(40, delay * 0.8); timer = setTimeout(tick, delay); };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fn();
    delay = 380;
    timer = setTimeout(tick, delay);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
}

export function sizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, hgt = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h: hgt };
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
