/* Control room dashboard: live map, trips with playback, alerts, vehicles, people, audit log. */
'use strict';
(() => {
  const { api, esc, icon, solidIcon, toast } = FT;
  const me = FT.requireRole('admin');
  if (!me) return;

  const $ = (id) => document.getElementById(id);
  const LIVE_REFRESH_MS = 10000;
  const STATUS = {
    moving: { label: 'Moving', order: 0 },
    stopped: { label: 'Stopped', order: 1 },
    waiting: { label: 'Waiting for GPS', order: 2 },
    stale: { label: 'Signal lost', order: 3 },
    offline: { label: 'Offline', order: 4 },
    idle: { label: 'Parked', order: 5 },
    never: { label: 'No trips yet', order: 6 },
  };

  FT.hydrateIcons();
  $('me-name').textContent = me.full_name;
  $('me-avatar').textContent = (me.full_name || 'A').trim()[0].toUpperCase();

  /* =============== map helpers =============== */
  function baseLayers() {
    const osm = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    return {
      // Free OpenStreetMap tiles, darkened in CSS (no API key needed).
      Dark: L.tileLayer(osm, { maxZoom: 19, attribution: osmAttr, className: 'tiles-dark' }),
      Streets: L.tileLayer(osm, { maxZoom: 19, attribution: osmAttr }),
      Satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19, attribution: 'Imagery &copy; Esri',
      }),
    };
  }

  function makeMap(el, opts = {}) {
    const map = L.map(el, { zoomControl: true, attributionControl: true, preferCanvas: false, ...opts }).setView([22.5, 79], 5);
    const layers = baseLayers();
    let chosen = FT.store.get('ft_basemap', 'Dark');
    if (!layers[chosen]) chosen = 'Dark';
    layers[chosen].addTo(map);
    L.control.layers(layers, null, { position: 'topright' }).addTo(map);
    map.on('baselayerchange', (e) => FT.store.set('ft_basemap', e.name));
    return map;
  }

  function vehicleIcon(v, selected) {
    const cls = `vm s-${v.status}${v.overspeeding ? ' over' : ''}${selected ? ' sel' : ''}`;
    const inner = v.status === 'moving' && v.heading != null
      ? `<span style="display:grid;transform:rotate(${Math.round(v.heading)}deg)">${solidIcon('nav')}</span>`
      : icon('truck');
    return L.divIcon({
      className: '', iconSize: [34, 34], iconAnchor: [17, 17],
      html: `<div class="${cls}"><span class="vm-pulse"></span><span class="vm-core">${inner}</span><span class="vm-label">${esc(v.number)}</span></div>`,
    });
  }

  const pinIcon = (cls, text = '') => L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="pin ${cls}">${text}</div>` });

  /* =============== router =============== */
  const views = ['live', 'trips', 'alerts', 'vehicles', 'people', 'audit'];
  let current = null;
  function route() {
    const v = location.hash.slice(1);
    const view = views.includes(v) ? v : 'live';
    if (view === current) return;
    current = view;
    for (const name of views) $(`view-${name}`).classList.toggle('hidden', name !== view);
    document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.view === view));
    ({ live: showLive, trips: loadTrips, alerts: loadAlerts, vehicles: loadVehicles, people: loadPeople, audit: loadAudit })[view]();
  }
  addEventListener('hashchange', route);

  /* shared lists used by forms and filters */
  let vehiclesCache = [];
  let usersCache = [];
  async function refreshLookups() {
    [vehiclesCache, usersCache] = await Promise.all([api('/api/vehicles'), api('/api/users')]);
  }

  /* =============== LIVE =============== */
  let liveMap = null;
  const markers = new Map();
  const trails = new Map();
  let liveData = null;
  let selectedId = null;
  let statusFilter = null;
  let liveTimer = null;
  let fittedOnce = false;
  let lastLiveOk = null;

  function showLive() {
    if (!liveMap) {
      liveMap = makeMap('map');
      liveMap.on('click', () => selectVehicle(null));
      setTimeout(() => liveMap.invalidateSize(), 50);
    } else {
      setTimeout(() => liveMap.invalidateSize(), 50);
    }
    loadLive();
  }

  async function loadLive() {
    clearTimeout(liveTimer);
    try {
      liveData = await api('/api/live');
      lastLiveOk = Date.now();
      renderLive();
    } catch (e) {
      if (e.status === 401) return;
      $('fp-updated').className = 'fp-updated muted err';
      $('fp-updated').innerHTML = `<span class="live-dot"></span>${esc(e.message)}`;
    }
    if (current === 'live' || current === null) liveTimer = setTimeout(loadLive, document.hidden ? 30000 : LIVE_REFRESH_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && current === 'live') loadLive(); });
  setInterval(() => {
    if (lastLiveOk && current === 'live') {
      $('fp-updated').className = 'fp-updated muted';
      $('fp-updated').innerHTML = `<span class="live-dot"></span>Live · updated ${FT.fmtAgo((Date.now() - lastLiveOk) / 1000)}`;
    }
  }, 1000);

  function renderLive() {
    const vs = liveData.vehicles;
    setAlertBadge(liveData.open_alerts);

    // summary tiles
    const count = (s) => vs.filter(v => (Array.isArray(s) ? s.includes(v.status) : v.status === s)).length;
    const tiles = [
      { key: 'moving', label: 'Moving', n: count('moving'), c: 'var(--green)' },
      { key: 'stopped', label: 'Stopped', n: count(['stopped', 'waiting']), c: 'var(--amber)' },
      { key: 'lost', label: 'No signal', n: count(['stale', 'offline']), c: 'var(--red)' },
      { key: 'idle', label: 'Parked', n: count(['idle', 'never']), c: 'var(--slate)' },
    ];
    $('summary-row').innerHTML = tiles.map(t => `<button class="sum-tile ${statusFilter === t.key ? 'on' : ''}" data-k="${t.key}" style="--c:${t.c}"><b>${t.n}</b><span>${t.label}</span></button>`).join('');

    // list
    const q = $('fleet-search').value.trim().toLowerCase();
    const groupOf = (s) => (s === 'stopped' || s === 'waiting' ? 'stopped' : s === 'stale' || s === 'offline' ? 'lost' : s === 'idle' || s === 'never' ? 'idle' : 'moving');
    const list = vs
      .filter(v => !statusFilter || groupOf(v.status) === statusFilter)
      .filter(v => !q || v.number.toLowerCase().includes(q) || (v.driver_name || '').toLowerCase().includes(q) || (v.description || '').toLowerCase().includes(q))
      .sort((a, b) => STATUS[a.status].order - STATUS[b.status].order || a.number.localeCompare(b.number));

    if (!vs.length) {
      $('fleet-list').innerHTML = `<div class="empty">${icon('truck')}<div>No vehicles yet.</div><a href="#vehicles" class="btn btn-sm" style="margin-top:12px">Add your first vehicle</a></div>`;
    } else if (!list.length) {
      $('fleet-list').innerHTML = '<div class="empty">Nothing matches.</div>';
    } else {
      let lastGroup = null;
      $('fleet-list').innerHTML = list.map(v => {
        const onTrip = v.trip_id != null;
        const group = onTrip ? 'On a trip' : 'Not on a trip';
        const header = group !== lastGroup ? `<div class="fl-group">${group}</div>` : '';
        lastGroup = group;
        const sub = onTrip ? `${esc(v.driver_name)} · ${STATUS[v.status].label}` : `${STATUS[v.status].label}${v.last_seen_at ? ' · ' + FT.fmtDateTime(v.last_seen_at) : ''}`;
        const side = onTrip
          ? `<div class="fl-speed" ${v.overspeeding ? 'style="color:#fda4af"' : ''}>${FT.fmtSpeed(v.speed_kmh)}<small> km/h</small></div><div class="fl-age">${v.seconds_since_update != null ? FT.fmtAgo(v.seconds_since_update) : ''}</div>`
          : '';
        return `${header}<div class="fl-item ${v.vehicle_id === selectedId ? 'sel' : ''}" data-id="${v.vehicle_id}">
          <span class="fl-ico s-${v.status} ${v.overspeeding ? 'over' : ''}">${icon(v.status === 'moving' ? 'nav' : 'truck')}</span>
          <div class="fl-main"><div class="fl-num">${esc(v.number)}</div><div class="fl-sub">${sub}</div></div>
          <div class="fl-side">${side}</div></div>`;
      }).join('');
    }

    // markers and trails
    const seen = new Set();
    for (const v of vs) {
      if (v.lat == null) continue;
      seen.add(v.vehicle_id);
      const key = `${v.status}|${v.overspeeding}|${Math.round((v.heading || 0) / 10)}|${v.vehicle_id === selectedId}|${v.number}`;
      let m = markers.get(v.vehicle_id);
      if (!m) {
        m = L.marker([v.lat, v.lng], { icon: vehicleIcon(v, v.vehicle_id === selectedId), riseOnHover: true }).addTo(liveMap);
        m.on('click', (e) => { L.DomEvent.stopPropagation(e); selectVehicle(v.vehicle_id, true); });
        m._key = key;
        markers.set(v.vehicle_id, m);
      } else {
        m.setLatLng([v.lat, v.lng]);
        if (m._key !== key) { m.setIcon(vehicleIcon(v, v.vehicle_id === selectedId)); m._key = key; }
      }
      m.setZIndexOffset(v.vehicle_id === selectedId ? 1000 : v.trip_id ? 500 : 0);
      m.setOpacity(v.trip_id ? 1 : 0.75);

      const trail = trails.get(v.vehicle_id);
      if (v.trail && v.trail.length > 1) {
        const color = v.overspeeding ? '#f43f5e' : v.status === 'moving' ? '#34d399' : '#22d3ee';
        if (!trail) {
          const glow = L.polyline(v.trail, { color, weight: 10, opacity: 0.15, interactive: false }).addTo(liveMap);
          const line = L.polyline(v.trail, { color, weight: 3.5, opacity: 0.9, interactive: false }).addTo(liveMap);
          trails.set(v.vehicle_id, [glow, line]);
        } else {
          trail.forEach(l => { l.setLatLngs(v.trail); l.setStyle({ color }); });
        }
      } else if (trail) {
        trail.forEach(l => l.remove());
        trails.delete(v.vehicle_id);
      }
    }
    for (const [id, m] of markers) if (!seen.has(id)) { m.remove(); markers.delete(id); }
    for (const [id, t] of trails) if (!seen.has(id)) { t.forEach(l => l.remove()); trails.delete(id); }

    if (!fittedOnce && markers.size) { fitAll(); fittedOnce = true; }
    if (selectedId) renderFloat();

    const open = liveData.open_alerts;
    $('alert-float').classList.toggle('hidden', !open);
    $('alert-float').innerHTML = `${icon('alert')}${open} open overspeed alert${open === 1 ? '' : 's'}`;
  }

  function fitAll() {
    const pts = [...markers.values()].map(m => m.getLatLng());
    if (!pts.length) return;
    if (pts.length === 1) liveMap.setView(pts[0], 14);
    else {
      // Keep vehicles clear of the fleet panel (left on desktop, bottom sheet on phones).
      const mobile = innerWidth <= 900;
      liveMap.fitBounds(L.latLngBounds(pts), {
        paddingTopLeft: mobile ? [40, 60] : [420, 70],
        paddingBottomRight: mobile ? [40, innerHeight * 0.45 + 20] : [60, 60],
        maxZoom: 15,
      });
    }
  }
  $('fit-btn').addEventListener('click', fitAll);

  function selectVehicle(id, fromMap = false) {
    selectedId = id;
    $('v-float').classList.toggle('hidden', !id);
    if (liveData) renderLive();
    if (!id) return;
    const v = liveData.vehicles.find(x => x.vehicle_id === id);
    if (v && v.lat != null && !fromMap) liveMap.flyTo([v.lat, v.lng], Math.max(liveMap.getZoom(), 15), { duration: 0.8 });
    if (innerWidth <= 900) $('fleet-panel').classList.add('collapsed');
  }

  function renderFloat() {
    const v = liveData.vehicles.find(x => x.vehicle_id === selectedId);
    if (!v) { selectVehicle(null); return; }
    const onTrip = v.trip_id != null;
    $('v-float').innerHTML = `
      <div class="vf-head">
        <div><h3>${esc(v.number)}</h3><div class="muted" style="font-size:13px">${esc([v.vehicle_type, v.description].filter(Boolean).join(' · ') || 'Vehicle')}</div></div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="chip s-${v.overspeeding ? 'offline' : v.status}"><span class="dot"></span>${v.overspeeding ? 'Overspeeding' : STATUS[v.status].label}</span>
          <button class="btn btn-ghost btn-sm icon-btn" id="vf-close" aria-label="Close">${icon('x')}</button>
        </div>
      </div>
      ${onTrip ? `
        <div class="vf-grid">
          <div><small>Speed</small><b ${v.overspeeding ? 'class="over-text"' : ''}>${FT.fmtSpeed(v.speed_kmh)}</b> <span class="muted">/ ${v.speed_limit_kmh} km/h</span></div>
          <div><small>Distance</small><b>${FT.fmtKm(v.distance_km)}</b> <span class="muted">km</span></div>
          <div><small>Driver</small><b style="font-size:14px">${esc(v.driver_name)}</b></div>
          <div><small>On trip for</small><b>${FT.fmtDuration(FT.secondsSince(v.trip_started_at))}</b></div>
        </div>
        <div class="muted" style="font-size:12.5px;margin:-4px 0 12px">${v.purpose ? esc(v.purpose) + ' · ' : ''}Last update ${FT.fmtAgo(v.seconds_since_update)}${v.accuracy_m ? ` · ±${Math.round(v.accuracy_m)} m` : ''}</div>
        <div class="vf-actions">
          <button class="btn btn-primary btn-sm" id="vf-trip">${icon('route')}Trip details</button>
          <button class="btn btn-danger btn-sm" id="vf-end">${icon('stop')}End trip</button>
        </div>`
      : `<p class="muted" style="font-size:13.5px">${v.status === 'never' ? 'This vehicle has not made a trip yet.' : `Parked. Last trip ended ${FT.fmtDateTime(v.last_seen_at)} (${esc(v.driver_name || '')}).`}</p>
         <div class="vf-actions"><a class="btn btn-sm" href="#trips" id="vf-history">${icon('list')}Trip history</a></div>`}`;
    $('vf-close').onclick = () => selectVehicle(null);
    if (onTrip) {
      $('vf-trip').onclick = () => openTrip(v.trip_id);
      $('vf-end').onclick = () => forceEnd(v.trip_id, v.number);
    } else {
      $('vf-history').onclick = () => { tripFilterPreset = { vehicle_id: v.vehicle_id }; };
    }
  }

  $('fleet-list').addEventListener('click', (e) => {
    const item = e.target.closest('.fl-item');
    if (item) selectVehicle(Number(item.dataset.id));
  });
  $('summary-row').addEventListener('click', (e) => {
    const t = e.target.closest('.sum-tile');
    if (!t) return;
    statusFilter = statusFilter === t.dataset.k ? null : t.dataset.k;
    renderLive();
  });
  $('fleet-search').addEventListener('input', () => liveData && renderLive());
  $('fp-handle').addEventListener('click', () => $('fleet-panel').classList.toggle('collapsed'));

  async function forceEnd(tripId, number) {
    const r = await FT.confirmDialog({
      title: `End the trip on ${number}?`,
      message: 'Use this when a driver cannot end the trip (for example, phone lost or battery dead). The action is recorded in the audit log.',
      confirmText: 'End trip', danger: true, withNote: true, notePlaceholder: 'Reason (recorded)',
    });
    if (!r) return;
    try {
      await api(`/api/trips/${tripId}/force-end`, { method: 'POST', body: { note: r.note || null } });
      toast('Trip ended.', 'ok');
      loadLive();
    } catch (e) { toast(e.message, 'err'); }
  }

  function setAlertBadge(n) {
    const b = $('alert-badge');
    b.textContent = n > 99 ? '99+' : n;
    b.classList.toggle('hidden', !n);
  }

  /* =============== TRIP DETAIL (modal with playback) =============== */
  async function openTrip(tripId) {
    let data;
    try { data = await api(`/api/trips/${tripId}`); } catch (e) { toast(e.message, 'err'); return; }
    const t = data.trip, pts = data.points, evs = data.overspeed;
    const durS = ((t.end_time ? new Date(t.end_time) : new Date()) - new Date(t.start_time)) / 1000;
    const avg = durS > 60 ? t.distance_km / (durS / 3600) : null;
    const delayed = pts.filter(p => p.delayed).length;

    let player = null;
    const m = FT.modal(`
      <div class="td">
        <div class="td-map-wrap">
          <div class="td-map" id="td-map"></div>
          <button class="btn btn-sm td-close" data-close>${icon('chevronLeft')}Back</button>
          ${pts.length > 1 ? `<div class="player glass">
            <button class="btn btn-primary btn-sm icon-btn" id="p-play" aria-label="Play">${solidIcon('play')}</button>
            <input type="range" id="p-range" min="0" max="${pts.length - 1}" value="0" aria-label="Playback position">
            <select class="input" id="p-rate" aria-label="Playback speed"><option value="10">10×</option><option value="30" selected>30×</option><option value="60">60×</option><option value="180">180×</option></select>
            <div class="p-info"><b id="p-speed">—</b><span id="p-time" class="muted">—</span></div>
          </div>` : ''}
        </div>
        <aside class="td-side">
          <div class="td-head">
            <div class="row"><h2>${esc(t.vehicle_number)}</h2><span class="chip s-${t.status}"><span class="dot"></span>${t.status === 'active' ? 'In progress' : 'Ended'}</span></div>
            <div class="muted" style="font-size:13.5px;margin-top:2px">${esc(t.driver_name)} · ${FT.fmtDateTime(t.start_time)}</div>
          </div>
          <div class="td-body">
            <div class="td-stats">
              <div><small>Distance</small><b>${FT.fmtKm(t.distance_km)}</b> <span class="muted">km</span></div>
              <div><small>Duration</small><b>${FT.fmtDuration(durS)}</b></div>
              <div><small>Top speed</small><b class="${t.max_speed_kmh > t.speed_limit_kmh ? 'over-text' : ''}">${Math.round(t.max_speed_kmh)}</b> <span class="muted">/ ${t.speed_limit_kmh} km/h</span></div>
              <div><small>Average</small><b>${avg != null ? Math.round(avg) : '—'}</b> <span class="muted">km/h</span></div>
            </div>
            <div class="legend"><span><i style="background:#22d3ee"></i>Within limit</span><span><i style="background:#fbbf24"></i>Near limit</span><span><i style="background:#f43f5e"></i>Over limit</span></div>
            <div class="td-section">Details</div>
            <div class="td-kv">
              <span>Purpose</span><span>${esc(t.purpose || '—')}</span>
              <span>Started</span><span>${FT.fmtDateTime(t.start_time)}</span>
              <span>Ended</span><span>${t.end_time ? FT.fmtDateTime(t.end_time) : '—'}</span>
              ${t.ended_by_name && t.ended_by_name !== t.driver_name ? `<span>Ended by</span><span>${esc(t.ended_by_name)} (control)</span>` : ''}
              <span>End note</span><span>${esc(t.end_note || '—')}</span>
              <span>GPS points</span><span>${pts.length}${delayed ? ` <span class="muted">(${delayed} uploaded late)</span>` : ''}</span>
            </div>
            <div class="td-section">Overspeed (${evs.length})</div>
            ${evs.length ? evs.map(e => `<div class="ev-item" data-lat="${e.lat}" data-lng="${e.lng}">
                <span>${FT.fmtTime(e.started_at)} · ${FT.fmtDuration((new Date(e.ended_at) - new Date(e.started_at)) / 1000 || 1)}</span>
                <span><b>${Math.round(e.max_speed_kmh)}</b> / ${e.speed_limit_kmh} km/h</span></div>`).join('')
              : '<div class="muted" style="font-size:14px">None. Well driven.</div>'}
            ${t.status === 'active' ? `<button class="btn btn-danger btn-block" id="td-end" style="margin-top:18px">${icon('stop')}End this trip</button>` : ''}
          </div>
        </aside>
      </div>`, { wide: true, onClose: () => player && clearInterval(player) });

    const map = makeMap(m.el.querySelector('#td-map'));
    if (pts.length) {
      const limit = t.speed_limit_kmh;
      const colorFor = (s) => (s == null ? '#22d3ee' : s > limit ? '#f43f5e' : s > limit * 0.85 ? '#fbbf24' : '#22d3ee');
      // group consecutive points with the same colour into one polyline
      let seg = [[pts[0].lat, pts[0].lng]], segColor = colorFor(pts[0].speed_kmh);
      const all = [[pts[0].lat, pts[0].lng]];
      L.polyline(pts.map(p => [p.lat, p.lng]), { color: '#000', weight: 9, opacity: 0.35, interactive: false }).addTo(map);
      for (let i = 1; i < pts.length; i++) {
        const ll = [pts[i].lat, pts[i].lng];
        all.push(ll);
        const c = colorFor(pts[i].speed_kmh);
        seg.push(ll);
        if (c !== segColor || i === pts.length - 1) {
          L.polyline(seg, { color: segColor, weight: 4.5, opacity: 0.95, interactive: false }).addTo(map);
          seg = [ll]; segColor = c;
        }
      }
      L.marker(all[0], { icon: pinIcon('pin-a', 'A') }).addTo(map).bindPopup(`<b>Start</b><br>${FT.fmtDateTime(pts[0].recorded_at)}`);
      if (t.status === 'ended') L.marker(all[all.length - 1], { icon: pinIcon('pin-b', 'B') }).addTo(map).bindPopup(`<b>End</b><br>${FT.fmtDateTime(pts[pts.length - 1].recorded_at)}`);
      for (const e of evs) {
        L.marker([e.lat, e.lng], { icon: pinIcon('pin-x', '!') }).addTo(map)
          .bindPopup(`<b style="color:#fda4af">${Math.round(e.max_speed_kmh)} km/h</b> in a ${e.speed_limit_kmh} limit<br>${FT.fmtDateTime(e.started_at)}`);
      }
      setTimeout(() => { map.invalidateSize(); map.fitBounds(L.latLngBounds(all), { padding: [50, 50], maxZoom: 16 }); }, 60);

      if (pts.length > 1) {
        const cursor = L.marker(all[0], { icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="pin pin-now"></div>' }), zIndexOffset: 2000 }).addTo(map);
        const range = m.el.querySelector('#p-range');
        const show = (i) => {
          const p = pts[i];
          cursor.setLatLng([p.lat, p.lng]);
          m.el.querySelector('#p-speed').innerHTML = `<span class="${p.speed_kmh > limit ? 'over-text' : ''}">${FT.fmtSpeed(p.speed_kmh)} km/h</span>`;
          m.el.querySelector('#p-time').textContent = new Date(p.recorded_at).toLocaleTimeString();
        };
        show(0);
        range.addEventListener('input', () => show(+range.value));
        const playBtn = m.el.querySelector('#p-play');
        const stop = () => { clearInterval(player); player = null; playBtn.innerHTML = solidIcon('play'); };
        playBtn.addEventListener('click', () => {
          if (player) return stop();
          if (+range.value >= pts.length - 1) range.value = 0;
          playBtn.innerHTML = solidIcon('pause');
          // Real-time pace × rate: step through points by their recorded timestamps.
          let simT = new Date(pts[+range.value].recorded_at).getTime();
          player = setInterval(() => {
            simT += 100 * Number(m.el.querySelector('#p-rate').value);
            let i = +range.value;
            while (i < pts.length - 1 && new Date(pts[i + 1].recorded_at).getTime() <= simT) i++;
            range.value = i; show(i);
            if (i >= pts.length - 1) stop();
          }, 100);
        });
      }
    } else {
      m.el.querySelector('#td-map').insertAdjacentHTML('beforeend', '<div class="empty" style="position:absolute;inset:0;z-index:500;display:grid;place-items:center">No GPS points recorded yet.</div>');
    }
    m.el.querySelectorAll('.ev-item').forEach(el => el.addEventListener('click', () => map.flyTo([+el.dataset.lat, +el.dataset.lng], 17)));
    const endBtn = m.el.querySelector('#td-end');
    if (endBtn) endBtn.addEventListener('click', () => { m.close(); forceEnd(t.id, t.vehicle_number); });
  }

  /* =============== TRIPS =============== */
  let tripFilterPreset = null;
  let filtersReady = false;

  async function loadTrips() {
    try {
      if (!filtersReady) {
        await refreshLookups();
        $('f-vehicle').innerHTML = '<option value="">All vehicles</option>' + vehiclesCache.map(v => `<option value="${v.id}">${esc(v.number)}</option>`).join('');
        $('f-driver').innerHTML = '<option value="">All drivers</option>' + usersCache.filter(u => u.role === 'driver').map(u => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('');
        const d = new Date(); d.setDate(d.getDate() - 7);
        $('f-from').value = d.toLocaleDateString('en-CA');
        filtersReady = true;
      }
      if (tripFilterPreset) { $('f-vehicle').value = tripFilterPreset.vehicle_id; tripFilterPreset = null; }
      const trips = await api('/api/trips?' + tripQuery());
      renderTrips(trips);
    } catch (e) { if (e.status !== 401) toast(e.message, 'err'); }
  }

  function tripQuery(extra = {}) {
    const p = new URLSearchParams();
    if ($('f-vehicle').value) p.set('vehicle_id', $('f-vehicle').value);
    if ($('f-driver').value) p.set('driver_id', $('f-driver').value);
    if ($('f-status').value) p.set('status', $('f-status').value);
    const day = (s, add = 0) => { const [y, mo, d] = s.split('-').map(Number); return new Date(y, mo - 1, d + add).toISOString(); };
    if ($('f-from').value) p.set('start_from', day($('f-from').value));
    if ($('f-to').value) p.set('start_to', day($('f-to').value, 1));
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }

  function renderTrips(trips) {
    const km = trips.reduce((s, t) => s + t.distance_km, 0);
    const alerts = trips.reduce((s, t) => s + t.overspeed_count, 0);
    const active = trips.filter(t => t.status === 'active').length;
    $('trip-kpis').innerHTML = `
      <div class="kpi" style="--c:var(--accent)"><small>Trips</small><b>${trips.length}</b></div>
      <div class="kpi" style="--c:var(--accent-2)"><small>Distance</small><b>${km.toFixed(1)} <small>km</small></b></div>
      <div class="kpi" style="--c:var(--green)"><small>In progress</small><b>${active}</b></div>
      <div class="kpi" style="--c:var(--red)"><small>Overspeed alerts</small><b>${alerts}</b></div>`;
    $('trips-body').innerHTML = trips.length ? trips.map(t => {
      const dur = ((t.end_time ? new Date(t.end_time) : new Date()) - new Date(t.start_time)) / 1000;
      return `<tr class="clickable" data-id="${t.id}">
        <td><div class="cell-main">${esc(t.vehicle_number)}</div><div class="cell-sub">${esc(t.purpose || '')}</div></td>
        <td>${esc(t.driver_name)}</td>
        <td>${FT.fmtDateTime(t.start_time)}</td>
        <td class="num">${FT.fmtDuration(dur)}</td>
        <td class="num">${FT.fmtKm(t.distance_km)} km</td>
        <td class="num ${t.max_speed_kmh > t.speed_limit_kmh ? 'over-text' : ''}">${Math.round(t.max_speed_kmh)} km/h</td>
        <td>${t.overspeed_count ? `<span class="alert-count">${icon('alert')}${t.overspeed_count}</span>` : '<span class="muted">—</span>'}</td>
        <td><span class="chip s-${t.status}"><span class="dot"></span>${t.status === 'active' ? 'In progress' : 'Ended'}</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="8"><div class="empty">${icon('route')}<div>No trips match these filters.</div></div></td></tr>`;
  }

  $('trips-body').addEventListener('click', (e) => { const r = e.target.closest('tr[data-id]'); if (r) openTrip(Number(r.dataset.id)); });
  $('f-apply').addEventListener('click', loadTrips);
  $('trips-export').addEventListener('click', (e) => FT.withBusy(e.currentTarget, async () => {
    try { await FT.downloadCsv('/api/reports/trips.csv?' + tripQuery({ tz: FT.tzOffsetMinutes() }), `fleettrack-trips-${new Date().toLocaleDateString('en-CA')}.csv`); }
    catch (err) { toast(err.message, 'err'); }
  }));

  /* =============== ALERTS =============== */
  let alertMode = 'open';
  async function loadAlerts() {
    try {
      const list = await api(`/api/overspeed?only_open=${alertMode === 'open'}`);
      if (alertMode === 'open') setAlertBadge(list.length);
      $('alert-list').innerHTML = list.length ? list.map(a => `
        <div class="al-card ${a.acknowledged_at ? '' : 'open'}">
          <div class="al-top">
            <div><h3>${esc(a.vehicle_number)}</h3><div class="muted" style="font-size:13px">${esc(a.driver_name)}</div></div>
            <div class="al-speed"><b>${Math.round(a.max_speed_kmh)}</b><small>km/h · limit ${a.speed_limit_kmh}</small></div>
          </div>
          <div class="al-meta">
            <span>${icon('clock').replace('<svg', '<svg style="width:13px;height:13px;vertical-align:-2px;margin-right:4px"')}${FT.fmtDateTime(a.started_at)} · lasted ${FT.fmtDuration((new Date(a.ended_at) - new Date(a.started_at)) / 1000 || 1)}</span>
          </div>
          ${a.acknowledged_at ? `<div class="al-ack">${icon('check')}Acknowledged by ${esc(a.acknowledged_by_name)} · ${FT.fmtDateTime(a.acknowledged_at)}${a.ack_note ? ` — “${esc(a.ack_note)}”` : ''}</div>` : ''}
          <div class="al-actions">
            <button class="btn btn-sm" data-trip="${a.trip_id}">${icon('route')}View on route</button>
            ${a.acknowledged_at ? '' : `<button class="btn btn-primary btn-sm" data-ack="${a.id}">${icon('check')}Acknowledge</button>`}
          </div>
        </div>`).join('')
        : `<div class="empty" style="grid-column:1/-1">${icon('shield')}<div>${alertMode === 'open' ? 'No open alerts. All clear.' : 'No overspeed alerts recorded.'}</div></div>`;
    } catch (e) { if (e.status !== 401) toast(e.message, 'err'); }
  }
  $('alert-list').addEventListener('click', async (e) => {
    const tripBtn = e.target.closest('[data-trip]');
    if (tripBtn) return openTrip(Number(tripBtn.dataset.trip));
    const ackBtn = e.target.closest('[data-ack]');
    if (!ackBtn) return;
    const r = await FT.confirmDialog({ title: 'Acknowledge alert', message: 'Add what action was taken (optional). This is recorded.', confirmText: 'Acknowledge', withNote: true, notePlaceholder: 'e.g. Spoke to driver' });
    if (!r) return;
    try {
      await api(`/api/overspeed/${ackBtn.dataset.ack}/ack`, { method: 'POST', body: { note: r.note || null } });
      toast('Alert acknowledged.', 'ok');
      loadAlerts();
    } catch (err) { toast(err.message, 'err'); }
  });
  $('alert-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    alertMode = b.dataset.v;
    $('alert-seg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    loadAlerts();
  });
  $('alerts-export').addEventListener('click', (e) => FT.withBusy(e.currentTarget, async () => {
    try { await FT.downloadCsv(`/api/reports/overspeed.csv?tz=${FT.tzOffsetMinutes()}`, `fleettrack-overspeed-${new Date().toLocaleDateString('en-CA')}.csv`); }
    catch (err) { toast(err.message, 'err'); }
  }));

  /* =============== VEHICLES =============== */
  async function loadVehicles() {
    try {
      await refreshLookups();
      filtersReady = false;
      const driverName = (id) => usersCache.find(u => u.id === id)?.full_name;
      $('vehicles-body').innerHTML = vehiclesCache.length ? vehiclesCache.map(v => `
        <tr>
          <td><div class="cell-main">${esc(v.number)}</div><div class="cell-sub">${esc(v.description || '')}</div></td>
          <td>${esc(v.vehicle_type || '—')}</td>
          <td class="num">${v.speed_limit_kmh} km/h</td>
          <td>${esc(driverName(v.default_driver_id) || '—')}</td>
          <td>${!v.active ? '<span class="chip s-never">Retired</span>' : v.in_use ? '<span class="chip s-moving"><span class="dot"></span>On a trip</span>' : '<span class="chip s-idle">Available</span>'}</td>
          <td style="text-align:right"><button class="btn btn-sm" data-edit="${v.id}">${icon('edit')}Edit</button></td>
        </tr>`).join('')
        : `<tr><td colspan="6"><div class="empty">${icon('truck')}<div>No vehicles yet. Add your first one.</div></div></td></tr>`;
    } catch (e) { if (e.status !== 401) toast(e.message, 'err'); }
  }

  function vehicleForm(v) {
    const drivers = usersCache.filter(u => u.role === 'driver' && u.active);
    const m = FT.modal(`
      <h2>${v ? 'Edit vehicle' : 'Add vehicle'}</h2>
      <p class="sub">${v ? 'Changes apply from the next GPS update.' : 'Drivers will see this vehicle when they start a trip.'}</p>
      <form id="vf">
        <div class="form-error hidden" id="vf-err"></div>
        <div class="field"><label>Vehicle number</label><input class="input" name="number" required maxlength="40" value="${esc(v?.number || '')}" placeholder="e.g. 21B 123456X" style="text-transform:uppercase"></div>
        <div class="row">
          <div class="field"><label>Type</label><input class="input" name="vehicle_type" maxlength="60" value="${esc(v?.vehicle_type || '')}" placeholder="e.g. Gypsy, 2.5 Ton"></div>
          <div class="field"><label>Speed limit (km/h)</label><input class="input" name="speed_limit_kmh" type="number" min="5" max="200" required value="${v?.speed_limit_kmh ?? 60}"></div>
        </div>
        <div class="field"><label>Description</label><input class="input" name="description" maxlength="200" value="${esc(v?.description || '')}" placeholder="Unit, role or any note"></div>
        <div class="field"><label>Usual driver (optional)</label>
          <select class="input" name="default_driver_id"><option value="">No assigned driver</option>
          ${drivers.map(d => `<option value="${d.id}" ${v?.default_driver_id === d.id ? 'selected' : ''}>${esc(d.full_name)}</option>`).join('')}</select>
          <span class="hint">Any driver can still choose this vehicle; it shows first for the assigned one.</span></div>
        ${v ? `<label class="switch"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}>In service</label>` : ''}
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="vf-save">${v ? 'Save changes' : 'Add vehicle'}</button></div>
      </form>`);
    m.el.querySelector('#vf').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        number: f.number.value.trim(), vehicle_type: f.vehicle_type.value.trim() || null,
        description: f.description.value.trim() || null, speed_limit_kmh: Number(f.speed_limit_kmh.value),
        default_driver_id: f.default_driver_id.value ? Number(f.default_driver_id.value) : null,
      };
      if (v) body.active = f.active.checked;
      FT.withBusy(m.el.querySelector('#vf-save'), async () => {
        try {
          await api(v ? `/api/vehicles/${v.id}` : '/api/vehicles', { method: v ? 'PATCH' : 'POST', body });
          m.close(); toast(v ? 'Vehicle updated.' : 'Vehicle added.', 'ok'); loadVehicles();
        } catch (err) { const el = m.el.querySelector('#vf-err'); el.textContent = err.message; el.classList.remove('hidden'); }
      });
    });
  }
  $('add-vehicle').addEventListener('click', async () => { if (!usersCache.length) await refreshLookups(); vehicleForm(null); });
  $('vehicles-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]'); if (!b) return;
    vehicleForm(vehiclesCache.find(v => v.id === Number(b.dataset.edit)));
  });

  /* =============== PEOPLE =============== */
  async function loadPeople() {
    try {
      await refreshLookups();
      filtersReady = false;
      $('people-body').innerHTML = usersCache.map(u => `
        <tr>
          <td><div class="cell-main">${esc(u.full_name)}</div></td>
          <td class="mono">${esc(u.username)}</td>
          <td><span class="chip ${u.role === 'admin' ? 's-waiting' : ''}">${u.role === 'admin' ? 'Control' : 'Driver'}</span></td>
          <td>${esc(u.phone || '—')}</td>
          <td>${u.last_login_at ? FT.fmtDateTime(u.last_login_at) : '<span class="muted">Never</span>'}</td>
          <td>${u.active ? (u.must_change_password ? '<span class="chip s-stopped">Needs new password</span>' : '<span class="chip s-moving"><span class="dot"></span>Active</span>') : '<span class="chip s-never">Disabled</span>'}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-sm" data-pw="${u.id}">${icon('key')}Reset password</button>
            <button class="btn btn-sm" data-edit="${u.id}">${icon('edit')}Edit</button></td>
        </tr>`).join('');
    } catch (e) { if (e.status !== 401) toast(e.message, 'err'); }
  }

  function userForm(u) {
    const suggested = FT.randomPassword();
    const m = FT.modal(`
      <h2>${u ? 'Edit person' : 'Add person'}</h2>
      <p class="sub">${u ? esc(u.username) : 'Give them their username and starting password. They will choose their own password at first sign-in.'}</p>
      <form id="uf">
        <div class="form-error hidden" id="uf-err"></div>
        <div class="field"><label>Full name</label><input class="input" name="full_name" required maxlength="120" value="${esc(u?.full_name || '')}" placeholder="e.g. Hav Ravi Kumar"></div>
        ${u ? '' : `<div class="field"><label>Username</label><input class="input" name="username" required minlength="3" maxlength="50" pattern="[A-Za-z0-9_.\\-]+" autocapitalize="none" placeholder="e.g. ravi.k"><span class="hint">Letters, numbers, dot, dash or underscore.</span></div>`}
        <div class="row">
          <div class="field"><label>Role</label><select class="input" name="role">
            <option value="driver" ${u?.role !== 'admin' ? 'selected' : ''}>Driver</option>
            <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Control room</option></select></div>
          <div class="field"><label>Phone (optional)</label><input class="input" name="phone" maxlength="30" value="${esc(u?.phone || '')}" inputmode="tel"></div>
        </div>
        ${u ? `<label class="switch"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}>Account enabled</label>`
          : `<div class="field"><label>Starting password</label><input class="input mono" name="password" required minlength="8" value="${esc(suggested)}"><span class="hint">Share this privately with the person.</span></div>`}
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="uf-save">${u ? 'Save changes' : 'Add person'}</button></div>
      </form>`);
    m.el.querySelector('#uf').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { full_name: f.full_name.value.trim(), role: f.role.value, phone: f.phone.value.trim() || null };
      if (u) body.active = f.active.checked; else { body.username = f.username.value.trim(); body.password = f.password.value; }
      FT.withBusy(m.el.querySelector('#uf-save'), async () => {
        try {
          await api(u ? `/api/users/${u.id}` : '/api/users', { method: u ? 'PATCH' : 'POST', body });
          m.close();
          if (!u) showCredentials(body.full_name, body.username.toLowerCase(), body.password);
          else toast('Saved.', 'ok');
          loadPeople();
        } catch (err) { const el = m.el.querySelector('#uf-err'); el.textContent = err.message; el.classList.remove('hidden'); }
      });
    });
  }

  function showCredentials(name, username, password) {
    FT.modal(`
      <h2>Sign-in details for ${esc(name)}</h2>
      <p class="sub">Share these privately. The password must be changed at first sign-in.</p>
      <div class="card mono" style="font-size:15px;line-height:1.9">
        Address: ${esc(location.origin)}<br>Username: <b>${esc(username)}</b><br>Password: <b>${esc(password)}</b>
      </div>
      <div class="modal-actions"><button class="btn" id="cp-copy">${icon('check')}Copy</button><button class="btn btn-primary" data-close>Done</button></div>`)
      .el.querySelector('#cp-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(`FleetTrack\n${location.origin}\nUsername: ${username}\nPassword: ${password}`); toast('Copied.', 'ok'); }
        catch { toast('Copy failed — please write it down.', 'warn'); }
      });
  }

  $('add-user').addEventListener('click', () => userForm(null));
  $('people-body').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) return userForm(usersCache.find(u => u.id === Number(edit.dataset.edit)));
    const pw = e.target.closest('[data-pw]');
    if (!pw) return;
    const u = usersCache.find(x => x.id === Number(pw.dataset.pw));
    const ok = await FT.confirmDialog({ title: `Reset password for ${u.full_name}?`, message: 'They will be signed out on all phones and must use the new password.', confirmText: 'Reset password', danger: true });
    if (!ok) return;
    const newPw = FT.randomPassword();
    try {
      await api(`/api/users/${u.id}/reset-password`, { method: 'POST', body: { new_password: newPw } });
      showCredentials(u.full_name, u.username, newPw);
      loadPeople();
    } catch (err) { toast(err.message, 'err'); }
  });

  /* =============== AUDIT =============== */
  const ACTIONS = {
    login: 'Signed in', login_failed: 'Failed sign-in', password_changed: 'Changed password', logout_everywhere: 'Signed out everywhere',
    user_created: 'Added person', user_updated: 'Edited person', password_reset: 'Reset password',
    vehicle_created: 'Added vehicle', vehicle_updated: 'Edited vehicle',
    trip_started: 'Started trip', trip_ended: 'Ended trip', trip_force_ended: 'Ended trip (control)',
    overspeed_acknowledged: 'Acknowledged alert', report_exported: 'Exported report',
    admin_password_reset_by_server: 'Admin password reset (server)',
  };
  async function loadAudit() {
    try {
      const rows = await api('/api/audit?limit=300');
      $('audit-body').innerHTML = rows.map(a => `
        <tr>
          <td>${FT.fmtDateTime(a.created_at)}</td>
          <td>${esc(a.user_name || '—')}</td>
          <td><span class="chip ${a.action === 'login_failed' || a.action === 'trip_force_ended' ? 's-offline' : ''}">${esc(ACTIONS[a.action] || a.action)}</span></td>
          <td class="cell-sub" style="max-width:420px;overflow:hidden;text-overflow:ellipsis">${esc(a.details || (a.entity ? `${a.entity} #${a.entity_id}` : ''))}</td>
          <td class="mono cell-sub">${esc(a.ip || '')}</td>
        </tr>`).join('');
    } catch (e) { if (e.status !== 401) toast(e.message, 'err'); }
  }
  $('audit-refresh').addEventListener('click', loadAudit);

  /* =============== account menu =============== */
  $('me-btn').addEventListener('click', () => {
    const m = FT.modal(`
      <h2>${esc(me.full_name)}</h2><p class="sub">Signed in as ${esc(me.username)}</p>
      <div style="display:grid;gap:8px">
        <a class="btn" href="#audit" data-close>${icon('shield')}Audit log</a>
        <button class="btn" id="m-pw">${icon('key')}Change password</button>
        <button class="btn" id="m-all">${icon('lock')}Sign out on all devices</button>
        <button class="btn btn-danger" id="m-out">${icon('logout')}Sign out</button>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" data-close>Close</button></div>`);
    m.el.querySelector('#m-pw').onclick = () => { location.href = '/?change=1'; };
    m.el.querySelector('#m-out').onclick = () => FT.logout();
    m.el.querySelector('#m-all').onclick = async () => {
      try { await api('/api/auth/logout-everywhere', { method: 'POST' }); } catch { /* ignore */ }
      FT.logout();
    };
  });

  route();
})();
