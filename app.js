/* Roadbike GPX Builder
 * Click to drop waypoints -> snap to roads via BRouter -> export a device-ready GPX.
 */

const BROUTER = "https://brouter.de/brouter";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const STORE_KEY = "pedalplotter.routes.v1";
const PREFS_KEY = "pedalplotter.prefs.v1";

// ---------- State ----------
const state = {
  waypoints: [],        // [{lat, lon}]
  routeCoords: [],      // [[lon, lat, ele], ...] from router
  snapped: false,       // true when last route came from BRouter
  distance: 0,          // meters
  gain: 0, loss: 0,     // meters
};

let map, routeLayer, routeCasing, fallbackLayer, previewLayer, hoverMarker, sightLayer, startMarker, stopsLayer;
const markers = [];
let routeSeq = 0;       // guards against out-of-order async responses
let moveIndex = -1;     // index of a point armed for click-to-move, or -1

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  routeName: $("routeName"), profile: $("profile"), loop: $("loop"),
  search: $("search"), searchBtn: $("searchBtn"), locateBtn: $("locateBtn"),
  distance: $("statDistance"), gain: $("statGain"), loss: $("statLoss"), points: $("statPoints"),
  elevation: $("elevation"), elevHint: $("elevHint"), elevOverlay: $("elevOverlay"),
  elevChart: $("elevChart"), elevCursor: $("elevCursor"), elevTip: $("elevTip"), toasts: $("toasts"),
  export: $("exportBtn"), share: $("shareBtn"),
  status: $("status"), spinner: $("spinner"),
  genDist: $("genDist"), genSlider: $("genSlider"), genDistLabel: $("genDistLabel"),
  genBtn: $("genBtn"), genStatus: $("genStatus"), genResults: $("genResults"),
  useNetwork: $("useNetwork"),
  savedList: $("savedList"), savedCount: $("savedCount"),
  surface: $("surface"),
  paceSlider: $("paceSlider"), paceLabel: $("paceLabel"), rideTime: $("rideTime"),
  windPanel: $("windPanel"), windSummary: $("windSummary"), windArrow: $("windArrow"), windBreakdown: $("windBreakdown"),
  cuePanel: $("cuePanel"), cueCount: $("cueCount"), cueList: $("cueList"),
  swipeModal: $("swipeModal"), swipeStack: $("swipeStack"), swipeProgress: $("swipeProgress"),
  swipeClose: $("swipeClose"), swipeSkip: $("swipeSkip"), swipeAdd: $("swipeAdd"),
  errorModal: $("errorModal"), errorMessage: $("errorMessage"), errorClose: $("errorClose"), crashCyclist: $("crashCyclist"),
};

let genOptions = [];      // generated loop options for the current run

// Enable/disable the actions that need a finished route (Export + on-map Save).
function setRouteAvailable(on) {
  el.export.disabled = !on;
  el.share.disabled = !on;
  const s = document.getElementById("mapSave");
  if (s) s.disabled = !on;
}

// Keep the dark casing in lock-step with the route line.
function setRoutePolyline(latlngs) {
  routeLayer.setLatLngs(latlngs);
  routeCasing.setLatLngs(latlngs);
}

// ---------- Map ----------
function initMap() {
  map = L.map("map", { zoomControl: true }).setView([52.3702, 4.8952], 13);
  // CARTO Voyager — cleaner, muted base map than raw OSM.
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    subdomains: "abcd",
    detectRetina: true,
    attribution: '© OpenStreetMap contributors © CARTO',
  }).addTo(map);

  // Layered so the route reads on any background: dark casing under, faint
  // hover-preview, then the bright route on top.
  previewLayer = L.polyline([], { color: "#2dd4bf", weight: 4, opacity: 0.75, dashArray: "2 7", lineCap: "round" }).addTo(map);
  routeCasing = L.polyline([], { color: "#10070a", weight: 9, opacity: 0.45, lineCap: "round", lineJoin: "round" }).addTo(map);
  routeLayer = L.polyline([], { color: "#ff6b35", weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(map);
  fallbackLayer = L.polyline([], { color: "#ff6b35", weight: 3, opacity: 0.7, dashArray: "6 8" }).addTo(map);
  // Marker that tracks the elevation-profile cursor.
  hoverMarker = L.circleMarker([0, 0], {
    radius: 6, color: "#fff", weight: 2, fillColor: "#ff6b35",
    fillOpacity: 0, opacity: 0, interactive: false,
  }).addTo(map);
  // Sightseeing markers for the loaded route.
  sightLayer = L.layerGroup().addTo(map);
  // Café / water-stop markers.
  stopsLayer = L.layerGroup().addTo(map);

  // Restore the last view/start if we have one; otherwise try geolocation.
  const prefs = loadPrefs();
  if (prefs.center) map.setView([prefs.center.lat, prefs.center.lon], prefs.zoom || 13);
  const startLL = prefs.start
    ? [prefs.start.lat, prefs.start.lon]
    : (prefs.center ? [prefs.center.lat, prefs.center.lon] : [52.3702, 4.8952]);

  // The draggable START pin — geo-anchored, so it stays put when you pan.
  startMarker = L.marker(startLL, {
    icon: startIcon(), draggable: true, autoPan: true, zIndexOffset: 1000,
  }).addTo(map);
  startMarker.bindTooltip("Ride start — drag me to move it", { direction: "top", offset: [0, -46] });
  startMarker.on("dragend", () => { bounceStart(); savePrefs(); recalcRoute(); invalidateGenOptions(); });

  // Map click: relocate a point if one is armed for "move", else add a point.
  map.on("click", (e) => {
    if (moveIndex >= 0) {
      state.waypoints[moveIndex] = { lat: e.latlng.lat, lon: e.latlng.lng };
      moveIndex = -1;
      map.getContainer().classList.remove("moving");
      renderMarkers();
      recalcRoute();
      setStatus("Point moved.");
    } else {
      addWaypoint(e.latlng.lat, e.latlng.lng);
    }
  });

  addMapEditControls();
  initWindOverlay();
  setWindOverlayEnabled(true);

  if (!prefs.center && !prefs.start && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      map.setView(ll, 14);
      startMarker.setLatLng(ll);
    }, () => {}, { timeout: 6000 });
  }
  map.on("moveend", scheduleSavePrefs);
}

// On-map Undo / Clear controls for editing the track.
function addMapEditControls() {
  const ctrl = L.control({ position: "topright" });
  ctrl.onAdd = () => {
    const div = L.DomUtil.create("div", "map-edit");
    div.innerHTML =
      `<button id="mapLoop" title="Route from the last point back to START">🏠 Loop home</button>` +
      `<button id="mapSave" class="map-save" title="Save this route">💾 Save</button>` +
      `<button id="mapStops" title="Find café &amp; water stops along your route">☕ Stops</button>` +
      `<button id="mapWind" class="active" title="Toggle the live wind map overlay">💨 Wind</button>` +
      `<button id="mapUndo" title="Undo last point (⌘/Ctrl+Z)">↩︎ Undo</button>` +
      `<button id="mapClear" title="Clear the route">🗑 Clear</button>`;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(div.querySelector("#mapLoop"), "click", toggleLoopHome);
    L.DomEvent.on(div.querySelector("#mapSave"), "click", saveCurrentRoute);
    L.DomEvent.on(div.querySelector("#mapStops"), "click", findStops);
    L.DomEvent.on(div.querySelector("#mapWind"), "click", () => setWindOverlayEnabled(!windOverlayEnabled));
    L.DomEvent.on(div.querySelector("#mapUndo"), "click", undo);
    L.DomEvent.on(div.querySelector("#mapClear"), "click", clearAll);
    return div;
  };
  ctrl.addTo(map);
  updateEditControls();
}

