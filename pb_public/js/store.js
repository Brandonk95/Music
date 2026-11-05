// Saved presets, setlists and custom tunings.
// Signed out: kept in localStorage on the device.
// Signed in: stored in PocketBase (collection "presets"), with an offline read cache.
import { settings } from './settings.js';

const AUTH_KEY = 'tt.auth';
const LOCAL_KEY = 'tt.local';
const CACHE_KEY = 'tt.cache';

const readJSON = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const localId = () => 'local_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const fromRecord = (r) => ({ id: r.id, kind: r.kind, name: r.name, data: r.data });

class Store extends EventTarget {
  constructor() {
    super();
    const auth = readJSON(AUTH_KEY, null);
    this.token = auth?.token || null;
    this.user = auth?.record || null;
  }

  get base() { return (settings.serverUrl || '').replace(/\/+$/, ''); }
  get loggedIn() { return !!this.token; }

  async api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = this.token;
    const res = await fetch(this.base + path, { ...opts, headers: { ...headers, ...opts.headers } });
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && this.token) this._setAuth(null);
      const detail = body?.data && Object.values(body.data).map((d) => d?.message).filter(Boolean).join(' ');
      const err = new Error(detail || body?.message || res.statusText || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async health() {
    try { await this.api('/api/health'); return true; } catch { return false; }
  }

  _setAuth(r) {
    this.token = r?.token || null;
    this.user = r?.record || null;
    if (r) localStorage.setItem(AUTH_KEY, JSON.stringify({ token: this.token, record: this.user }));
    else { localStorage.removeItem(AUTH_KEY); localStorage.removeItem(CACHE_KEY); }
    this.dispatchEvent(new Event('change'));
  }

  async login(email, password) {
    const r = await this.api('/api/collections/users/auth-with-password', {
      method: 'POST', body: JSON.stringify({ identity: email, password }),
    });
    this._setAuth(r);
  }

  async signup(email, password) {
    await this.api('/api/collections/users/records', {
      method: 'POST', body: JSON.stringify({ email, password, passwordConfirm: password }),
    });
    await this.login(email, password);
  }

  logout() { this._setAuth(null); }

  /** Saves questionnaire answers on the signed-in user's account. */
  async saveProfile(profile) {
    if (!this.loggedIn) return;
    const r = await this.api(`/api/collections/users/records/${this.user.id}`, {
      method: 'PATCH', body: JSON.stringify({ profile }),
    });
    this.user = r;
    localStorage.setItem(AUTH_KEY, JSON.stringify({ token: this.token, record: r }));
  }

  get profile() { return this.user?.profile || null; }

  /** Refresh the token so long-lived sessions stay signed in. */
  async refresh() {
    if (!this.token) return;
    try {
      const r = await this.api('/api/collections/users/auth-refresh', { method: 'POST' });
      this._setAuth(r);
    } catch { /* offline or expired (401 already signs out) */ }
  }

  // ---- local storage ----
  _local() { return readJSON(LOCAL_KEY, []); }
  _saveLocal(items) { localStorage.setItem(LOCAL_KEY, JSON.stringify(items)); }
  localCount() { return this._local().length; }

  _changed(kind) { this.dispatchEvent(new CustomEvent('items', { detail: kind })); }

  async list(kind) {
    if (!this.loggedIn) return this._local().filter((p) => p.kind === kind).sort(byName);
    const cache = readJSON(CACHE_KEY, {});
    try {
      const filter = encodeURIComponent(`kind="${kind}"`);
      const r = await this.api(`/api/collections/presets/records?perPage=500&sort=name&filter=${filter}`);
      const items = r.items.map(fromRecord);
      cache[kind] = items;
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      return items;
    } catch (e) {
      if (e.status) throw e;
      return cache[kind] || []; // offline: last known list
    }
  }

  async save(kind, name, data, id) {
    if (!this.loggedIn) {
      const items = this._local();
      let item = id && items.find((p) => p.id === id);
      if (item) Object.assign(item, { name, data });
      else { item = { id: localId(), kind, name, data }; items.push(item); }
      this._saveLocal(items);
      this._changed(kind);
      return item;
    }
    const r = id && !id.startsWith('local_')
      ? await this.api(`/api/collections/presets/records/${id}`, { method: 'PATCH', body: JSON.stringify({ name, data }) })
      : await this.api('/api/collections/presets/records', {
        method: 'POST', body: JSON.stringify({ kind, name, data, owner: this.user.id }),
      });
    this._changed(kind);
    return fromRecord(r);
  }

  async remove(item) {
    if (!this.loggedIn || item.id.startsWith('local_')) {
      this._saveLocal(this._local().filter((p) => p.id !== item.id));
    } else {
      await this.api(`/api/collections/presets/records/${item.id}`, { method: 'DELETE' });
    }
    this._changed(item.kind);
  }

  /** Moves presets saved on this device into the signed-in account. */
  async uploadLocal() {
    const items = this._local();
    let moved = 0;
    for (const p of items) {
      await this.api('/api/collections/presets/records', {
        method: 'POST', body: JSON.stringify({ kind: p.kind, name: p.name, data: p.data, owner: this.user.id }),
      });
      moved++;
    }
    this._saveLocal([]);
    ['metronome', 'setlist', 'tuning'].forEach((k) => this._changed(k));
    return moved;
  }
}

export const store = new Store();
