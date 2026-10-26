/* Shared helpers: API calls, session, formatting, icons, toasts and modals. */
'use strict';

const FT = (() => {
  const TOKEN_KEY = 'ft_token';
  const USER_KEY = 'ft_user';

  const store = {
    get(k, fallback = null) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const session = {
    get token() { return store.get(TOKEN_KEY); },
    get user() { return store.get(USER_KEY); },
    save(token, user) { store.set(TOKEN_KEY, token); store.set(USER_KEY, user); },
    setUser(user) { store.set(USER_KEY, user); },
    clear() { store.del(TOKEN_KEY); store.del(USER_KEY); },
  };

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  let onUnauthorized = () => { location.href = '/'; };

  async function api(path, { method = 'GET', body, raw = false, timeout = 25000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const headers = {};
    const token = session.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers, signal: ctrl.signal, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, navigator.onLine ? 'Server not reachable. It may be waking up — try again in a moment.' : 'No internet connection.');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 && path !== '/api/auth/login') {
      session.clear();
      onUnauthorized();
      throw new ApiError(401, 'Your session has expired. Please sign in again.');
    }
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try {
        const j = await res.json();
        if (typeof j.detail === 'string') msg = j.detail;
        else if (Array.isArray(j.detail)) msg = j.detail.map(d => `${(d.loc || []).slice(-1)[0] || ''} ${d.msg}`.trim()).join('; ');
      } catch { /* not json */ }
      throw new ApiError(res.status, msg);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    return res.json();
  }

  /* ---------- formatting ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toDate = (iso) => (iso ? new Date(iso) : null);
  const pad = (n) => String(n).padStart(2, '0');

  function fmtTime(iso) {
    const d = toDate(iso); if (!d) return '—';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDateTime(iso) {
    const d = toDate(iso); if (!d) return '—';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const yest = new Date(today); yest.setDate(today.getDate() - 1);
    const day = sameDay ? 'Today' : d.toDateString() === yest.toDateString() ? 'Yesterday'
      : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
    return `${day}, ${fmtTime(iso)}`;
  }
  function fmtDuration(seconds) {
    if (seconds == null || isNaN(seconds)) return '—';
    seconds = Math.max(0, Math.round(seconds));
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    if (h) return `${h}h ${pad(m)}m`;
    if (m) return `${m}m ${pad(s)}s`;
    return `${s}s`;
  }
  function fmtClock(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  function fmtAgo(seconds) {
    if (seconds == null) return '—';
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${Math.round(seconds)}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
  const secondsSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 1000 : null);
  const fmtKm = (km) => (km == null ? '—' : km < 10 ? km.toFixed(2) : km.toFixed(1));
  const fmtSpeed = (k) => (k == null ? '—' : Math.round(k));
  const tzOffsetMinutes = () => -new Date().getTimezoneOffset();

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000, r = Math.PI / 180;
    const dp = (lat2 - lat1) * r, dl = (lng2 - lng1) * r;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- icons (stroke icons, 24px grid) ---------- */
  const P = {
    pin: '<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.6"/>',
    map: '<path d="m9 4-6 2.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
    route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H17a3.5 3.5 0 0 0 0-7H7a3.5 3.5 0 0 1 0-7h8.5"/>',
    truck: '<path d="M3 6h11v10H3z"/><path d="M14 9h4l3 3.5V16h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14a6.5 6.5 0 0 1 3 6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    alert: '<path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M15 8l2 2"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    wifi: '<path d="M5 12.6a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0M12 20h.01"/>',
    wifiOff: '<path d="m2 2 20 20M8.5 16.1a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 5.2-2.8M2 8.8A15 15 0 0 1 6.3 6M17 9.6a10 10 0 0 1 2 1.6M22 8.8a15 15 0 0 0-11.6-3.7M12 20h.01"/>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 13a3 3 0 0 0 1 5.9z"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
    nav: '<path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/>',
    crosshair: '<circle cx="12" cy="12" r="9"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    flag: '<path d="M4 22V4s1.5-1 5-1 5 2 8 2 3-.5 3-.5V15s-1 .8-3 .8-5-2-8-2-5 1-5 1"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4M12 2v13"/>',
    battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  };
  const icon = (name, cls = '') =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  const solidIcon = (name, cls = '') =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">${P[name] || ''}</svg>`;

  function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach(el => {
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
      el.removeAttribute('data-icon');
    });
  }

  /* ---------- toasts ---------- */
  function toast(message, type = 'info', ms = 3800) {
    let host = document.querySelector('.toasts');
    if (!host) { host = document.createElement('div'); host.className = 'toasts'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = `toast glass ${type}`;
    const ic = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' }[type] || 'info';
    el.innerHTML = `${icon(ic)}<span></span>`;
    el.querySelector('span').textContent = message;
    host.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s, transform .3s'; el.style.opacity = '0'; el.style.transform = 'translateY(-6px)'; }, ms);
    setTimeout(() => el.remove(), ms + 350);
  }

  /* ---------- modal ---------- */
  function modal(html, { wide = false, onClose } = {}) {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal glass ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    hydrateIcons(back);
    const first = back.querySelector('input:not([type=hidden]), select, textarea');
    if (first && !wide) setTimeout(() => first.focus(), 50);
    return { el: back.firstElementChild, close };
  }

  function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, withNote = false, notePlaceholder = '' }) {
    return new Promise(resolve => {
      const m = modal(`
        <h2>${esc(title)}</h2>
        <p class="sub">${esc(message)}</p>
        ${withNote ? `<div class="field"><textarea class="input" id="cd-note" maxlength="300" placeholder="${esc(notePlaceholder)}"></textarea></div>` : ''}
        <div class="modal-actions">
          <button class="btn btn-ghost" data-close>Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cd-ok">${esc(confirmText)}</button>
        </div>`, { onClose: () => resolve(null) });
      m.el.querySelector('#cd-ok').addEventListener('click', () => {
        const note = withNote ? m.el.querySelector('#cd-note').value.trim() : '';
        resolve({ note }); m.close();
      });
    });
  }

  async function withBusy(btn, fn) {
    if (btn.disabled) return;
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
  }

  function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

  function requireRole(role) {
    const u = session.user;
    if (!session.token || !u) { location.replace('/'); return null; }
    if (u.must_change_password) { location.replace('/?change=1'); return null; }
    if (u.role !== role) { location.replace(u.role === 'admin' ? '/control' : '/driver'); return null; }
    return u;
  }

  async function downloadCsv(path, filename) {
    const res = await api(path, { raw: true, timeout: 60000 });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function randomPassword() {
    const words = 'amber,blaze,cedar,delta,ember,falcon,glacier,harbor,indigo,jasper,kestrel,lotus,meteor,nimbus,orbit,pine,quartz,raven,summit,tiger,umber,vector,willow,zenith'.split(',');
    const b = crypto.getRandomValues(new Uint32Array(3));
    const w = (i) => { const s = words[b[i] % words.length]; return s[0].toUpperCase() + s.slice(1); };
    return `${w(0)}-${w(1)}-${(b[2] % 900) + 100}`;
  }

  async function logout() {
    session.clear();
    location.replace('/');
  }

  return {
    api, ApiError, session, store, esc, fmtTime, fmtDateTime, fmtDuration, fmtClock, fmtAgo, fmtKm, fmtSpeed,
    secondsSince, tzOffsetMinutes, haversine, uuid, icon, solidIcon, hydrateIcons, toast, modal, confirmDialog,
    withBusy, setUnauthorizedHandler, requireRole, downloadCsv, randomPassword, logout,
  };
})();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