// Close (or re-open) the loop: route from the last point back to START.
function toggleLoopHome() {
  if (!state.waypoints.length) return;
  el.loop.checked = !el.loop.checked;
  renderMarkers();
  recalcRoute();
  scheduleSavePrefs();
  const b = document.getElementById("mapLoop");
  if (b) { b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump"); }
  setStatus(el.loop.checked ? "Looped back home 🏠" : "Loop opened.");
}

// Enable Undo/Clear/Loop only when there are following points to act on;
// keep the Loop button's pressed state in sync with the route.
function updateEditControls() {
  const has = state.waypoints.length > 0;
  const u = document.getElementById("mapUndo");
  const c = document.getElementById("mapClear");
  const l = document.getElementById("mapLoop");
  const s = document.getElementById("mapSave");
  const st = document.getElementById("mapStops");
  if (u) u.disabled = !has;
  if (c) c.disabled = !has;
  if (l) { l.disabled = !has; l.classList.toggle("active", el.loop.checked); }
  if (s) s.disabled = state.routeCoords.length < 2;
  if (st) st.disabled = state.routeCoords.length < 2;
}

// The START pin icon: a green location pin with a play (▶ = "go") mark.
function startIcon() {
  return L.divIcon({
    className: "",
    html: `<div class="start-marker">
      <div class="start-badge">START</div>
      <svg class="start-pin" viewBox="0 0 44 52" xmlns="http://www.w3.org/2000/svg">
        <path d="M22 51C22 51 5 30 5 18a17 17 0 1 1 34 0c0 12-17 33-17 33z" fill="#6bbf59" stroke="#10250d" stroke-width="2.5"/>
        <circle cx="22" cy="18" r="8.5" fill="#f3e7d0" stroke="#10250d" stroke-width="1.5"/>
        <path d="M19 13.5v9l7.5-4.5z" fill="#10250d"/>
      </svg>
    </div>`,
    iconSize: [44, 52], iconAnchor: [22, 52],
  });
}

function startPoint() {
  const ll = startMarker.getLatLng();
  return { lat: ll.lat, lon: ll.lng };
}

function bounceStart() {
  const wrap = startMarker.getElement();
  const m = wrap && wrap.querySelector(".start-marker");
  if (!m) return;
  m.classList.remove("bounce");
  void m.offsetWidth;
  m.classList.add("bounce");
}

// Generated ride options are anchored to the START pin. Once START moves they're
// stale (selecting one would yank START back), so drop them.
function invalidateGenOptions() {
  if (!genOptions.length) return;
  genOptions = [];
  el.genResults.innerHTML = "";
  hidePreview();
  clearSights();
  setGen("Start moved — hit Generate again for rides from here.");
}

// ---------- "Plotting…" loading animation ----------
// While the generator works, sketch random trial routes fanning out from START
// so it's obvious something is happening.
let genAnimTimer = null, genAnimLayer = null;

function randomWanderPath(start, n) {
  const pts = [[start.lat, start.lon]];
  let bearing = Math.random() * 360, cur = { lat: start.lat, lon: start.lon };
  for (let i = 0; i < n; i++) {
    bearing += Math.random() * 130 - 65;
    cur = destPoint(cur.lat, cur.lon, bearing, 500 + Math.random() * 1600);
    pts.push([cur.lat, cur.lon]);
  }
  return pts;
}

function startGenLoadingAnim(start) {
  stopGenLoadingAnim();
  genAnimLayer = L.layerGroup().addTo(map);
  const css = getComputedStyle(document.documentElement);
  const c1 = css.getPropertyValue("--accent").trim() || "#ff6b35";
  const c2 = css.getPropertyValue("--go").trim() || "#2dd4bf";
  const c3 = css.getPropertyValue("--accent-2").trim() || "#ffb454";
  const cols = [c1, c2, c3];
  genAnimTimer = setInterval(() => {
    if (!genAnimLayer) return;
    genAnimLayer.clearLayers();
    for (let k = 0; k < 3; k++) {
      L.polyline(randomWanderPath(start, 7), {
        color: cols[k % cols.length], weight: 3, opacity: 0.55,
        dashArray: "3 9", lineCap: "round", lineJoin: "round",
      }).addTo(genAnimLayer);
    }
  }, 200);
}

function stopGenLoadingAnim() {
  if (genAnimTimer) { clearInterval(genAnimTimer); genAnimTimer = null; }
  if (genAnimLayer) { map.removeLayer(genAnimLayer); genAnimLayer = null; }
}

// ---------- Waypoints ----------
function addWaypoint(lat, lon) {
  state.waypoints.push({ lat, lon });
  renderMarkers();
  recalcRoute();
}

// The START pin is the first point; state.waypoints are the *following* points
// you click in, numbered 1..n (the last is the Finish when it's not a loop).
function renderMarkers() {
  markers.forEach((m) => map.removeLayer(m));
  markers.length = 0;

  const n = state.waypoints.length;
  state.waypoints.forEach((wp, i) => {
    const isEnd = i === n - 1 && !el.loop.checked;
    const cls = isEnd ? "wp-end" : "wp-mid";
    const label = isEnd ? "F" : String(i + 1);

    const icon = L.divIcon({
      className: "",
      html: `<div class="wp-marker ${cls}">${label}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });

    const marker = L.marker([wp.lat, wp.lon], { icon, draggable: true }).addTo(map);
    marker.on("dragend", (e) => {
      const ll = e.target.getLatLng();
      state.waypoints[i] = { lat: ll.lat, lon: ll.lng };
      recalcRoute();
    });
    marker.on("contextmenu", () => deleteWaypoint(i)); // right-click = quick delete
    bindWaypointPopup(marker, i);                       // click = Move / Delete popup
    markers.push(marker);
  });
  updateEditControls();
}

// Click a point → popup offering Move (relocate) or Delete.
function bindWaypointPopup(marker, i) {
  const div = L.DomUtil.create("div", "wp-popup");
  div.innerHTML =
    `<button class="wp-pop-move">✥ Move</button>` +
    `<button class="wp-pop-del">🗑 Delete</button>`;
  L.DomEvent.on(div.querySelector(".wp-pop-move"), "click", () => { marker.closePopup(); armMove(i); });
  L.DomEvent.on(div.querySelector(".wp-pop-del"), "click", () => { marker.closePopup(); deleteWaypoint(i); });
  marker.bindPopup(div, { className: "wp-popup-wrap", closeButton: false, offset: [0, -8] });
}

// Arm click-to-move: the next map click relocates this point.
function armMove(i) {
  moveIndex = i;
  map.getContainer().classList.add("moving");
  setStatus(`Click the map to move point ${i + 1} — or press Esc to cancel.`);
}

// Delete a point with a little shrink-and-pop animation on its marker.
function deleteWaypoint(i) {
  const marker = markers[i];
  const dom = marker && marker.getElement() && marker.getElement().querySelector(".wp-marker");
  if (dom) {
    dom.classList.add("deleting");
    setTimeout(() => removeWaypoint(i), 280);
  } else {
    removeWaypoint(i);
  }
}

function removeWaypoint(i) {
  state.waypoints.splice(i, 1);
  renderMarkers();
  recalcRoute();
}

function undo() {
  if (!state.waypoints.length) return;
  deleteWaypoint(state.waypoints.length - 1);
}

function clearAll() {
  clearTimeout(recalcTimer);
  state.waypoints = [];
  state.routeCoords = [];
  state.snapped = false;
  renderMarkers();
  setRoutePolyline([]);
  fallbackLayer.setLatLngs([]);
  clearSights();
  clearStops();
  if (el.swipeModal) el.swipeModal.hidden = true;
  renderSurface(null);
  renderElevation(); // also hides the map's climb-profile overlay
  updateRouteExtras();
  resetStats();
  setRouteAvailable(false);
  setStatus("");
}

// ---------- Routing ----------
// The route always begins at the START pin, then runs through the clicked-in
// following points; the loop toggle closes it back to START.
function routingPoints() {
  const pts = [startPoint(), ...state.waypoints];
  if (el.loop.checked && pts.length >= 2) pts.push(startPoint()); // close the loop
  return pts;
}
function pointCount() { return state.waypoints.length ? state.waypoints.length + 1 : 0; }

// Single BRouter call. Returns { coords:[[lon,lat,ele],...], distance:meters }.
async function routeVia(pts, profile) {
  const lonlats = pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join("|");
  const url = `${BROUTER}?lonlats=${lonlats}&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`router returned ${res.status}`);
  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature) throw new Error("no route found");
  const coords = feature.geometry.coordinates;
  const distance = parseFloat(feature.properties["track-length"]) || 0;
  const messages = feature.properties.messages || null; // per-segment way tags
  return { coords, distance, messages };
}

// Break the route down by road surface using BRouter's WayTags, so you can see
// how much is well-paved vs gravel/unpaved.
function computeSurface(messages) {
  if (!messages || messages.length < 2) return null;
  const header = messages[0];
  const wIdx = header.indexOf("WayTags");
  const dIdx = header.indexOf("Distance");
  if (wIdx < 0 || dIdx < 0) return null;
  let paved = 0, unpaved = 0, unknown = 0;
  for (let r = 1; r < messages.length; r++) {
    const row = messages[r];
    const dist = parseFloat(row[dIdx]) || 0;
    const tags = (row[wIdx] || "").toLowerCase();
    const m = tags.match(/surface=([a-z_:]+)/);
    const surf = m ? m[1] : null;
    if (surf && /(asphalt|paved|concrete|paving_stones|sett|metal|wood|chipseal)/.test(surf)) paved += dist;
    else if (surf && /(unpaved|gravel|fine_gravel|compacted|ground|dirt|earth|grass|sand|mud|pebblestone|cobblestone|rock|clay)/.test(surf)) unpaved += dist;
    else if (!surf && /highway=(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service|cycleway)/.test(tags)) paved += dist;
    else unknown += dist;
  }
  const total = paved + unpaved + unknown;
  if (total <= 0) return null;
  return {
    total, pavedM: paved, unpavedM: unpaved,
    pavedPct: Math.round(paved / total * 100),
    unpavedPct: Math.round(unpaved / total * 100),
    unknownPct: Math.round(unknown / total * 100),
  };
}

function renderSurface(messages) {
  const panel = document.getElementById("surfacePanel");
  if (!panel) return;
  const s = computeSurface(messages);
  if (!s) { panel.hidden = true; return; }
  panel.hidden = false;
  const pctEl = document.getElementById("surfacePct");
  if (pctEl) pctEl.textContent = `${s.pavedPct}% paved`;
  const seg = (pct, cls, label) =>
    pct > 0 ? `<span class="surf ${cls}" style="width:${pct}%" title="${label}: ${pct}%"></span>` : "";
  el.surface.innerHTML =
    seg(s.pavedPct, "surf-paved", "Paved") +
    seg(s.unpavedPct, "surf-unpaved", "Unpaved / gravel") +
    seg(s.unknownPct, "surf-unknown", "Unknown");
}

// ---------- Ride extras: time/pace, cue sheet, wind, café stops ----------
// Called whenever the route changes; keeps all the derived panels in sync.
function updateRouteExtras() {
  renderRideTime();
  renderCues();
  updateWind();
  updateEditControls(); // keeps the on-map Stops/Save buttons in sync too
}

// --- Ride time & pace ---
function paceKmh() { return parseInt(el.paceSlider.value, 10) || 25; }
function renderRideTime() {
  if (state.routeCoords.length < 2) { el.rideTime.textContent = "—"; return; }
  // Flat-equivalent distance: ~8 m of flat riding per metre climbed.
  const flatKm = state.distance / 1000 + state.gain * 8 / 1000;
  const hours = flatKm / paceKmh();
  const h = Math.floor(hours), m = Math.round((hours - h) * 60);
  el.rideTime.textContent = (h ? `${h}h ` : "") + `${m}m`;
}

// --- Turn-by-turn cue sheet (from geometry) ---
function computeCues(coords) {
  if (!coords || coords.length < 6) return [];
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  const brg = (i, j) => bearingFrom({ lat: coords[i][1], lon: coords[i][0] }, { lat: coords[j][1], lon: coords[j][0] });
  const idxAt = (from, dist, dir) => {
    let i = from, acc = 0;
    while (i + dir >= 0 && i + dir < coords.length && acc < dist) { acc += haversine(coords[i][1], coords[i][0], coords[i + dir][1], coords[i + dir][0]); i += dir; }
    return i;
  };
  const cues = []; let lastDist = -999; const span = 35;
  for (let i = 2; i < coords.length - 2; i++) {
    const a = idxAt(i, span, -1), b = idxAt(i, span, 1);
    if (a === i || b === i) continue;
    const ang = ((brg(i, b) - brg(a, i) + 540) % 360) - 180; // + = right
    if (Math.abs(ang) < 35) continue;
    if (cum[i] - lastDist < 90) continue;
    lastDist = cum[i];
    const dir = ang > 0 ? "right" : "left";
    const sev = Math.abs(ang) > 112 ? "Sharp " : Math.abs(ang) < 55 ? "Bear " : "Turn ";
    cues.push({ km: cum[i] / 1000, dir, text: sev + dir, lat: coords[i][1], lon: coords[i][0] });
  }
  return cues;
}
function renderCues() {
  const cues = computeCues(state.routeCoords);
  state.cues = cues;
  if (!cues.length) { el.cuePanel.hidden = true; return; }
  el.cuePanel.hidden = false;
  el.cueCount.textContent = `${cues.length} turn${cues.length > 1 ? "s" : ""}`;
  el.cueList.innerHTML = cues.slice(0, 80).map((c) =>
    `<li><span class="cue-km">${c.km.toFixed(1)} km</span><span class="cue-arrow cue-${c.dir}">${c.dir === "right" ? "↱" : "↰"}</span>${c.text}</li>`).join("");
}

// --- Wind (Open-Meteo, no key) ---
let windData = null, windCacheKey = null, windCacheAt = 0;
const WIND_CACHE_MS = 4 * 60 * 1000; // shorter than the refresh interval so each tick genuinely re-fetches
async function fetchWind(start) {
  const key = `${start.lat.toFixed(2)},${start.lon.toFixed(2)}`;
  const fresh = key === windCacheKey && (Date.now() - windCacheAt) < WIND_CACHE_MS;
  if (fresh && windData) return windData;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${start.lat.toFixed(3)}&longitude=${start.lon.toFixed(3)}&current=wind_speed_10m,wind_direction_10m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wind ${res.status}`);
  const d = await res.json();
  windData = { speed: d.current.wind_speed_10m, dir: d.current.wind_direction_10m }; // dir = FROM
  windCacheKey = key;
  windCacheAt = Date.now();
  return windData;
}
function windBreakdown(coords, windDir) {
  let head = 0, tail = 0, cross = 0;
  for (let i = 1; i < coords.length; i++) {
    const b = bearingFrom({ lat: coords[i - 1][1], lon: coords[i - 1][0] }, { lat: coords[i][1], lon: coords[i][0] });
    const dist = haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    const rel = Math.abs(((b - windDir + 540) % 360) - 180); // 0 = into the wind, 180 = pushed along
    if (rel < 60) head += dist; else if (rel > 120) tail += dist; else cross += dist;
  }
  const total = head + tail + cross || 1;
  return { head: Math.round(head / total * 100), tail: Math.round(tail / total * 100), cross: Math.round(cross / total * 100) };
}
// ---------- Wind map overlay: a grid of wind arrows across the visible map ----------
// Instead of a single-point widget, this queries a small grid of points spanning
// the current view (one Open-Meteo request handles all of them at once) and
// draws a rotating arrow at each, so wind is visible as an actual map layer.
let windOverlayLayer = null, windOverlayEnabled = true, windOverlayTimer = null, windOverlayMoveTimer = null;

function initWindOverlay() {
  windOverlayLayer = L.layerGroup();
  map.on("moveend", () => {
    if (!windOverlayEnabled) return;
    clearTimeout(windOverlayMoveTimer);
    windOverlayMoveTimer = setTimeout(refreshWindOverlay, 600);
  });
  if (!windOverlayTimer) windOverlayTimer = setInterval(refreshWindOverlay, 5 * 60 * 1000);
}

async function fetchWindGrid(bounds) {
  const n = 4; // 4x4 grid — one request regardless of point count
  const lats = [], lons = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      lats.push(bounds.getSouth() + (bounds.getNorth() - bounds.getSouth()) * (i / (n - 1)));
      lons.push(bounds.getWest() + (bounds.getEast() - bounds.getWest()) * (j / (n - 1)));
    }
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats.map((v) => v.toFixed(3)).join(",")}` +
    `&longitude=${lons.map((v) => v.toFixed(3)).join(",")}&current=wind_speed_10m,wind_direction_10m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wind grid ${res.status}`);
  const data = await res.json();
  const arr = Array.isArray(data) ? data : [data];
  return arr.map((d, i) => ({ lat: lats[i], lon: lons[i], speed: d.current.wind_speed_10m, dir: d.current.wind_direction_10m }));
}

function renderWindGrid(points) {
  windOverlayLayer.clearLayers();
  const maxSpeed = Math.max(...points.map((p) => p.speed), 1);
  const box = 46; // icon box; streaks travel within it, label sits below
  for (const p of points) {
    const len = 12 + Math.min(14, (p.speed / maxSpeed) * 14); // streak length
    // Faster wind -> faster flow, so speed is visible in motion, not just size.
    const duration = Math.max(0.55, Math.min(2.1, 2.0 - p.speed * 0.045));
    // Three streaks staggered in phase (negative delays start them mid-cycle)
    // so the flow reads as a continuous stream rather than one blip repeating.
    const streaks = [0, 1, 2].map((i) =>
      `<span class="wind-streak" style="height:${len}px; animation-duration:${duration.toFixed(2)}s; animation-delay:${(-i * duration / 3).toFixed(2)}s;"></span>`
    ).join("");
    const icon = L.divIcon({
      className: "",
      html: `<div class="wind-flow-icon" style="width:${box}px; height:${box}px;">` +
        `<div class="wind-flow-rotor" style="transform:rotate(${(p.dir + 180) % 360}deg);">${streaks}</div>` +
        `<span class="wind-speed-label">${Math.round(p.speed)}</span>` +
        `</div>`,
      iconSize: [box, box], iconAnchor: [box / 2, box / 2],
    });
    L.marker([p.lat, p.lon], { icon, keyboard: false, interactive: true })
      .bindTooltip(`${Math.round(p.speed)} km/h from ${compass(p.dir)}`, { direction: "top" })
      .addTo(windOverlayLayer);
  }
}

async function refreshWindOverlay() {
  if (!windOverlayEnabled) return;
  try {
    const points = await fetchWindGrid(map.getBounds());
    renderWindGrid(points);
  } catch (e) { /* transient — keep showing the last-known grid, no crash screen for a background refresh */ }
}

function setWindOverlayEnabled(on) {
  windOverlayEnabled = on;
  const btn = document.getElementById("mapWind");
  if (btn) btn.classList.toggle("active", on);
  if (on) { windOverlayLayer.addTo(map); refreshWindOverlay(); }
  else { map.removeLayer(windOverlayLayer); }
}

async function updateWind() {
  if (state.routeCoords.length < 2) { el.windPanel.hidden = true; return; }
  let w;
  try { w = await fetchWind(startPoint()); } catch (e) { el.windPanel.hidden = true; return; }
  el.windPanel.hidden = false;
  el.windArrow.style.transform = `rotate(${(w.dir + 180) % 360}deg)`; // points where wind blows TO
  el.windSummary.textContent = `${Math.round(w.speed)} km/h from ${compass(w.dir)}`;
  const b = windBreakdown(state.routeCoords, w.dir);
  el.windBreakdown.innerHTML =
    `<span class="wind-head">🚴💨 ${b.head}% head</span>` +
    `<span class="wind-tail">💨🚴 ${b.tail}% tail</span>` +
    `<span class="wind-cross">↔ ${b.cross}% cross</span>`;
}

// --- Café & water stops along the route (Overpass) ---
const STOP_EMOJI = { cafe: "☕", water: "🚰", bakery: "🥐" };
const STOP_LABEL = { cafe: "Café", water: "Drinking water", bakery: "Bakery" };
function pointNearRoute(p, coords, bufferM) {
  const step = Math.max(1, Math.floor(coords.length / 200));
  for (let i = 0; i < coords.length; i += step) {
    if (haversine(p.lat, p.lon, coords[i][1], coords[i][0]) < bufferM) return true;
  }
  return false;
}
// How far along the route (in metres) the nearest point to p sits — used to
// order stops the way you'd actually reach them, and to spread the 5 picks
// out instead of clustering them all in one spot.
function routeProgress(p, coords, cumDist) {
  const step = Math.max(1, Math.floor(coords.length / 200));
  let best = Infinity, bestI = 0;
  for (let i = 0; i < coords.length; i += step) {
    const d = haversine(p.lat, p.lon, coords[i][1], coords[i][0]);
    if (d < best) { best = d; bestI = i; }
  }
  return cumDist[bestI];
}

// Best-effort photo for a stop: OSM's own image tag first (exact, when present),
// else the nearest geotagged photo on Wikimedia Commons (free, keyless) — that's
// a photo taken NEAR this spot, not guaranteed to be of this exact café/tap, so
// the UI labels it "nearby photo" rather than claiming it's the place itself.
const photoCache = new Map();
async function fetchStopPhoto(stop) {
  if (stop.directImage) return { url: stop.directImage, exact: true };
  const key = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`;
  if (photoCache.has(key)) return photoCache.get(key);
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch` +
      `&ggscoord=${stop.lat}|${stop.lon}&ggsradius=100&ggslimit=1&ggsnamespace=6` +
      `&prop=imageinfo&iiprop=url&iiurlwidth=320&format=json&origin=*`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("commons " + res.status);
    const data = await res.json();
    const pages = (data.query && data.query.pages) || {};
    const first = Object.values(pages)[0];
    const info = first && first.imageinfo && first.imageinfo[0];
    const result = info ? { url: info.thumburl, exact: false } : null;
    photoCache.set(key, result);
    return result;
  } catch (e) {
    photoCache.set(key, null);
    return null;
  }
}

// Compact "Details" line from real OSM tags — an honest substitute for reviews,
// which would need a paid/keyed API (Google Places, Yelp) we don't have access to.
function stopDetailsHTML(s) {
  const bits = [];
  if (s.openingHours) bits.push(`🕐 ${s.openingHours}`);
  if (s.cuisine) bits.push(`🍽️ ${s.cuisine}`);
  if (s.outdoorSeating) bits.push(`🌤️ Outdoor seating`);
  if (s.wheelchair === "yes") bits.push(`♿ Accessible`);
  if (!bits.length) return "";
  return `<div class="swipe-details">${bits.map((b) => `<span>${b}</span>`).join("")}</div>`;
}

async function findStops() {
  if (state.routeCoords.length < 2) return;
  const btn = document.getElementById("mapStops");
  const orig = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "☕ Searching…"; }
  try {
    const lats = state.routeCoords.map((c) => c[1]), lons = state.routeCoords.map((c) => c[0]);
    const bbox = `${Math.min(...lats).toFixed(4)},${Math.min(...lons).toFixed(4)},${Math.max(...lats).toFixed(4)},${Math.max(...lons).toFixed(4)}`;
    const q = `[out:json][timeout:25];(` +
      `node["amenity"~"^(cafe|drinking_water)$"](${bbox});` +
      `node["shop"="bakery"](${bbox});` +
      `);out body 400;`;
    const res = await fetch(OVERPASS, { method: "POST", body: "data=" + encodeURIComponent(q) });
    if (!res.ok) throw new Error(`overpass ${res.status}`);
    const data = await res.json();
    const all = (data.elements || []).filter((x) => x.lat && x.lon).map((x) => {
      const t = x.tags || {};
      return {
        lat: x.lat, lon: x.lon, name: t.name || null,
        kind: t.amenity === "drinking_water" ? "water" : t.shop === "bakery" ? "bakery" : "cafe",
        // Real, honest OSM details — no fabricated ratings/reviews (see swipe card notes).
        openingHours: t.opening_hours || null,
        cuisine: t.cuisine ? titleCase(t.cuisine.replace(/;/g, ", ")) : null,
        website: t.website || t.contact_website || null,
        outdoorSeating: t.outdoor_seating === "yes",
        wheelchair: t.wheelchair || null,
        // Some POIs are directly tagged with a Commons image — free win, no API call needed.
        directImage: t.image || (t.wikimedia_commons && t.wikimedia_commons.startsWith("File:")
          ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(t.wikimedia_commons.slice(5))}?width=320` : null),
      };
    });

    const cumDist = [0];
    for (let i = 1; i < state.routeCoords.length; i++) {
      cumDist.push(cumDist[i - 1] + haversine(state.routeCoords[i - 1][1], state.routeCoords[i - 1][0], state.routeCoords[i][1], state.routeCoords[i][0]));
    }
    const near = all
      .filter((p) => pointNearRoute(p, state.routeCoords, 120))
      .map((p) => ({ ...p, km: routeProgress(p, state.routeCoords, cumDist) / 1000 }))
      .sort((a, b) => a.km - b.km); // in the order you'd actually reach them

    if (!near.length) {
      toast("No café/water stops found near this route", "info");
      return;
    }
    // Pick up to 5, spread evenly along the route rather than clustered.
    const n = Math.min(5, near.length);
    const picks = n === near.length ? near : Array.from({ length: n }, (_, i) => near[Math.round(i * (near.length - 1) / (n - 1))]);
    clearStops();
    openStopSwipe(picks);
  } catch (e) {
    showCrash("Couldn't reach Overpass (the map data service) to find café & water stops. It might be busy — try again in a moment.");
  } finally {
    if (btn) { btn.disabled = state.routeCoords.length < 2; btn.textContent = orig; }
  }
}

// ---------- Tinder-style swipe deck for choosing which stops to keep ----------
let swipeStops = [], swipeIndex = 0, swipeAccepted = [];

function openStopSwipe(stops) {
  swipeStops = stops; swipeIndex = 0; swipeAccepted = [];
  el.swipeModal.hidden = false;
  renderSwipeDeck();
}

function closeStopSwipe(finish) {
  el.swipeModal.hidden = true;
  if (finish) {
    renderStops(swipeAccepted);
    const n = swipeAccepted.length;
    toast(n ? `Added ${n} stop${n > 1 ? "s" : ""} to your map` : "No stops added", n ? "success" : "info");
  }
}

function renderSwipeDeck() {
  const stack = el.swipeStack;
  stack.innerHTML = "";
  // Render the current card plus the next couple behind it for a stacked look.
  const visible = swipeStops.slice(swipeIndex, swipeIndex + 3);
  visible.forEach((s, depth) => {
    const card = document.createElement("div");
    card.className = "swipe-card";
    card.style.zIndex = String(10 - depth);
    card.style.transform = `scale(${1 - depth * 0.045}) translateY(${depth * 10}px)`;
    card.innerHTML = `
      <div class="swipe-photo">
        <span class="swipe-emoji">${STOP_EMOJI[s.kind] || "☕"}</span>
        <img class="swipe-img" hidden />
        <span class="swipe-photo-tag" hidden>📷 nearby photo</span>
      </div>
      <div class="swipe-info">
        <div class="swipe-name">${s.name || STOP_LABEL[s.kind]}</div>
        <div class="swipe-kind">${STOP_LABEL[s.kind]} · 📍 ${s.km.toFixed(1)} km in</div>
        ${stopDetailsHTML(s)}
      </div>
      <div class="swipe-stamp swipe-stamp-add">ADD</div>
      <div class="swipe-stamp swipe-stamp-skip">SKIP</div>`;
    stack.appendChild(card);
    if (depth === 0) bindSwipeDrag(card);
    loadCardPhoto(card, s);
  });
  el.swipeProgress.textContent = `${swipeIndex + 1} of ${swipeStops.length}`;
}

// Fetch a photo for this card's stop and swap it in once loaded. Guards
// against the card having been removed already (user swiped past it fast).
async function loadCardPhoto(card, stop) {
  const photo = await fetchStopPhoto(stop);
  if (!photo || !card.isConnected) return;
  const img = card.querySelector(".swipe-img");
  img.onload = () => {
    card.querySelector(".swipe-emoji").hidden = true;
    img.hidden = false;
    if (!photo.exact) card.querySelector(".swipe-photo-tag").hidden = false;
  };
  img.src = photo.url;
}

function bindSwipeDrag(card) {
  let dragging = false, startX = 0, dx = 0;
  const addStamp = card.querySelector(".swipe-stamp-add");
  const skipStamp = card.querySelector(".swipe-stamp-skip");

  const onMove = (clientX) => {
    dx = clientX - startX;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 14}deg)`;
    addStamp.style.opacity = Math.max(0, Math.min(1, dx / 90));
    skipStamp.style.opacity = Math.max(0, Math.min(1, -dx / 90));
  };
  const onUp = () => {
    dragging = false;
    card.classList.remove("dragging");
    const threshold = 90;
    if (dx > threshold) flingCard(card, 1, true);
    else if (dx < -threshold) flingCard(card, -1, false);
    else { card.style.transform = ""; addStamp.style.opacity = 0; skipStamp.style.opacity = 0; }
  };
  card.addEventListener("pointerdown", (e) => {
    dragging = true; startX = e.clientX; dx = 0;
    card.classList.add("dragging");
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener("pointermove", (e) => { if (dragging) onMove(e.clientX); });
  card.addEventListener("pointerup", onUp);
  card.addEventListener("pointercancel", onUp);
}

function flingCard(card, dir, accept) {
  card.style.transition = "transform .35s ease, opacity .35s ease";
  card.style.transform = `translateX(${dir * 600}px) rotate(${dir * 30}deg)`;
  card.style.opacity = "0";
  setTimeout(() => swipeDecide(accept), 180);
}

function swipeDecide(accept) {
  const stop = swipeStops[swipeIndex];
  if (accept && stop) swipeAccepted.push(stop);
  swipeIndex++;
  if (swipeIndex >= swipeStops.length) { closeStopSwipe(true); return; }
  renderSwipeDeck();
}

function renderStops(stops) {
  stopsLayer.clearLayers();
  for (const s of stops) {
    const icon = L.divIcon({ className: "", html: `<div class="stop-marker">${STOP_EMOJI[s.kind] || "☕"}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    L.marker([s.lat, s.lon], { icon, keyboard: false })
      .bindTooltip(`${STOP_EMOJI[s.kind]} ${s.name || STOP_LABEL[s.kind]}`, { direction: "top", offset: [0, -8] })
      .addTo(stopsLayer);
  }
}
function clearStops() { if (stopsLayer) stopsLayer.clearLayers(); }

// Debounced entry point: updates the point count immediately and handles the
// empty state, but coalesces rapid edits (e.g. dragging a marker) into one
// routing request once the user pauses.
let recalcTimer = null;
function recalcRoute() {
  el.points.textContent = String(pointCount());

  if (routingPoints().length < 2) {
    clearTimeout(recalcTimer);
    state.routeCoords = [];
    setRoutePolyline([]);
    fallbackLayer.setLatLngs([]);
    resetStats();
    setRouteAvailable(false);
    renderElevation();
    renderSurface(null);
    clearStops();
    updateRouteExtras();
    return;
  }

  clearStops(); // stops are tied to a specific route; drop them while re-routing
  clearTimeout(recalcTimer);
  recalcTimer = setTimeout(runRoute, 250);
}

async function runRoute() {
  const pts = routingPoints();
  if (pts.length < 2) return;

  const seq = ++routeSeq;
  showSpinner(true);
  setStatus("");

  try {
    const { coords, messages } = await routeVia(pts, el.profile.value);
    if (seq !== routeSeq) return; // a newer request superseded this one

    state.routeCoords = coords; // [lon, lat, ele]
    state.snapped = true;

    setRoutePolyline(coords.map((c) => [c[1], c[0]]));
    fallbackLayer.setLatLngs([]);

    computeStatsFromCoords(coords);
    renderElevation();
    renderSurface(messages);
    updateRouteExtras();
    setRouteAvailable(true);
    setStatus(`Snapped to roads · ${(state.distance / 1000).toFixed(1)} km`);
  } catch (err) {
    if (seq !== routeSeq) return;
    // Graceful fallback: straight lines between waypoints so the user still sees something.
    drawFallback(pts);
    setStatus(`⚠ Couldn't reach the router (${err.message}). Showing straight lines — not road-snapped.`, true);
    toast("Router unreachable — showing straight lines, not road-snapped", "error");
  } finally {
    if (seq === routeSeq) showSpinner(false);
  }
}

function drawFallback(pts) {
  state.snapped = false;
  state.routeCoords = pts.map((p) => [p.lon, p.lat]); // no elevation
  setRoutePolyline([]);
  fallbackLayer.setLatLngs(pts.map((p) => [p.lat, p.lon]));
  computeStatsFromCoords(state.routeCoords);
  renderElevation();
  renderSurface(null);
  updateRouteExtras();
  setRouteAvailable(true);
}

// Load a fully-formed route (from the generator or a saved entry) into the editor.
// `start` becomes the START pin; `waypoints` are the following points.
function applyLoadedRoute({ start, waypoints, coords, loop, profile, name, messages }) {
  ++routeSeq; // invalidate any in-flight recalc
  clearTimeout(recalcTimer); // drop any pending debounced route
  clearSights(); // sights are re-added by selectOption when relevant
  if (profile) el.profile.value = profile;
  if (name != null) el.routeName.value = name;
  el.loop.checked = !!loop;

  if (start) startMarker.setLatLng([start.lat, start.lon]);
  state.waypoints = (waypoints || []).map((p) => ({ lat: p.lat, lon: p.lon }));
  renderMarkers();

  state.routeCoords = coords;
  state.snapped = true;
  setRoutePolyline(coords.map((c) => [c[1], c[0]]));
  fallbackLayer.setLatLngs([]);
  previewLayer.setLatLngs([]);
  computeStatsFromCoords(coords);
  renderElevation();
  renderSurface(messages || null);
  updateRouteExtras();
  setRouteAvailable(coords.length > 1);
  if (coords.length > 1) map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
}

// ---------- Random loop generator ----------
// Place waypoints on a circle around the start (optionally snapped to the local
// cycle network), route them as a loop, then iteratively scale the circle until
// the road distance matches the target.

function mapCenter() {
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

// Destination point given start, bearing (deg), and distance (m) — great-circle.
function destPoint(lat, lon, bearingDeg, distM) {
  const R = 6371000, rad = Math.PI / 180, deg = 180 / Math.PI;
  const d = distM / R, br = bearingDeg * rad, p1 = lat * rad, l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
  const l2 = l1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(p1),
    Math.cos(d) - Math.sin(p1) * Math.sin(p2)
  );
  return { lat: p2 * deg, lon: ((l2 * deg + 540) % 360) - 180 };
}

// Initial bearing (deg, 0..360) from start to point p.
function bearingFrom(start, p) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const f1 = start.lat * rad, f2 = p.lat * rad, dl = (p.lon - start.lon) * rad;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) * deg + 360) % 360;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

function elevGainOf(coords) {
  const e = filledElevations(coords);
  if (!e) return 0;
  let g = 0;
  for (let i = 1; i < e.length; i++) { const d = e[i] - e[i - 1]; if (d > 0) g += d; }
  return g;
}

// Query the OSM cycle node-network (signed local/regional/national routes)
// around the start. These junctions are great loop waypoints because routing
// between them tends to follow real, signposted cycle paths.
let networkCacheKey = null, networkCache = null;
async function fetchCycleNetwork(start, radiusM) {
  const r = Math.min(Math.max(Math.round(radiusM), 1500), 40000);
  // Reuse the last result when the start barely moved (~1 km grid) and the
  // radius is in the same 2 km bucket — Overpass rate-limits rapid queries.
  const key = `${start.lat.toFixed(2)},${start.lon.toFixed(2)}@${Math.round(r / 2000)}`;
  if (key === networkCacheKey && networkCache) return networkCache;

  const ll = `${start.lat.toFixed(5)},${start.lon.toFixed(5)}`;
  const q = `[out:json][timeout:25];(` +
    `node(around:${r},${ll})["rcn_ref"];` +
    `node(around:${r},${ll})["lcn_ref"];` +
    `node(around:${r},${ll})["ncn_ref"];` +
    `);out body;`;
  const res = await fetch(OVERPASS, { method: "POST", body: "data=" + encodeURIComponent(q) });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const data = await res.json();
  const points = (data.elements || [])
    .filter((e) => e.lat && e.lon)
    .map((e) => ({ lat: e.lat, lon: e.lon }));

  networkCacheKey = key;
  networkCache = points;
  return points;
}

function nearestPoint(points, target) {
  let best = null, bd = Infinity;
  for (const p of points) {
    const d = haversine(target.lat, target.lon, p.lat, p.lon);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// Nearest point within a tolerance, else null.
function snapNear(points, target, tolM) {
  const np = nearestPoint(points, target);
  if (np && haversine(target.lat, target.lon, np.lat, np.lon) <= tolM) return np;
  return null;
}

// Query nearby towns/villages/hamlets to ride out to (named place nodes).
let townCacheKey = null, townCache = null;
async function fetchTowns(start, radiusM) {
  const r = Math.min(Math.max(Math.round(radiusM), 3000), 60000);
  const key = `${start.lat.toFixed(2)},${start.lon.toFixed(2)}@${Math.round(r / 3000)}`;
  if (key === townCacheKey && townCache) return townCache;

  const ll = `${start.lat.toFixed(5)},${start.lon.toFixed(5)}`;
  const q = `[out:json][timeout:25];(` +
    `node(around:${r},${ll})["place"~"^(town|village|hamlet)$"]["name"];` +
    `);out body;`;
  const res = await fetch(OVERPASS, { method: "POST", body: "data=" + encodeURIComponent(q) });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const data = await res.json();
  const towns = (data.elements || [])
    .filter((e) => e.lat && e.lon && e.tags && e.tags.name)
    .map((e) => ({ lat: e.lat, lon: e.lon, name: e.tags.name, place: e.tags.place }));

  townCacheKey = key;
  townCache = towns;
  return towns;
}

// ---------- Sightseeing points of interest ----------
const SIGHT_EMOJI = {
  viewpoint: "🔭", attraction: "⭐", artwork: "🎨", museum: "🏛️", gallery: "🖼️",
  theme_park: "🎡", zoo: "🦁", castle: "🏰", monument: "🗿", memorial: "🕊️",
  ruins: "🏚️", fort: "🏰", monastery: "⛪", manor: "🏰", archaeological_site: "🏺",
  city_gate: "🚪", tower: "🗼", peak: "⛰️", waterfall: "💧",
  windmill: "🌀", watermill: "⚙️", lighthouse: "🗼",
};
const sightEmoji = (kind) => SIGHT_EMOJI[kind] || "⭐";

// How worth-a-look each kind is while riding (higher = keep when trimming clutter).
const SIGHT_WEIGHT = {
  windmill: 5, castle: 5, lighthouse: 5, viewpoint: 5, waterfall: 5, peak: 5,
  watermill: 4, ruins: 4, fort: 4, tower: 4, monastery: 4, manor: 4,
  museum: 3, zoo: 3, theme_park: 3, attraction: 3, archaeological_site: 3,
  monument: 2, city_gate: 2, memorial: 1,
};
const sightWeight = (k) => SIGHT_WEIGHT[k] || 2;
const titleCase = (s) => (s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Query nearby tourism / historic / natural points of interest.
let sightCacheKey = null, sightCache = null;
async function fetchSights(start, radiusM) {
  const r = Math.min(Math.max(Math.round(radiusM), 3000), 60000);
  const key = `${start.lat.toFixed(2)},${start.lon.toFixed(2)}@${Math.round(r / 3000)}`;
  if (key === sightCacheKey && sightCache) return sightCache;

  const ll = `${start.lat.toFixed(5)},${start.lon.toFixed(5)}`;
  const q = `[out:json][timeout:25];(` +
    `nwr(around:${r},${ll})["tourism"~"^(attraction|viewpoint|museum|theme_park|zoo)$"];` +
    `nwr(around:${r},${ll})["historic"~"^(castle|monument|memorial|ruins|fort|monastery|manor|archaeological_site|city_gate|tower)$"];` +
    `nwr(around:${r},${ll})["natural"~"^(peak|waterfall)$"];` +
    `nwr(around:${r},${ll})["man_made"~"^(windmill|watermill|lighthouse)$"];` +
    `);out center 350;`;
  const res = await fetch(OVERPASS, { method: "POST", body: "data=" + encodeURIComponent(q) });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const data = await res.json();
  const sights = (data.elements || []).map((e) => {
    const lat = e.lat != null ? e.lat : e.center && e.center.lat;
    const lon = e.lon != null ? e.lon : e.center && e.center.lon;
    if (lat == null || lon == null) return null;
    const t = e.tags || {};
    const kind = t.tourism || t.historic || t.natural || t.man_made || "attraction";
    return { lat, lon, name: t.name || null, kind };
  }).filter(Boolean);

  sightCacheKey = key;
  sightCache = sights;
  return sights;
}

// Sights whose point lies within bufferM of the route polyline.
function sightsAlong(coords, sights, bufferM) {
  if (!sights.length || coords.length < 2) return [];
  const step = Math.max(1, Math.floor(coords.length / 220));
  const pts = coords.filter((_, i) => i % step === 0);
  const near = [];
  for (const s of sights) {
    let md = Infinity;
    for (const c of pts) {
      const d = haversine(s.lat, s.lon, c[1], c[0]);
      if (d < md) { md = d; if (md < bufferM) break; }
    }
    if (md < bufferM) near.push(s);
  }
  return near;
}

function renderSights(sights) {
  sightLayer.clearLayers();
  for (const s of sights) {
    const icon = L.divIcon({
      className: "",
      html: `<div class="sight-marker">${sightEmoji(s.kind)}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });
    L.marker([s.lat, s.lon], { icon, keyboard: false })
      .bindTooltip(`${sightEmoji(s.kind)} ${s.name || titleCase(s.kind)}`, { direction: "top", offset: [0, -10] })
      .addTo(sightLayer);
  }
}
function clearSights() { if (sightLayer) sightLayer.clearLayers(); }

// A ride out to a town and back via two different corridors: the outbound leg
// bows one way, the return leg the other, so it reads as a lens/teardrop rather
// than a circle and barely retraces itself. lensFrac sets how fat it is. When
// networkPoints are given, the via-points snap to scenic cycle junctions.
function buildTownLoopWaypoints(start, town, lensFrac, networkPoints) {
  const d = haversine(start.lat, start.lon, town.lat, town.lon);
  const theta = bearingFrom(start, town);
  const w = lensFrac * d; // lens half-width
  const mid = destPoint(start.lat, start.lon, theta, d * 0.5);
  let outVia = destPoint(mid.lat, mid.lon, theta + 90, w);
  let retVia = destPoint(mid.lat, mid.lon, theta - 90, w);
  if (networkPoints && networkPoints.length) {
    outVia = snapNear(networkPoints, outVia, 0.6 * w + 800) || outVia;
    retVia = snapNear(networkPoints, retVia, 0.6 * w + 800) || retVia;
  }
  return [start, outVia, { lat: town.lat, lon: town.lon }, retVia, start];
}

function anchorsInSector(list, start, sector, targetM) {
  return list
    .map((p) => ({ ...p, d: haversine(start.lat, start.lon, p.lat, p.lon), b: bearingFrom(start, p) }))
    .filter((p) => {
      const angDiff = Math.abs(((p.b - sector + 540) % 360) - 180);
      return angDiff <= 42 && p.d >= targetM * 0.18 && p.d <= targetM * 0.60;
    })
    .sort((a, b) => a.d - b.d);
}

// Plot a ride toward a destination in the given sector, ~targetM total. Prefers a
// named sightseeing spot as the turnaround (falling back to any sight, then a
// town). We can't scale a real place's distance, so we hit the target by
// re-picking which place to ride to: after each routed attempt, nudge the wanted
// distance by target/actual (Newton step) and choose the place closest to it.
async function generateDestLoop(start, targetM, sector, sights, towns, networkPoints) {
  let pool = anchorsInSector(sights.filter((s) => s.name), start, sector, targetM);
  if (!pool.length) pool = anchorsInSector(sights, start, sector, targetM);
  if (!pool.length) pool = anchorsInSector(towns.map((t) => ({ ...t, kind: "town" })), start, sector, targetM);
  if (!pool.length) return null;

  let best = null, bestErr = Infinity;
  let wantD = targetM * 0.34;
  const tried = new Set();

  for (let attempt = 0; attempt < 3 && bestErr > 0.10; attempt++) {
    let dest = null, bd = Infinity;
    for (const p of pool) {
      const e = Math.abs(p.d - wantD);
      if (!tried.has(p) && e < bd) { bd = e; dest = p; }
    }
    if (!dest) break;
    tried.add(dest);

    const lensFrac = 0.12 + Math.random() * 0.10; // gentle, predictable fatness
    const pts = buildTownLoopWaypoints(start, dest, lensFrac, networkPoints);
    let route;
    try { route = await routeVia(pts, el.profile.value); }
    catch (e) { continue; }

    const err = Math.abs(route.distance - targetM) / targetM;
    if (err < bestErr) {
      bestErr = err;
      best = { ...route, waypoints: pts, town: dest.name || titleCase(dest.kind), destKind: dest.kind || "town", dest };
    }
    if (route.distance > 0) {          // steer the wanted distance toward target
      wantD = Math.max(targetM * 0.18, Math.min(targetM * 0.55, wantD * targetM / route.distance));
    }
  }
  return best;
}

async function generateLoops() {
  const km = parseFloat(el.genDist.value);
  if (!(km > 0)) { setGen("Enter a target distance first.", true); return; }

  const targetM = km * 1000;
  const start = startPoint();
  const N = 5;
  const bearingOffset = Math.random() * 360;

  genOptions = [];
  el.genResults.innerHTML = "";
  clearSights();
  el.genBtn.disabled = true;
  el.genBtn.classList.add("busy");
  bounceStart();
  startGenLoadingAnim(start); // draw random "trial" routes while we work

  const finish = () => { el.genBtn.disabled = false; el.genBtn.classList.remove("busy"); stopGenLoadingAnim(); };

  // Find sightseeing spots to ride out to. Only fall back to a towns lookup when
  // sights are sparse — keeps it to a single Overpass query in the common case
  // (two at once trips Overpass's concurrent-request limit).
  setGen("Finding sights to ride to…");
  let sights = [], sightsFailed = false;
  try { sights = await fetchSights(start, targetM * 0.6); } catch (e) { sightsFailed = true; }
  let towns = [], townsFailed = false;
  if (sights.length < 10) {
    setGen("Finding places to ride to…");
    try { towns = await fetchTowns(start, targetM * 0.6); } catch (e) { townsFailed = true; }
  }
  if (!sights.length && !towns.length) {
    finish();
    if (sightsFailed || townsFailed) {
      setGen("Couldn't reach Overpass — try again in a moment.", true);
      showCrash("Couldn't reach Overpass (the map data service) to find places to ride to. It might be busy — try again in a moment.");
    } else {
      setGen("No sights or towns found near here — try a different spot or distance.", true);
      toast("No rides found here — try another spot or distance", "info");
    }
    return;
  }

  // Optional scenic via-snapping to the cycle network.
  let networkPoints = null;
  if (el.useNetwork.checked) {
    try {
      const np = await fetchCycleNetwork(start, targetM * 0.5);
      if (np.length >= 6) networkPoints = np;
    } catch (e) { /* scenic snapping is best-effort */ }
  }

  const used = new Set();
  let idx = 0, tries = 0;
  while (genOptions.length < N && tries < N + 8) {
    setGen(`Plotting ride ${genOptions.length + 1} of ${N}…`);
    const sector = (bearingOffset + idx * (360 / N)) % 360;
    idx++; tries++;
    const availSights = sights.filter((s) => !used.has(s.name + s.lat));
    const opt = await generateDestLoop(start, targetM, sector, availSights, towns, networkPoints);
    if (opt && opt.coords.length > 1) {
      used.add(opt.dest.name + opt.dest.lat);
      opt.bearing = sector;
      opt.gain = elevGainOf(opt.coords);
      opt.network = !!networkPoints;
      // Named sights within 200 m of the route — the ones you actually pass —
      // ranked by how eye-catching they are and capped so the map stays legible.
      opt.sights = sightsAlong(opt.coords, sights, 200)
        .filter((s) => s.name)
        .sort((a, b) => sightWeight(b.kind) - sightWeight(a.kind))
        .slice(0, 24);
      genOptions.push(opt);
      renderOptionCard(opt, genOptions.length - 1);
    }
  }

  finish();
  if (!genOptions.length) {
    setGen("Couldn't plot rides here — try another spot or distance.", true);
    toast("No rides found here — try another spot or distance", "error");
  } else {
    const seen = new Set(genOptions.flatMap((o) => o.sights.map((s) => s.name + s.lat)));
    setGen(`${genOptions.length} ride${genOptions.length > 1 ? "s" : ""} ready · click one to load it.`);
    toast(`${genOptions.length} rides past ${seen.size} sights ready`, "success");
  }
}

// Small normalized SVG sketch of a route's shape for the option card.
function miniThumb(coords) {
  const step = Math.max(1, Math.floor(coords.length / 120));
  const pts = coords.filter((_, i) => i % step === 0);
  const lats = pts.map((c) => c[1]), lons = pts.map((c) => c[0]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const W = 78, H = 54, pad = 7;
  const sx = (maxLon - minLon) || 1e-6, sy = (maxLat - minLat) || 1e-6;
  const scale = Math.min((W - 2 * pad) / sx, (H - 2 * pad) / sy);
  const ox = (W - sx * scale) / 2, oy = (H - sy * scale) / 2;
  let d = "";
  pts.forEach((c, i) => {
    const x = ox + (c[0] - minLon) * scale;
    const y = H - (oy + (c[1] - minLat) * scale);
    d += (i ? "L" : "M") + `${x.toFixed(1)} ${y.toFixed(1)} `;
  });
  const sx0 = ox + (coords[0][0] - minLon) * scale;
  const sy0 = H - (oy + (coords[0][1] - minLat) * scale);
  return `<svg viewBox="0 0 ${W} ${H}">
    <path d="${d}" fill="none" stroke="#2dd4bf" stroke-width="2"
          stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${sx0.toFixed(1)}" cy="${sy0.toFixed(1)}" r="3" fill="#36c275" stroke="#fff" stroke-width="1"/>
  </svg>`;
}

function renderOptionCard(opt, i) {
  const card = document.createElement("button");
  card.className = "route-card";
  card.dataset.idx = String(i);
  card.innerHTML = `
    <div class="route-thumb">${miniThumb(opt.coords)}</div>
    <div class="route-meta">
      <span class="route-dist">${(opt.distance / 1000).toFixed(1)} km</span>
      <span class="route-sub">${sightEmoji(opt.destKind)} <span class="chip">${opt.town || "open country"}</span> · 👁 ${opt.sights.length} · ⛰ ${Math.round(opt.gain)} m · ${compass(opt.bearing)}</span>
    </div>`;
  card.addEventListener("click", () => selectOption(i));
  card.addEventListener("mouseenter", () => showPreview(opt));
  card.addEventListener("mouseleave", hidePreview);
  el.genResults.appendChild(card);
}

// Faintly trace a candidate loop on the map while its card is hovered.
function showPreview(opt) {
  previewLayer.setLatLngs(opt.coords.map((c) => [c[1], c[0]]));
}
function hidePreview() {
  previewLayer.setLatLngs([]);
}

function selectOption(i) {
  const opt = genOptions[i];
  if (!opt) return;

  // opt.waypoints = [start, outVia, dest, retVia, start]; START pin gets the
  // first point, the middle points become the editable following pins.
  applyLoadedRoute({
    start: opt.waypoints[0],
    waypoints: opt.waypoints.slice(1, -1),
    coords: opt.coords,
    loop: true,
    messages: opt.messages,
  });

  document.querySelectorAll(".route-card").forEach((c) => c.classList.remove("selected"));
  const card = el.genResults.querySelector(`[data-idx="${i}"]`);
  if (card) card.classList.add("selected");

  renderSights(opt.sights || []);
  const dest = opt.town ? ` to ${opt.town}` : "";
  const seen = (opt.sights || []).length;
  setStatus(`Loaded a ${(opt.distance / 1000).toFixed(1)} km ride${dest}${seen ? ` · passing ${seen} sights 👁` : ""} · drag points to tweak, then export.`);
}

function setGen(msg, isError = false) {
  el.genStatus.textContent = msg;
  el.genStatus.classList.toggle("error", isError);
}

// ---------- Saved routes (localStorage) ----------
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function persistSaved(arr) { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); }

// Trim coordinate precision so many routes fit comfortably in localStorage.
function roundCoords(coords) {
  return coords.map((c) =>
    c.length > 2 && c[2] != null
      ? [+c[0].toFixed(6), +c[1].toFixed(6), +c[2].toFixed(1)]
      : [+c[0].toFixed(6), +c[1].toFixed(6)]);
}

function saveCurrentRoute() {
  if (state.routeCoords.length < 2) { setStatus("Build a route first.", true); return; }
  const saved = loadSaved();
  const item = {
    id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2)),
    name: (el.routeName.value || "Road ride").trim(),
    createdAt: Date.now(),
    profile: el.profile.value,
    loop: el.loop.checked,
    distance: state.distance,
    gain: state.gain,
    start: { lat: +startPoint().lat.toFixed(6), lon: +startPoint().lon.toFixed(6) },
    waypoints: state.waypoints.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })),
    coords: roundCoords(state.routeCoords),
  };
  saved.unshift(item);
  try { persistSaved(saved); }
  catch (e) { toast("Couldn't save — storage full? Delete some routes.", "error"); return; }
  renderSavedList();
  toast(`Saved "${item.name}" · ${(item.distance / 1000).toFixed(1)} km`, "success");
  playRideAnimation();
}

// A little cyclist rides the whole route once — a flourish when you save.
let rideAnimId = 0;
function playRideAnimation() {
  const coords = state.routeCoords;
  if (!coords || coords.length < 2) return;
  const myId = ++rideAnimId;

  // Cumulative distance along the route so speed is even.
  const xs = [0];
  for (let i = 1; i < coords.length; i++) {
    xs.push(xs[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  const total = xs[xs.length - 1] || 1;

  const icon = L.divIcon({ className: "", html: `<div class="ride-bike">🚴</div>`, iconSize: [34, 34], iconAnchor: [17, 17] });
  const marker = L.marker([coords[0][1], coords[0][0]], { icon, interactive: false, zIndexOffset: 3000 }).addTo(map);

  const dur = Math.min(4200, Math.max(2200, total / 12)); // ~ scale with length
  const t0 = performance.now();
  function step(now) {
    if (myId !== rideAnimId) { map.removeLayer(marker); return; } // superseded
    const p = Math.min(1, (now - t0) / dur);
    const target = p * total;
    let i = 1;
    while (i < xs.length - 1 && xs[i] < target) i++;
    const a = coords[i - 1], b = coords[i];
    const span = xs[i] - xs[i - 1] || 1;
    const f = Math.min(1, Math.max(0, (target - xs[i - 1]) / span));
    marker.setLatLng([a[1] + (b[1] - a[1]) * f, a[0] + (b[0] - a[0]) * f]);
    // face the direction of travel (via a CSS var the bob animation respects)
    const dom = marker.getElement() && marker.getElement().querySelector(".ride-bike");
    if (dom) dom.style.setProperty("--flip", (b[0] < a[0]) ? "scaleX(-1)" : "scaleX(1)");
    if (p < 1) requestAnimationFrame(step);
    else { const el2 = marker.getElement(); if (el2) el2.querySelector(".ride-bike").classList.add("finish"); setTimeout(() => map.removeLayer(marker), 400); }
  }
  requestAnimationFrame(step);
}

// ---------- Share route via link ----------
// Encodes just the waypoints (not the full polyline) into the URL hash, so the
// link stays short; opening it re-routes through BRouter to rebuild the ride.
function encodeRouteHash() {
  if (state.waypoints.length < 1) return null;
  const round = (p) => [+p.lat.toFixed(5), +p.lon.toFixed(5)];
  const payload = {
    s: round(startPoint()),
    w: state.waypoints.map(round),
    l: el.loop.checked ? 1 : 0,
    p: el.profile.value,
    n: (el.routeName.value || "").slice(0, 60),
  };
  return btoa(encodeURIComponent(JSON.stringify(payload)));
}

function decodeRouteHash(hash) {
  try {
    const json = decodeURIComponent(atob(hash));
    const d = JSON.parse(json);
    if (!Array.isArray(d.s) || !Array.isArray(d.w)) return null;
    return {
      start: { lat: d.s[0], lon: d.s[1] },
      waypoints: d.w.map((p) => ({ lat: p[0], lon: p[1] })),
      loop: !!d.l, profile: d.p || "fastbike", name: d.n || "Shared ride",
    };
  } catch (e) { return null; }
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

async function shareRoute() {
  const hash = encodeRouteHash();
  if (!hash) { toast("Build a route first", "error"); return; }
  const url = `${location.origin}${location.pathname}#r=${hash}`;
  const copied = await copyToClipboard(url);
  if (copied) {
    toast("Share link copied — paste it anywhere, opening it rebuilds this ride", "success");
  } else {
    window.prompt("Copy this link to share your ride:", url);
  }
}

// On load, check for a #r=<data> share link and rebuild that route. Unlike
// applyLoadedRoute (which takes a ready-made polyline), a share link only
// carries waypoints — so this re-routes through BRouter to reconstruct it.
function loadSharedRouteFromHash() {
  const m = location.hash.match(/^#r=(.+)$/);
  if (!m) return false;
  const data = decodeRouteHash(m[1]);
  if (!data) { toast("That share link looks invalid or corrupted", "error"); return false; }

  ++routeSeq; // invalidate any in-flight recalc
  clearTimeout(recalcTimer);
  if (data.profile) el.profile.value = data.profile;
  if (data.name != null) el.routeName.value = data.name;
  el.loop.checked = !!data.loop;
  startMarker.setLatLng([data.start.lat, data.start.lon]);
  state.waypoints = data.waypoints.map((p) => ({ lat: p.lat, lon: p.lon }));
  renderMarkers();
  map.setView([data.start.lat, data.start.lon], 13);
  recalcRoute(); // debounced -> runRoute() re-fetches from BRouter and updates everything

  toast(`Loading shared ride: ${data.name}…`, "info");
  history.replaceState(null, "", location.pathname); // keep the hash out of future shares
  return true;
}

function loadSavedRoute(id) {
  const item = loadSaved().find((r) => r.id === id);
  if (!item) return;
  // Back-compat: older saves kept the start as waypoints[0].
  const start = item.start || (item.waypoints && item.waypoints[0]);
  const wps = item.start ? item.waypoints : (item.waypoints || []).slice(1);
  applyLoadedRoute({
    start, waypoints: wps, coords: item.coords,
    loop: item.loop, profile: item.profile, name: item.name,
  });
  toast(`Loaded "${item.name}" · ${(item.distance / 1000).toFixed(1)} km`, "info");
}

function deleteSavedRoute(id) {
  const saved = loadSaved();
  const item = saved.find((r) => r.id === id);
  if (item && !confirm(`Delete "${item.name}"?`)) return;
  persistSaved(saved.filter((r) => r.id !== id));
  renderSavedList();
  if (item) toast(`Deleted "${item.name}"`, "info");
}

function renderSavedList() {
  const saved = loadSaved();
  el.savedCount.textContent = saved.length ? `(${saved.length})` : "";
  if (!saved.length) {
    el.savedList.innerHTML = '<p class="hint">No saved routes yet. Build or generate one, then hit 💾 Save route.</p>';
    return;
  }
  el.savedList.innerHTML = "";
  saved.forEach((item) => {
    const date = new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const card = document.createElement("div");
    card.className = "saved-card";
    card.innerHTML = `
      <div class="saved-info">
        <span class="saved-name"></span>
        <span class="saved-sub">${(item.distance / 1000).toFixed(1)} km · ⛰ ${Math.round(item.gain)} m · ${date}${item.loop ? " · ↻" : ""}</span>
      </div>
      <div class="saved-actions">
        <button class="mini load">Load</button>
        <button class="mini del" title="Delete">✕</button>
      </div>`;
    card.querySelector(".saved-name").textContent = item.name; // textContent = XSS-safe
    card.querySelector(".load").addEventListener("click", () => loadSavedRoute(item.id));
    card.querySelector(".del").addEventListener("click", () => deleteSavedRoute(item.id));
    el.savedList.appendChild(card);
  });
}

// ---------- Stats ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// BRouter occasionally returns points with no elevation (e.g. at waypoint
// junctions). Carry the last known value forward (and back-fill any leading
// gaps) so stats, the profile, and the GPX stay continuous. Returns null only
// if there is no elevation data at all (e.g. straight-line fallback).
function filledElevations(coords) {
  const out = new Array(coords.length).fill(null);
  let last = null;
  for (let i = 0; i < coords.length; i++) {
    if (coords[i][2] != null) last = coords[i][2];
    out[i] = last;
  }
  const firstKnown = out.find((v) => v != null);
  if (firstKnown == null) return null;
  for (let i = 0; i < out.length && out[i] == null; i++) out[i] = firstKnown;
  return out;
}

function computeStatsFromCoords(coords) {
  let dist = 0, gain = 0, loss = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    dist += haversine(lat1, lon1, lat2, lon2);
  }
  const eles = filledElevations(coords);
  if (eles) {
    for (let i = 1; i < eles.length; i++) {
      const d = eles[i] - eles[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
  }
  state.distance = dist; state.gain = gain; state.loss = loss;

  el.distance.textContent = `${(dist / 1000).toFixed(1)} km`;
  el.gain.textContent = `${Math.round(gain)} m`;
  el.loss.textContent = `${Math.round(loss)} m`;
  el.points.textContent = String(pointCount());
}

function resetStats() {
  state.distance = state.gain = state.loss = 0;
  el.distance.textContent = "0.0 km";
  el.gain.textContent = "0 m";
  el.loss.textContent = "0 m";
}

// ---------- Elevation profile (inline SVG) ----------
// Tour de France–style climb categorisation from the FIETS coefficient
// (gain_m^2 / (length_m * 10)). Finds turning points in the smoothed profile
// and scores each uphill stretch between a low and a high point.
const CLIMB_CATS = [
  { min: 8, cat: "HC", color: "#d9483b" },
  { min: 6, cat: "1", color: "#e9642e" },
  { min: 4.5, cat: "2", color: "#edb03a" },
  { min: 3, cat: "3", color: "#6bbf59" },
  { min: 1.5, cat: "4", color: "#4aa3ff" },
];
function computeClimbs(xs, eles) {
  const n = eles.length;
  if (n < 6) return [];
  const smooth = eles.map((_, i) => {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    let sum = 0, count = 0;
    for (let j = a; j <= b; j++) { sum += eles[j]; count++; }
    return sum / count;
  });

  // Mark each inter-point span as "climbing" when its gradient clears a
  // minimum threshold (Strava-style), then merge spans separated by only a
  // short non-climbing gap so one climb with a brief flat/dip isn't split.
  const minGrade = 2.5, maxGapM = 200;
  const spans = [];
  for (let i = 0; i < n - 1; i++) {
    const d = xs[i + 1] - xs[i];
    if (d <= 0) continue;
    const grade = ((smooth[i + 1] - smooth[i]) / d) * 100;
    spans.push({ i, j: i + 1, climbing: grade >= minGrade, d });
  }

  const runs = [];
  let cur = null;
  for (const s of spans) {
    if (s.climbing) {
      if (!cur) cur = { startI: s.i, endI: s.j, gapM: 0 };
      else { cur.endI = s.j; cur.gapM = 0; }
    } else if (cur) {
      cur.gapM += s.d;
      if (cur.gapM > maxGapM) { runs.push(cur); cur = null; }
      else { cur.endI = s.j; } // bridge the small gap, keep extending
    }
  }
  if (cur) runs.push(cur);

  const climbs = [];
  for (const r of runs) {
    const gain = eles[r.endI] - eles[r.startI];
    const lengthM = xs[r.endI] - xs[r.startI];
    if (gain < 20 || lengthM < 200) continue;
    const coeff = (gain * gain) / (lengthM * 10);
    const tier = CLIMB_CATS.find((c) => coeff >= c.min);
    if (!tier) continue; // below Cat 4 — not worth a badge
    climbs.push({
      startX: xs[r.startI], endX: xs[r.endI], peakIdx: r.endI,
      gainM: Math.round(gain), lengthKm: +(lengthM / 1000).toFixed(1),
      gradePct: +((gain / lengthM) * 100).toFixed(1),
      cat: tier.cat, color: tier.color,
    });
  }
  return climbs;
}

function renderElevation() {
  const coords = state.routeCoords;
  const eles = coords.length > 1 ? filledElevations(coords) : null;
  hideElevCursor();
  // A map overlay should only take up space when there's actually a route to
  // show — otherwise it'd float over the map with nothing useful in it.
  el.elevOverlay.hidden = coords.length < 2;

  if (!eles) {
    state.elevProfile = null;
    el.elevHint.textContent = coords.length > 1 && !state.snapped ? "no elevation data" : "";
    el.elevChart.innerHTML = '<div class="elev-empty">Add 2+ points to see the climb profile</div>';
    return;
  }

  // Build cumulative distance (x) and elevation (y) arrays.
  const xs = [0];
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    xs.push(xs[i - 1] + haversine(lat1, lon1, lat2, lon2));
  }
  const totalX = xs[xs.length - 1] || 1;
  const minE = Math.min(...eles), maxE = Math.max(...eles);
  const range = Math.max(maxE - minE, 1);

  // Stash for the hover handler.
  state.elevProfile = { xs, eles, coords, totalX };

  const W = 320, H = 90, pad = 4;
  const px = (x) => pad + (x / totalX) * (W - 2 * pad);
  const py = (e) => H - pad - ((e - minE) / range) * (H - 2 * pad - 8);

  let line = "", area = `M ${px(0)} ${H - pad}`;
  eles.forEach((e, i) => {
    const X = px(xs[i]), Y = py(e);
    line += (i === 0 ? "M" : "L") + ` ${X.toFixed(1)} ${Y.toFixed(1)} `;
    area += ` L ${X.toFixed(1)} ${Y.toFixed(1)}`;
  });
  area += ` L ${px(totalX)} ${H - pad} Z`;

  const climbs = computeClimbs(xs, eles);
  state.climbs = climbs;
  const bands = climbs.map((c) =>
    `<rect x="${px(c.startX).toFixed(1)}" y="${H - pad - 4}" width="${(px(c.endX) - px(c.startX)).toFixed(1)}" height="4" fill="${c.color}"><title>Cat ${c.cat} climb: ${c.lengthKm} km at ${c.gradePct}% (+${c.gainM} m)</title></rect>`
  ).join("");
  const badges = climbs.map((c) => {
    const x = px(xs[c.peakIdx]), y = Math.max(11, py(eles[c.peakIdx]) - 11);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="${c.color}" stroke="#1c130d" stroke-width="1"><title>Cat ${c.cat} climb: ${c.lengthKm} km at ${c.gradePct}% (+${c.gainM} m)</title></circle>` +
      `<text x="${x.toFixed(1)}" y="${(y + 2.8).toFixed(1)}" font-size="8" font-weight="700" fill="#fff" text-anchor="middle" font-family="sans-serif" pointer-events="none">${c.cat}</text>`;
  }).join("");

  el.elevHint.textContent = climbs.length
    ? `${Math.round(minE)}–${Math.round(maxE)} m · ${climbs.length} climb${climbs.length > 1 ? "s" : ""} (${climbs.map((c) => "Cat " + c.cat).join(", ")})`
    : `${Math.round(minE)}–${Math.round(maxE)} m`;
  el.elevChart.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff6b35" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#ff6b35" stop-opacity="0.04"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#elevFill)" />
      <path d="${line}" fill="none" stroke="#ffa94d" stroke-width="1.8"
            stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      ${bands}
      ${badges}
    </svg>`;
}

// Track the elevation profile under the cursor: a vertical line + tooltip on the
// chart, and a synced dot on the map.
function onElevHover(e) {
  const p = state.elevProfile;
  if (!p) return;
  const rect = el.elevation.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const targetDist = frac * p.totalX;

  let i = 1;
  while (i < p.xs.length - 1 && p.xs[i] < targetDist) i++;
  const coord = p.coords[i], ele = p.eles[i];

  el.elevCursor.style.display = "block";
  el.elevCursor.style.left = `${frac * 100}%`;
  el.elevTip.style.display = "block";
  el.elevTip.style.left = `${Math.min(88, Math.max(12, frac * 100))}%`;
  el.elevTip.textContent = `${(targetDist / 1000).toFixed(1)} km · ${Math.round(ele)} m`;

  hoverMarker.setLatLng([coord[1], coord[0]]).setStyle({ opacity: 1, fillOpacity: 1 });
}

function hideElevCursor() {
  el.elevCursor.style.display = "none";
  el.elevTip.style.display = "none";
  if (hoverMarker) hoverMarker.setStyle({ opacity: 0, fillOpacity: 0 });
}

// ---------- GPX export ----------
function buildGPX() {
  const name = (el.routeName.value || "Road ride").trim();
  const esc = (s) => s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
  const time = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const eles = filledElevations(state.routeCoords);
  const trkpts = state.routeCoords.map((c, i) => {
    const lat = c[1].toFixed(7), lon = c[0].toFixed(7);
    const ele = eles ? `<ele>${eles[i].toFixed(1)}</ele>` : "";
    return `      <trkpt lat="${lat}" lon="${lon}">${ele}</trkpt>`;
  }).join("\n");

  // Turn cue sheet as a <rte> of named route points (device turn prompts).
  const cues = state.cues || computeCues(state.routeCoords);
  const rte = cues.length ? `
  <rte>
    <name>${esc(name)} — cues</name>
${cues.map((c) => `    <rtept lat="${c.lat.toFixed(7)}" lon="${c.lon.toFixed(7)}"><name>${esc(c.text)}</name><type>${c.dir}</type></rtept>`).join("\n")}
  </rte>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rouleur"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${esc(name)}</name>
    <time>${time}</time>
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    <type>cycling</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>${rte}
</gpx>
`;
}

function exportGPX() {
  if (state.routeCoords.length < 2) return;
  const gpx = buildGPX();
  const name = (el.routeName.value || "road-ride").trim().replace(/[^\w\-]+/g, "_").toLowerCase();
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name || "road-ride"}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${a.download} — import into your bike computer or app`, "success");
}

// ---------- Geocode search ----------
async function search() {
  const q = el.search.value.trim();
  if (!q) return;
  setStatus("Searching…");
  try {
    const res = await fetch(`${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(q)}`, {
      headers: { "Accept-Language": navigator.language || "en" },
    });
    const data = await res.json();
    if (!data.length) { setStatus(`No match for "${q}".`, true); return; }
    const { lat, lon, display_name } = data[0];
    const ll = [parseFloat(lat), parseFloat(lon)];
    map.setView(ll, 14);
    startMarker.setLatLng(ll);           // drop START at the searched place
    bounceStart();
    savePrefs();
    recalcRoute();
    invalidateGenOptions();
    const place = display_name.split(",")[0];
    setStatus(`START set at ${place}.`);
    toast(`START set at ${place}`, "success");
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, true);
    toast(`Search failed: ${err.message}`, "error");
  }
}

function locate() {
  if (!navigator.geolocation) { toast("Geolocation isn't available in this browser.", "error"); return; }
  setStatus("Locating…");
  const btn = el.locateBtn;
  if (btn) { btn.disabled = true; btn.textContent = "📍 Locating…"; }
  const done = () => { if (btn) { btn.disabled = false; btn.textContent = "📍 Center on my location"; } };

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      map.setView(ll, 15);
      startMarker.setLatLng(ll);         // drop START at my location
      bounceStart();
      savePrefs();
      recalcRoute();
      invalidateGenOptions();
      setStatus("");
      toast("START set to your location", "success");
      done();
    },
    (err) => {
      setStatus("");
      done();
      const msg = err.code === 1
        ? "Location is blocked. Allow location access for this site in your browser (click the address-bar icon), or just search a place / click the map."
        : err.code === 3
          ? "Location timed out — try again, or search a place instead."
          : `Couldn't get your location (${err.message}).`;
      toast(msg, "error");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// ---------- UI helpers ----------
function showSpinner(on) { el.spinner.classList.toggle("hidden", !on); }
function setStatus(msg, isError = false) {
  el.status.textContent = msg;
  el.status.classList.toggle("error", isError);
}

// Transient slide-in notification. type: 'info' | 'success' | 'error'.
function toast(msg, type = "info") {
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  el.toasts.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

// A cyclist takes a comedic spill when a hard API failure blocks an action
// (e.g. Overpass is down). Stays up until dismissed via the X — unlike toasts,
// this marks something that actually failed to complete, not just a status update.
function showCrash(message) {
  el.errorMessage.textContent = message;
  el.errorModal.hidden = false;
  // Restart the CSS animation every time it's shown.
  el.crashCyclist.style.animation = "none";
  void el.crashCyclist.offsetWidth;
  el.crashCyclist.style.animation = "";
}
function hideCrash() { el.errorModal.hidden = true; }

// ---------- Preferences (localStorage) ----------
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; }
  catch { return {}; }
}

let prefsTimer = null;
function scheduleSavePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(savePrefs, 600);
}
function savePrefs() {
  if (!map) return;
  const c = map.getCenter();
  const s = startMarker && startMarker.getLatLng();
  const prefs = {
    center: { lat: +c.lat.toFixed(5), lon: +c.lng.toFixed(5) },
    zoom: map.getZoom(),
    start: s ? { lat: +s.lat.toFixed(5), lon: +s.lng.toFixed(5) } : undefined,
    routeName: el.routeName.value,
    profile: el.profile.value,
    loop: el.loop.checked,
    genDist: el.genDist.value,
    useNetwork: el.useNetwork.checked,
    pace: el.paceSlider.value,
    theme: document.documentElement.getAttribute("data-theme") || "retro",
    mode: document.documentElement.getAttribute("data-mode") || "retro",
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

// Cycling team KIT (colour scheme).
const KITS = ["retro", "visma", "uae", "ineos", "quickstep", "ef", "bora", "roserockets"];
const KIT_NAMES = {
  retro: "Rouleur — vintage", visma: "Visma | Lease a Bike", uae: "UAE Team Emirates",
  ineos: "INEOS Grenadiers", quickstep: "Soudal Quick-Step", ef: "EF Education-EasyPost",
  bora: "Red Bull – Bora-Hansgrohe", roserockets: "Rose Rockets",
};
// Simplified team crests (own colours + initials — no copyrighted logos).
const CRESTS = {
  retro:       { label: "R",   c1: "#e9642e", c2: "#edb03a", ink: "#241009" },
  visma:       { label: "V",   c1: "#ffdd00", c2: "#141410", ink: "#141410" },
  uae:         { label: "UAE", c1: "#e4002b", c2: "#141110", ink: "#f5ede4" },
  ineos:       { label: "IG",  c1: "#0b1420", c2: "#da291c", ink: "#eef4fb" },
  quickstep:   { label: "QS",  c1: "#123fb0", c2: "#ff6a1a", ink: "#eef4fd" },
  ef:          { label: "EF",  c1: "#ff1f8e", c2: "#6fd0d6", ink: "#fbf3ff" },
  bora:        { label: "RB",  c1: "#0b1636", c2: "#dd1e36", ink: "#ffc906" },
  roserockets: { label: "RR",  c1: "#ff5c8a", c2: "#ffcc4d", ink: "#241019" },
};
function crestSVG(kit) {
  const c = CRESTS[kit] || CRESTS.retro;
  const size = c.label.length > 2 ? 11 : 17;
  return `<svg viewBox="0 0 44 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 5 H40 V29 C40 41 22 49 22 49 C22 49 4 41 4 29 Z" fill="${c.c1}" stroke="#1c130d" stroke-width="2.5"/>
    <path d="M4 5 H40 V14 H4 Z" fill="${c.c2}"/>
    <text x="22" y="35" text-anchor="middle" font-family="Oswald, sans-serif" font-weight="700" font-size="${size}" fill="${c.ink}">${c.label}</text>
  </svg>`;
}

function setTheme(name) {
  const t = KITS.includes(name) ? name : "retro";
  document.documentElement.setAttribute("data-theme", t);
  document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.theme === t));
  const nameEl = document.getElementById("kitName");
  if (nameEl) nameEl.textContent = KIT_NAMES[t] || "";
  const crestEl = document.getElementById("crest");
  if (crestEl) crestEl.innerHTML = crestSVG(t);
  // Recolour the route + preview lines to match the kit so nothing looks off-team.
  const css = getComputedStyle(document.documentElement);
  if (routeLayer) routeLayer.setStyle({ color: css.getPropertyValue("--accent").trim() || "#ff6b35" });
  if (previewLayer) previewLayer.setStyle({ color: css.getPropertyValue("--go").trim() || "#2dd4bf" });
}

// Retro (vintage jersey) vs Modern (flat/clean) visual mode — orthogonal to KIT color.
function setMode(name) {
  const m = name === "modern" ? "modern" : "retro";
  document.documentElement.setAttribute("data-mode", m);
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
}

function applyPrefs() {
  const p = loadPrefs();
  if (p.routeName != null) el.routeName.value = p.routeName;
  if (p.profile) el.profile.value = p.profile;
  if (typeof p.loop === "boolean") el.loop.checked = p.loop;
  if (typeof p.useNetwork === "boolean") el.useNetwork.checked = p.useNetwork;
  if (p.genDist) syncGenDist(parseFloat(p.genDist));
  if (p.pace) { el.paceSlider.value = p.pace; el.paceLabel.textContent = `${paceKmh()} km/h`; }
  setTheme(p.theme || "retro");
  setMode(p.mode || "retro");
}

// ---------- Wire up ----------
function bumpDist() {
  const l = el.genDistLabel;
  l.classList.remove("bump");
  void l.offsetWidth; // restart animation
  l.classList.add("bump");
}

function syncGenDist(value, from) {
  let v = Math.max(1, Math.min(300, Math.round(value || 0)));
  el.genDist.value = String(v);
  el.genSlider.value = String(Math.max(5, Math.min(150, v)));
  el.genDistLabel.textContent = `${v} km`;
  bumpDist();
}

function bind() {
  el.export.addEventListener("click", exportGPX);
  el.share.addEventListener("click", shareRoute);
  el.profile.addEventListener("change", recalcRoute);
  el.loop.addEventListener("change", () => { renderMarkers(); recalcRoute(); });
  el.searchBtn.addEventListener("click", search);
  el.search.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  el.locateBtn.addEventListener("click", locate);

  // Café/water stop swipe deck
  el.swipeAdd.addEventListener("click", () => swipeDecide(true));
  el.swipeSkip.addEventListener("click", () => swipeDecide(false));
  el.swipeClose.addEventListener("click", () => closeStopSwipe(true));
  // Backdrop click (anywhere outside the panel itself) also closes it.
  el.swipeModal.addEventListener("click", (e) => { if (!e.target.closest(".swipe-panel")) closeStopSwipe(true); });
  el.swipeModal.addEventListener("mousedown", (e) => { if (!e.target.closest(".swipe-panel")) e.preventDefault(); });

  // Overpass-down crash screen
  el.errorClose.addEventListener("click", hideCrash);
  el.errorModal.addEventListener("click", (e) => { if (!e.target.closest(".error-panel")) hideCrash(); });
  el.errorModal.addEventListener("mousedown", (e) => { if (!e.target.closest(".error-panel")) e.preventDefault(); });

  // Escape closes whichever modal is open, as a reliable fallback.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!el.errorModal.hidden) hideCrash();
    else if (!el.swipeModal.hidden) closeStopSwipe(true);
  });

  el.paceSlider.addEventListener("input", () => {
    el.paceLabel.textContent = `${paceKmh()} km/h`;
    renderRideTime();
    scheduleSavePrefs();
  });

  // Random loop generator
  el.genSlider.addEventListener("input", () => { syncGenDist(parseFloat(el.genSlider.value)); scheduleSavePrefs(); });
  el.genDist.addEventListener("input", () => {
    el.genDistLabel.textContent = `${el.genDist.value || 0} km`;
    bumpDist();
    const v = parseFloat(el.genDist.value);
    if (v >= 5 && v <= 150) el.genSlider.value = String(Math.round(v));
    scheduleSavePrefs();
  });
  el.genBtn.addEventListener("click", generateLoops);

  // KIT colour schemes
  document.querySelectorAll(".swatch").forEach((s) =>
    s.addEventListener("click", () => { setTheme(s.dataset.theme); savePrefs(); }));

  // Retro / Modern style switch
  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.addEventListener("click", () => { setMode(b.dataset.mode); savePrefs(); }));

  // Interactive elevation profile
  el.elevation.addEventListener("mousemove", onElevHover);
  el.elevation.addEventListener("mouseleave", hideElevCursor);

  // Persist preferences as they change
  el.routeName.addEventListener("input", scheduleSavePrefs);
  el.profile.addEventListener("change", scheduleSavePrefs);
  el.loop.addEventListener("change", scheduleSavePrefs);
  el.useNetwork.addEventListener("change", scheduleSavePrefs);

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); }
    if (e.key === "Escape" && moveIndex >= 0) {
      moveIndex = -1;
      map.getContainer().classList.remove("moving");
      setStatus("Move cancelled.");
    }
  });
}

initMap();
bind();
applyPrefs();
loadSharedRouteFromHash();
renderSavedList();
