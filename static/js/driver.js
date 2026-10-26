/* Driver app: choose a vehicle, record GPS during the trip, queue points offline, end the trip. */
'use strict';
(() => {
  const { api, store, esc, icon, toast } = FT;
  const user = FT.requireRole('driver');
  if (!user) return;

  // Recording rules
  const RECORD_EVERY_MS = 5000;     // one point every 5 s ...
  const RECORD_MOVE_M = 40;         // ... or sooner after moving 40 m
  const FLUSH_EVERY_MS = 10000;     // upload every 10 s when online
  const BATCH = 200;
  const MAX_QUEUE = 40000;          // ~55 hours of points
  const MAX_ACCURACY_M = 50;
  const ARC = 395.8;

  const QUEUE_KEY = 'ft_queue';           // [{trip_id, ...point}]
  const ENDS_KEY = 'ft_pending_ends';     // [{trip_id, ended_at, note}]
  const TRIP_KEY = 'ft_active_trip';      // cached trip so the screen works offline
  const STATS_KEY = 'ft_trip_stats';      // local distance/max speed for the active trip

  const $ = (id) => document.getElementById(id);
  FT.hydrateIcons();
  FT.setUnauthorizedHandler(() => location.replace('/'));  // queue stays saved on the phone

  let trip = null;
  let vehicles = [];
  let selectedVehicle = null;
  let watchId = null;
  let lastFix = null;          // latest GPS reading (for display)
  let lastRecorded = null;     // latest point put into the queue
  let stats = null;            // {distance_km, max_kmh, anchor:[lat,lng]}
  let flushing = false;
  let lastSyncAt = null;
  let syncError = null;
  let backoffUntil = 0;
  let wakeLock = null;
  let hiddenAt = null;
  let overBuzzAt = 0;
  let tickTimer = null;

  /* ---------------- queue storage ---------------- */
  const queue = () => store.get(QUEUE_KEY, []);
  const pendingEnds = () => store.get(ENDS_KEY, []);
  function saveQueue(q) {
    if (q.length > MAX_QUEUE) q = q.slice(q.length - MAX_QUEUE);
    if (!store.set(QUEUE_KEY, q)) toast('Phone storage is full — some points could not be saved.', 'err');
  }

  /* ---------------- screens ---------------- */
  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
    $('loading').classList.add('hidden');
    window.scrollTo(0, 0);
  }

  $('hello').innerHTML = `${esc(user.full_name.split(' ')[0])}<small>Driver</small>`;

  /* ---------------- network pill / banner ---------------- */
  function renderNet() {
    const pill = $('net-pill');
    const online = navigator.onLine;
    pill.className = 'net-pill' + (online ? '' : ' off');
    pill.innerHTML = online ? `${icon('wifi')}Online` : `${icon('wifiOff')}Offline`;
    const q = queue().length, e = pendingEnds().length;
    const banner = $('sync-banner');
    const showBanner = !trip && (q || e);
    banner.classList.toggle('hidden', !showBanner);
    if (showBanner) banner.innerHTML = `${icon('upload')}<span>${q ? `${q} saved points` : ''}${q && e ? ' and ' : ''}${e ? 'a finished trip' : ''} waiting to upload.${online ? ' Uploading…' : ' Will upload when online.'}</span>`;
    renderStartButton();
  }
  addEventListener('online', () => { renderNet(); backoffUntil = 0; flush(); });
  addEventListener('offline', renderNet);

  /* ---------------- vehicle selection ---------------- */
  async function loadSelect() {
    show('screen-select');
    renderNet();
    try {
      vehicles = await api('/api/vehicles');
      store.set('ft_vehicles', vehicles);
    } catch (e) {
      vehicles = store.get('ft_vehicles', []);
      if (e.status !== 401) toast(e.message, 'warn');
    }
    renderVehicles();
    loadRecent();
  }

  function renderVehicles() {
    const q = $('vehicle-search').value.trim().toUpperCase().replace(/\s+/g, '');
    const list = vehicles.filter(v => !q || v.number.replace(/\s+/g, '').includes(q) || (v.description || '').toUpperCase().includes(q));
    if (!list.length) {
      $('vehicle-list').innerHTML = `<div class="empty">${icon('truck')}<div>${vehicles.length ? 'No vehicle matches your search.' : 'No vehicles yet. Ask the control room to add one.'}</div></div>`;
      return;
    }
    $('vehicle-list').innerHTML = list.map(v => `
      <button class="v-card ${selectedVehicle?.id === v.id ? 'sel' : ''}" data-id="${v.id}" ${v.in_use ? 'disabled' : ''}>
        <span class="v-icon">${icon('truck')}</span>
        <span class="v-main">
          ${v.default_driver_id === user.id ? '<span class="v-tag">Assigned to you</span>' : ''}
          <div class="v-num">${esc(v.number)}</div>
          <div class="v-desc">${esc([v.vehicle_type, v.description].filter(Boolean).join(' · ') || '—')}</div>
        </span>
        <span class="v-side">${v.in_use ? '<b>In use</b>' : `<b>${v.speed_limit_kmh}</b>km/h limit`}</span>
      </button>`).join('');
  }

  function renderStartButton() {
    const blocked = pendingEnds().length > 0;
    const btn = $('start-btn');
    btn.disabled = !selectedVehicle || blocked || !navigator.onLine;
    $('start-label').textContent = blocked ? 'Uploading previous trip…'
      : !navigator.onLine ? 'Go online to start a trip'
      : selectedVehicle ? `Start trip · ${selectedVehicle.number}` : 'Select a vehicle';
  }

  $('vehicle-list').addEventListener('click', (e) => {
    const card = e.target.closest('.v-card');
    if (!card || card.disabled) return;
    selectedVehicle = vehicles.find(v => v.id === Number(card.dataset.id));
    renderVehicles();
    renderStartButton();
  });
  $('vehicle-search').addEventListener('input', renderVehicles);

  async function loadRecent() {
    try {
      const trips = await api('/api/trips/mine');
      const done = trips.filter(t => t.status === 'ended').slice(0, 5);
      $('recent-list').innerHTML = done.length ? done.map(t => `
        <div class="r-item">
          <div><b>${esc(t.vehicle_number)}</b><div class="muted small">${FT.fmtDateTime(t.start_time)}</div></div>
          <div style="text-align:right"><b class="num">${FT.fmtKm(t.distance_km)} km</b>
          <div class="muted small">${FT.fmtDuration((new Date(t.end_time) - new Date(t.start_time)) / 1000)}${t.overspeed_count ? ` · <span style="color:#fda4af">${t.overspeed_count} overspeed</span>` : ''}</div></div>
        </div>`).join('') : '<div class="muted small">No trips yet.</div>';
    } catch { $('recent-list').innerHTML = '<div class="muted small">Not available offline.</div>'; }
  }

  $('start-btn').addEventListener('click', () => FT.withBusy($('start-btn'), async () => {
    if (!selectedVehicle) return;
    // Ask for location first, so the trip never starts without GPS permission.
    const ok = await askLocation();
    if (!ok) return;
    try {
      trip = await api('/api/trips/start', { method: 'POST', body: { vehicle_id: selectedVehicle.id, purpose: $('purpose').value.trim() || null } });
      store.set(TRIP_KEY, trip);
      stats = { trip_id: trip.id, distance_km: 0, max_kmh: 0, anchor: null };
      store.set(STATS_KEY, stats);
      $('purpose').value = '';
      selectedVehicle = null;
      toast('Trip started. Drive safe!', 'ok');
      startTrip();
    } catch (e) {
      toast(e.message, 'err');
      if (e.status === 409) loadSelect();
    }
  }));

  function askLocation() {
    return new Promise(resolve => {
      if (!('geolocation' in navigator)) { toast('This phone does not support location.', 'err'); return resolve(false); }
      navigator.geolocation.getCurrentPosition(() => resolve(true), (err) => {
        if (err.code === err.PERMISSION_DENIED) { showGpsHelp(); resolve(false); }
        else resolve(true);  // timeout or no fix yet is fine: watchPosition keeps trying
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    });
  }

  function showGpsHelp() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    $('gps-howto').innerHTML = ios ? `<ol>
        <li>Open <b>Settings</b> → <b>Privacy &amp; Security</b> → <b>Location Services</b>.</li>
        <li>Turn Location Services <b>on</b>.</li>
        <li>Scroll to <b>Safari Websites</b> (or FleetTrack) and choose <b>While Using the App</b> and turn on <b>Precise Location</b>.</li>
        <li>Come back here and tap <b>Try again</b>.</li></ol>`
      : `<ol>
        <li>Tap the <b>lock icon</b> next to the web address (or open Chrome → <b>Settings</b> → <b>Site settings</b> → <b>Location</b>).</li>
        <li>Set Location to <b>Allow</b> for this site.</li>
        <li>Make sure phone <b>Location</b> is turned on in quick settings, with <b>Google Location Accuracy</b> on.</li>
        <li>Come back here and tap <b>Try again</b>.</li></ol>`;
    show('screen-gps');
  }
  $('gps-retry').addEventListener('click', async () => {
    if (trip) { show('screen-trip'); startGps(); }
    else loadSelect();
  });

  /* ---------------- trip recording ---------------- */
  function startTrip() {
    show('screen-trip');
    $('trip-vehicle').textContent = trip.vehicle_number;
    $('trip-purpose').textContent = trip.purpose || '';
    const limit = trip.speed_limit_kmh;
    $('limit-pill').textContent = `Limit ${limit}`;
    const s = store.get(STATS_KEY);
    stats = s && s.trip_id === trip.id ? s : { trip_id: trip.id, distance_km: trip.distance_km || 0, max_kmh: trip.max_speed_kmh || 0, anchor: null };
    stats.distance_km = Math.max(stats.distance_km, trip.distance_km || 0);
    stats.max_kmh = Math.max(stats.max_kmh, trip.max_speed_kmh || 0);
    const scale = gaugeMax();
    $('g-limit').style.transform = `rotate(${90 + Math.min(limit / scale, 1) * 270}deg)`;
    renderSpeed(null);
    renderStats();
    startGps();
    requestWakeLock();
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 1000);
    tick();
  }

  const gaugeMax = () => Math.max(80, Math.ceil((trip.speed_limit_kmh * 1.6) / 20) * 20);

  function startGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function onGpsError(err) {
    if (err.code === err.PERMISSION_DENIED) { stopGps(); showGpsHelp(); }
    else setGpsStatus('Searching for signal…', 'warn');
  }

  function onFix(pos) {
    const c = pos.coords;
    const speedKmh = c.speed != null && c.speed >= 0 && !Number.isNaN(c.speed) ? c.speed * 3.6 : null;
    const heading = c.heading != null && !Number.isNaN(c.heading) && c.heading >= 0 ? c.heading : null;
    const fix = { t: pos.timestamp || Date.now(), lat: c.latitude, lng: c.longitude, acc: c.accuracy, speed: speedKmh, heading };
    let shownSpeed = speedKmh;
    if (shownSpeed == null && lastFix && fix.acc <= 25 && lastFix.acc <= 25) {
      const secs = (fix.t - lastFix.t) / 1000;
      if (secs >= 2) shownSpeed = FT.haversine(lastFix.lat, lastFix.lng, fix.lat, fix.lng) / secs * 3.6;
    }
    fix.shown = shownSpeed;
    lastFix = fix;

    const acc = Math.round(fix.acc);
    setGpsStatus(`±${acc} m`, acc <= 20 ? 'good' : acc <= MAX_ACCURACY_M ? 'warn' : 'bad');
    renderSpeed(shownSpeed);

    const due = !lastRecorded || fix.t - lastRecorded.t >= RECORD_EVERY_MS
      || FT.haversine(lastRecorded.lat, lastRecorded.lng, fix.lat, fix.lng) >= RECORD_MOVE_M;
    if (due && fix.acc <= 1000) record(fix);
  }

  function record(fix) {
    lastRecorded = fix;
    const q = queue();
    q.push({
      trip_id: trip.id, client_id: FT.uuid(), recorded_at: new Date(fix.t).toISOString(),
      lat: +fix.lat.toFixed(7), lng: +fix.lng.toFixed(7),
      speed_kmh: fix.speed != null ? +fix.speed.toFixed(1) : null,
      accuracy_m: +fix.acc.toFixed(1), heading: fix.heading != null ? +fix.heading.toFixed(0) : null,
    });
    saveQueue(q);

    // Local distance, same rule as the server: count only clear movement with a good fix.
    if (fix.acc <= MAX_ACCURACY_M) {
      if (!stats.anchor) stats.anchor = [fix.lat, fix.lng];
      else {
        const moved = FT.haversine(stats.anchor[0], stats.anchor[1], fix.lat, fix.lng);
        if (moved >= Math.max(10, fix.acc)) { stats.distance_km += moved / 1000; stats.anchor = [fix.lat, fix.lng]; }
      }
      if (fix.shown != null && fix.shown < 250) stats.max_kmh = Math.max(stats.max_kmh, fix.shown);
      store.set(STATS_KEY, stats);
    }
    renderStats();
    if (q.length >= 30) flush();
  }

  function renderSpeed(kmh) {
    const v = kmh == null ? 0 : kmh;
    $('speed').textContent = kmh == null ? '–' : Math.round(v);
    const frac = Math.min(v / gaugeMax(), 1);
    $('g-value').style.strokeDasharray = `${(ARC * frac).toFixed(1)} 527.8`;
    const over = kmh != null && v > trip.speed_limit_kmh;
    $('gauge').classList.toggle('over', over);
    $('over-banner').classList.toggle('hidden', !over);
    if (over && Date.now() - overBuzzAt > 15000) {
      overBuzzAt = Date.now();
      navigator.vibrate?.([200, 100, 200]);
    }
  }

  function renderStats() {
    $('st-dist').textContent = FT.fmtKm(stats.distance_km);
    $('st-max').textContent = Math.round(stats.max_kmh);
  }

  function setGpsStatus(text, cls) {
    const el = $('st-gps');
    el.textContent = text;
    el.className = 'sr-value ' + (cls || '');
  }

  function tick() {
    if (!trip) return;
    $('st-time').textContent = FT.fmtClock((Date.now() - new Date(trip.start_time).getTime()) / 1000);
    const n = queue().filter(p => p.trip_id === trip.id).length;
    const el = $('st-sync');
    if (!navigator.onLine) { el.textContent = `Offline · ${n} saved`; el.className = 'sr-value warn'; }
    else if (syncError && n) { el.textContent = `Retrying · ${n} waiting`; el.className = 'sr-value warn'; }
    else if (lastSyncAt) { el.textContent = `Live · sent ${FT.fmtAgo((Date.now() - lastSyncAt) / 1000)}${n > 5 ? ` · ${n} waiting` : ''}`; el.className = 'sr-value good'; }
    else { el.textContent = n ? `${n} waiting` : 'Waiting for first point'; el.className = 'sr-value'; }
    if (lastFix && Date.now() - lastFix.t > 30000) setGpsStatus('Signal lost — searching…', 'bad');
  }

  /* ---------------- upload ---------------- */
  async function flush() {
    if (flushing || !navigator.onLine || Date.now() < backoffUntil) return;
    flushing = true;
    try {
      // 1. points, oldest first, grouped by trip
      for (;;) {
        const q = queue();
        if (!q.length) break;
        const tripId = q[0].trip_id;
        const batch = q.filter(p => p.trip_id === tripId).slice(0, BATCH);
        const points = batch.map(({ trip_id, ...p }) => p);
        try {
          const r = await api(`/api/trips/${tripId}/points`, { method: 'POST', body: { points }, timeout: 70000 });
          if (r.trip_status === 'ended' && trip && trip.id === tripId) endedByControl();
        } catch (e) {
          if (e.status === 404 || e.status === 422) {
            // Trip no longer exists or data is unusable: drop those points rather than retrying forever.
            console.warn('Dropping points for trip', tripId, e.message);
          } else throw e;
        }
        const sent = new Set(batch.map(p => p.client_id));
        saveQueue(queue().filter(p => !sent.has(p.client_id)));
        lastSyncAt = Date.now();
        syncError = null;
      }
      // 2. trips that were ended while offline
      for (const end of pendingEnds()) {
        try {
          await api(`/api/trips/${end.trip_id}/end`, { method: 'POST', body: { ended_at: end.ended_at, note: end.note }, timeout: 70000 });
        } catch (e) {
          if (e.status !== 404) throw e;
        }
        store.set(ENDS_KEY, pendingEnds().filter(x => x.trip_id !== end.trip_id));
      }
      backoffUntil = 0;
    } catch (e) {
      syncError = e.message;
      backoffUntil = Date.now() + 15000;
    } finally {
      flushing = false;
      renderNet();
      tick();
    }
  }
  setInterval(flush, FLUSH_EVERY_MS);

  function endedByControl() {
    stopGps();
    releaseWakeLock();
    clearInterval(tickTimer);
    trip = null; lastFix = null; lastRecorded = null;
    store.del(TRIP_KEY); store.del(STATS_KEY);
    toast('The control room has ended this trip.', 'warn', 7000);
    loadSelect();
  }

  /* ---------------- end trip ---------------- */
  $('end-btn').addEventListener('click', async () => {
    const r = await FT.confirmDialog({
      title: `End trip on ${trip.vehicle_number}?`,
      message: 'Recording will stop. You can add a short note for the control room.',
      confirmText: 'End trip', danger: true, withNote: true, notePlaceholder: 'e.g. Reached depot, fuel 3/4',
    });
    if (!r) return;
    stopGps();
    releaseWakeLock();
    clearInterval(tickTimer);
    const ended = { trip_id: trip.id, ended_at: new Date().toISOString(), note: r.note || null };
    store.set(ENDS_KEY, [...pendingEnds().filter(x => x.trip_id !== trip.id), ended]);
    const finished = { ...trip, stats: { ...stats } };
    trip = null; lastFix = null; lastRecorded = null;
    store.del(TRIP_KEY); store.del(STATS_KEY);
    await flush();
    const uploaded = !pendingEnds().some(x => x.trip_id === finished.id);
    showSummary(finished, uploaded);
  });

  async function showSummary(t, uploaded) {
    show('screen-summary');
    let s = { distance_km: t.stats.distance_km, max_speed_kmh: t.stats.max_kmh, overspeed_count: 0 };
    if (uploaded) {
      try { s = (await api(`/api/trips/${t.id}`)).trip; } catch { /* keep local */ }
    }
    $('sum-sub').textContent = `${t.vehicle_number}${uploaded ? '' : ' · will upload when online'}`;
    $('sum-dist').textContent = `${FT.fmtKm(s.distance_km)} km`;
    $('sum-time').textContent = FT.fmtDuration((Date.now() - new Date(t.start_time).getTime()) / 1000);
    $('sum-max').textContent = `${Math.round(s.max_speed_kmh)} km/h`;
    $('sum-alert').classList.toggle('hidden', !s.overspeed_count);
    $('sum-alert').textContent = `${s.overspeed_count} overspeed event${s.overspeed_count === 1 ? '' : 's'} recorded on this trip.`;
  }
  $('sum-done').addEventListener('click', loadSelect);

  /* ---------------- keep the screen awake ---------------- */
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* not supported or denied */ }
  }
  function releaseWakeLock() { wakeLock?.release().catch(() => {}); wakeLock = null; }

  document.addEventListener('visibilitychange', () => {
    if (!trip) return;
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else {
      requestWakeLock();
      startGps();  // some phones stop the GPS watch while hidden
      if (hiddenAt && Date.now() - hiddenAt > 60000) {
        toast(`Tracking may have paused for ${FT.fmtDuration((Date.now() - hiddenAt) / 1000)} while the app was in the background.`, 'warn', 6000);
      }
      hiddenAt = null;
      flush();
    }
  });

  /* ---------------- menu ---------------- */
  $('menu-btn').addEventListener('click', () => {
    const m = FT.modal(`
      <h2>${esc(user.full_name)}</h2>
      <p class="sub">Signed in as ${esc(user.username)}</p>
      <div class="sheet-menu">
        <button class="btn" id="mi-pw" data-icon="key">Change password</button>
        <button class="btn" id="mi-sync" data-icon="refresh">Upload saved points now</button>
        <button class="btn btn-danger" id="mi-out" data-icon="logout">Sign out</button>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" data-close>Close</button></div>`);
    m.el.querySelector('#mi-pw').addEventListener('click', () => { m.close(); location.href = '/?change=1'; });
    m.el.querySelector('#mi-sync').addEventListener('click', () => { m.close(); backoffUntil = 0; flush(); toast('Uploading…'); });
    m.el.querySelector('#mi-out').addEventListener('click', async () => {
      if (trip) { toast('End your trip before signing out.', 'warn'); return; }
      if (queue().length || pendingEnds().length) {
        const ok = await FT.confirmDialog({ title: 'Sign out?', message: 'Some trip data has not uploaded yet. It stays on this phone and uploads after you sign in again.', confirmText: 'Sign out', danger: true });
        if (!ok) return;
      }
      FT.logout();
    });
  });

  /* ---------------- start up ---------------- */
  async function init() {
    let current;
    try {
      current = await api('/api/trips/current');
      const me = await api('/api/auth/me');
      FT.session.setUser(me);
    } catch (e) {
      if (e.status === 401) return;
      current = store.get(TRIP_KEY);  // offline: resume from the phone's copy
    }
    // A trip ended on this phone but not yet uploaded must not resume.
    if (current && pendingEnds().some(x => x.trip_id === current.id)) current = null;
    if (current) {
      trip = current;
      store.set(TRIP_KEY, trip);
      startTrip();
    } else {
      store.del(TRIP_KEY);
      loadSelect();
    }
    flush();
  }
  init();
})();
