# 🚲 Pedal Plotter — Roadbike GPX Builder

A zero-install web app for drawing road-cycling routes and exporting **GPX files that import cleanly into any bike computer** — Garmin (Edge), Wahoo (ELEMNT / Bolt / Roam), Hammerhead (Karoo), Sigma, Bryton, and the usual apps (Komoot / RideWithGPS / Strava).

Click points on the map → the route snaps to real roads → export a clean GPX track with elevation. Or hit **Surprise me** and let it generate random loops of any distance for you.

## Run it

No build step, no server, no API keys. Just open the file:

```bash
open index.html        # macOS
```

Or serve it locally (recommended, so geolocation + search work reliably):

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

You need an internet connection (for map tiles + routing).

## How to use

1. **Drag the green START pin** to set where your ride begins (or use place-search /
   "Center on my location"). It's geo-anchored, so it stays put when you pan.
2. **Click the map** to add the following route points (numbered **1, 2, …**, the last
   is **F**). The route **snaps to roads** between them, starting from START.
3. **Drag** any point to reshape, or **click a point** for a **Move / Delete** popup
   (Move = then click the new spot; deletes pop out with a little animation).
   The on-map buttons (top-right) edit the track too: **🏠 Loop home** closes the
   route from the last point back to START, plus **↩ Undo** and **🗑 Clear**.
4. Pick a **riding style** (fast paved, quiet country roads, safest, trekking, gravel, shortest).
5. Tick **Return to start** to close the loop back to START.
6. Watch live **distance, elevation gain/loss**, and the **climb profile**.
7. Click **Export GPX**.

**KIT (colour schemes):** the swatches under the logo re-theme the **whole app —
background and all** — in the colours of real Tour de France teams: **Rouleur**
(house vintage), **Visma | Lease a Bike**, **UAE Team Emirates**, **INEOS
Grenadiers**, **Soudal Quick-Step**, **EF Education-EasyPost**, **Red Bull –
Bora-Hansgrohe**, plus the **Rose Rockets** wildcard. Your pick is remembered.

### 🎲 Surprise me — country rides

Don't feel like drawing? Let it plot rides out into the countryside for you:

1. **Pan the map** so the 🎯 center pin sits where you want to start.
2. Set a **target distance** (slider or type it).
3. Hit **Generate 5 loops**. You get five rides, each heading to a different
   **real town** out in the country.
4. Each result card shows the **shape, distance, destination town, climb, and
   direction** — hover a card to preview that ride on the map, then click to load
   it and tweak points or export as usual.

Instead of orbiting your start, each ride **picks a real town roughly the right
distance out** (named place nodes from the **OpenStreetMap / Overpass API**) and
plots a **there-and-back to it via two different corridors** — the outbound leg
bows one way, the return the other — so it reads as a teardrop, not a circle, and
barely retraces itself. Because it connects settlements, it naturally follows the
**long, fast, open roads between towns** and skips the city: in testing only ~18%
of a ride stays near home, and the turnaround sits ~14 km out for a 40 km target.

Distance is hit by **re-picking which town to ride to** (a Newton step on the
town distance after each routed attempt), landing within a few percent of target.
Riding style defaults to **Fast paved roads** for speed; switch it for quieter or
mixed surfaces. Tick **Add scenic cycle detours 🚲** to snap the corridor
via-points onto the signed cycle node-network (`rcn_ref`/`lcn_ref`/`ncn_ref`,
e.g. the Dutch *knooppunten*) — prettier, a little slower.

### 💾 Saved routes

Built a ride you like? Click **💾 Save route** and it's stored in your browser
(`localStorage`) under **Saved routes**, with its name, distance, elevation, and
date. **Load** brings it straight back onto the map for editing or re-export;
**✕** deletes it. Saved routes survive page reloads and stay entirely on your
machine — nothing is uploaded.

### Niceties
- **Interactive climb profile** — hover the elevation chart and a dot tracks the exact spot on the map, with a "distance · elevation" tooltip.
- **Toast notifications** — saves, exports, loads, and errors slide in briefly instead of only updating a status line.
- **Remembers you** — your last map position/zoom, route name, riding style, loop toggle, target distance, and cycle-network setting are restored on your next visit (stored locally).

### Get it onto your device
- **Garmin Edge:** drop the `.gpx` in the unit's `Garmin/NewFiles` (or `GPX`) folder over USB, or import as a Course in Garmin Connect.
- **Wahoo ELEMNT / Bolt / Roam:** Wahoo app → **Routes** → **+ / Import** the `.gpx`, then sync.
- **Hammerhead Karoo, Sigma, Bryton, etc.:** import the `.gpx` via each brand's app or file transfer.
- **Or** upload to **Komoot / RideWithGPS / Strava** for richer turn-by-turn cues, then sync to any linked computer.

The exported GPX is a standard GPX 1.1 `<trk>` (track) with `<ele>` elevation on every point — the format bike computers follow for breadcrumb navigation with off-route alerts.

## Keyboard shortcuts
- **Ctrl/Cmd + Z** — undo last point

## Tech
- [Leaflet](https://leafletjs.com/) with [CARTO Voyager](https://carto.com/basemaps/) base tiles (OpenStreetMap data); the route draws with a dark casing for contrast and a teal hover-preview for generated options
- [BRouter](https://brouter.de/) for road-snapped cycling routing with elevation (free, no key, CORS-enabled)
- [Overpass API](https://overpass-api.de/) for OSM data the generator uses — nearby towns to ride to, plus the cycle node-network for optional scenic detours
- [Nominatim](https://nominatim.org/) for place search
- `localStorage` for saved routes (no account, no server)
- Plain HTML/CSS/JS — no framework, no build

## Notes & limits
- BRouter and Overpass are free public services — be gentle with them; very long routes and network lookups may take a moment, and Overpass rate-limits rapid repeat queries (the generator then falls back to open-road loops).
- Network-snapped loops trade a little distance precision for nicer routing, since they must pass through fixed cycle junctions.
- If the router is unreachable, the app falls back to straight lines (clearly flagged) so you can still sketch — but those aren't road-snapped, so re-route before relying on the GPX.
- Saved routes live only in the current browser — clearing site data removes them, and they don't sync between devices.
- Profiles offered map to BRouter profiles: `fastbike`, `fastbike-lowtraffic`, `safety`, `trekking`, `gravel`, `shortest`.
