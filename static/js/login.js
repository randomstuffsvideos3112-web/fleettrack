'use strict';
(() => {
  const { api, session, hydrateIcons, icon } = FT;
  hydrateIcons();

  const $ = (id) => document.getElementById(id);
  const loginForm = $('login-form'), changeForm = $('change-form');
  const params = new URLSearchParams(location.search);
  let lastPassword = '';  // pre-fills 'current password' right after first sign-in

  const home = (user) => (user.role === 'admin' ? '/control' : '/driver');
  const showError = (el, msg) => { el.textContent = msg; el.classList.toggle('hidden', !msg); };

  function showChange() {
    loginForm.classList.add('hidden');
    changeForm.classList.remove('hidden');
    $('cur-pw').value = lastPassword;
    const u = session.user;
    if (u && !u.must_change_password) {
      // Voluntary change from the menu: allow going back.
      $('change-cancel').textContent = 'Cancel';
      $('change-cancel').onclick = () => location.replace(home(u));
    }
    ($('cur-pw').value ? $('new-pw') : $('cur-pw')).focus();
  }

  // Already signed in? Go straight to the right screen.
  const existing = session.user;
  if (session.token && existing) {
    if (existing.must_change_password || params.get('change')) showChange();
    else location.replace(home(existing));
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('login-error'), '');
    const username = $('username').value.trim(), password = $('password').value;
    if (!username || !password) return showError($('login-error'), 'Enter your username and password.');
    await FT.withBusy($('login-btn'), async () => {
      try {
        const r = await api('/api/auth/login', { method: 'POST', body: { username, password }, timeout: 70000 });
        session.save(r.token, r.user);
        if (r.user.must_change_password) {
          lastPassword = password;
          showChange();
        } else {
          location.replace(home(r.user));
        }
      } catch (err) {
        showError($('login-error'), err.message);
      }
    });
  });

  changeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('change-error'), '');
    const cur = $('cur-pw').value, pw = $('new-pw').value, pw2 = $('new-pw2').value;
    if (pw !== pw2) return showError($('change-error'), 'The two new passwords do not match.');
    await FT.withBusy($('change-btn'), async () => {
      try {
        const r = await api('/api/auth/change-password', { method: 'POST', body: { current_password: cur, new_password: pw } });
        session.save(r.token, r.user);
        location.replace(home(r.user));
      } catch (err) {
        showError($('change-error'), err.message);
      }
    });
  });

  if (!$('change-cancel').onclick) $('change-cancel').onclick = () => FT.logout();

  // "Add to home screen" guidance so the app opens full-screen like a native app.
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const hint = $('install-hint');
  if (!standalone && ios) {
    hint.innerHTML = `${icon('share')}<span>On iPhone, tap <b>Share</b> then <b>Add to Home Screen</b> to install FleetTrack as an app.</span>`;
    hint.classList.remove('hidden');
  }
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    hint.innerHTML = `${icon('phone')}<span>Install FleetTrack on this phone for quick, full-screen access. <a href="#" id="do-install">Install app</a></span>`;
    hint.classList.remove('hidden');
    $('do-install').addEventListener('click', (e) => { e.preventDefault(); ev.prompt(); hint.classList.add('hidden'); });
  });
})();
