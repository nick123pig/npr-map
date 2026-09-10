<script>
  /*
   * NPR News Station Map: find your closest NPR News member station.
   * SPDX-License-Identifier: GPL-3.0-or-later
   *
   * Station data: NPR member directory. Coverage estimates: FCC licensed
   * ERP/HAAT/class data. Basemap (c) OpenFreeMap & OpenStreetMap contributors.
   */
  import { onMount } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import {
    haversineKm,
    nearestStation,
    ringBands,
    stationFeatures,
  } from './lib/geo.js';
  import { loadSanitizedStyle, installSpriteFallback } from './lib/basemap.js';

  let map;
  let mapReady = $state(false);
  let stations = $state([]);
  let loadError = $state('');
  let selected = $state(null); // { station, km }
  let query = $state('');
  let searchResults = $state([]);
  let searching = $state(false);
  let locating = $state(false);
  let userMarker = null;
  let panelEl = $state(null);
  let ringSource = null;
  let stationSource = null;

  let ringsGeojson = $derived(ringBands(stations));

  onMount(async () => {
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'data/stations.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();
      stations = doc.stations;
    } catch (e) {
      loadError = `Could not load station data (${e.message}).`;
      return;
    }

    const style = await loadSanitizedStyle();
    map = new maplibregl.Map({
      container: 'map',
      style,
      center: [-98, 39],
      zoom: 3.6,
      attributionControl: { compact: true },
    });
    installSpriteFallback(map, style);
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    if (import.meta.env.DEV) window.__map = map; // debugging aid
    map.on('load', () => {
      addSources();
      mapReady = true;
      map.setPadding(mapPadding());
    });

    // Keep the effective map center inside the visible area as the card
    // grows/shrinks (selection changes) or the device rotates. Deferred
    // while the camera moves, since setPadding cancels flyTo.
    const ro = new ResizeObserver(() => {
      if (map && mapReady) updatePadding();
    });
    ro.observe(panelEl);
    const onWinResize = () => {
      if (map) updatePadding();
    };
    window.addEventListener('resize', onWinResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
    };
  });

  function addSources() {
    ringSource = map.addSource('rings', {
      type: 'geojson',
      data: ringsGeojson,
    });
    stationSource = map.addSource('stations', {
      type: 'geojson',
      data: stationFeatures(stations),
    });

    map.addLayer({
      id: 'rings-fill',
      type: 'fill',
      source: 'rings',
      paint: {
        'fill-color': '#0d9488',
        // Fuzzy edge: 4 concentric bands fading outward. The outer band
        // edge is the station's nominal 60 dBu service contour.
        'fill-opacity': [
          'match',
          ['get', 'band'],
          0,
          0.13,
          1,
          0.09,
          2,
          0.06,
          0.04,
        ],
      },
    });
    map.addLayer({
      id: 'rings-line',
      type: 'line',
      source: 'rings',
      filter: ['==', ['get', 'band'], 3],
      paint: {
        'line-color': '#0d9488',
        'line-width': 1,
        'line-opacity': 0.3,
        'line-dasharray': [2, 2],
      },
    });
    map.addLayer({
      id: 'stations-halo',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-radius': 9,
        'circle-color': '#dc2626',
        'circle-opacity': 0.25,
      },
    });
    map.addLayer({
      id: 'stations-dot',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-radius': 4,
        'circle-color': '#b91c1c',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
      },
    });
    map.addSource('selected-station', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'selected-station-ring',
      type: 'circle',
      source: 'selected-station',
      paint: {
        'circle-radius': 12,
        'circle-color': '#b91c1c',
        'circle-opacity': 0.15,
        'circle-stroke-color': '#b91c1c',
        'circle-stroke-width': 2.5,
      },
    });

    map.on('click', 'stations-dot', (e) => {
      const p = e.features[0].properties;
      const s = stations.find(
        (x) => x.callsign === p.callsign && x.frequency === p.frequency,
      );
      if (s)
        select({
          station: s,
          km: haversineKm(e.lngLat.lat, e.lngLat.lng, s.lat, s.lng),
          point: { lat: e.lngLat.lat, lng: e.lngLat.lng },
        });
    });

    map.on('mouseenter', 'stations-dot', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'stations-dot', () => {
      map.getCanvas().style.cursor = '';
    });
    map.on('click', (e) => {
      const feats = map.queryRenderedFeatures(e.point, { layers: ['stations-dot'] });
      if (feats.length) return;
      if (e.originalEvent.defaultPrevented) return;
      const hit = nearestStation(stations, e.lngLat.lat, e.lngLat.lng);
      if (hit)
        select({ ...hit, point: { lat: e.lngLat.lat, lng: e.lngLat.lng } });
    });
  }

  $effect(() => {
    if (!mapReady || !ringSource) return;
    map.getSource('rings').setData(ringsGeojson);
    map.getSource('stations').setData(stationFeatures(stations));
  });

  $effect(() => {
    if (!mapReady || !ringSource) return;
    const empty = { type: 'FeatureCollection', features: [] };
    const data = selected
      ? {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'Point',
                coordinates: [selected.station.lng, selected.station.lat],
              },
            },
          ],
        }
      : empty;
    map.getSource('selected-station').setData(data);
  });

  function select(hit) {
    selected = hit;
    // The marker stays where the user clicked / is located; the chosen
    // transmitter is highlighted with a ring instead.
    if (
      hit.point &&
      Number.isFinite(hit.point.lat) &&
      Number.isFinite(hit.point.lng)
    ) {
      if (!userMarker) {
        userMarker = new maplibregl.Marker({ color: '#2563eb' })
          .setLngLat([hit.point.lng, hit.point.lat])
          .addTo(map);
      } else {
        userMarker.setLngLat([hit.point.lng, hit.point.lat]);
      }
    }
  }

  let alternatives = $derived.by(() => {
    if (!selected || !selected.point) return [];
    const { lat, lng } = selected.point;
    const chosen = selected.station;
    const ranked = stations
      .map((s) => ({ station: s, km: haversineKm(lat, lng, s.lat, s.lng) }))
      .sort((a, b) => a.km - b.km);
    const out = [];
    const cutoff = Math.max(60, selected.km * 1.5);
    for (const r of ranked) {
      const sameStation =
        r.station.callsign === chosen.callsign &&
        r.station.frequency === chosen.frequency;
      if (sameStation) continue;
      // Skip relays of the same network; they carry identical content.
      if ((r.station.network ?? '') === (chosen.network ?? '')) continue;
      if (r.km > cutoff) break;
      out.push(r);
      if (out.length >= 2) break;
    }
    return out;
  });

  function pickAlternative(a) {
    if (!selected) return;
    select({ station: a.station, km: a.km, point: selected.point });
  }

  /**
   * Map padding so the point of interest is centered in the *visible*
   * area, not behind the card: on narrow screens the card sits on top,
   * on wide screens it sits on the left.
   */
  function mapPadding() {
    const safe = (n) => (Number.isFinite(n) && n > 0 ? n : 0);
    if (!map || !panelEl) return { top: 0, right: 0, bottom: 0, left: 0 };
    const pad = { top: 0, right: 0, bottom: 0, left: 0 };
    if (window.innerWidth <= 640) {
      pad.top = safe(panelEl.offsetHeight + 24);
    } else {
      pad.left = safe(panelEl.offsetWidth + 24);
    }
    return pad;
  }

  function samePadding(a, b) {
    return (
      a.top === b.top && a.left === b.left && a.right === b.right && a.bottom === b.bottom
    );
  }

  /**
   * Apply new padding to the map. Calling setPadding while a flyTo
   * animation is running cancels the flight, so during camera movement
   * we defer the update until the camera is idle.
   */
  function updatePadding() {
    if (!map || !mapReady) return;
    const next = mapPadding();
    if (samePadding(map.getPadding(), next)) return;
    if (map.isMoving()) {
      map.once('moveend', () => {
        const p = mapPadding();
        if (!samePadding(map.getPadding(), p)) map.setPadding(p);
      });
    } else {
      map.setPadding(next);
    }
  }

  function flyTo(lat, lng, zoom = 8.5) {
    // Wait one frame so the card's height reflects any selection change
    // before the padding is measured.
    requestAnimationFrame(() => {
      map.flyTo({ center: [lng, lat], zoom, speed: 1.2, padding: mapPadding() });
    });
  }

  function locate() {
    if (!navigator.geolocation) {
      loadError = 'Geolocation is not supported by this browser.';
      return;
    }
    locating = true;
    loadError = '';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locating = false;
        const { latitude, longitude } = pos.coords;
        const hit = nearestStation(stations, latitude, longitude);
        if (hit) {
          select({ ...hit, point: { lat: latitude, lng: longitude } });
          flyTo(latitude, longitude, 9);
        }
      },
      (err) => {
        locating = false;
        loadError = `Could not get your location: ${err.message}`;
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  let searchTimer;
  function onSearchInput() {
    clearTimeout(searchTimer);
    const q = query.trim();
    if (q.length < 2) {
      searchResults = [];
      return;
    }
    searchTimer = setTimeout(() => doSearch(q), 300);
  }

  async function doSearch(q) {
    searching = true;
    try {
      const url =
        'https://geocoding-api.open-meteo.com/v1/search?name=' +
        encodeURIComponent(q) +
        '&count=5&language=en&format=json&countryCode=US';
      const res = await fetch(url);
      const json = await res.json();
      searchResults = json.results ?? [];
    } catch {
      searchResults = [];
    } finally {
      searching = false;
    }
  }

  function pickResult(r) {
    const hit = nearestStation(stations, r.latitude, r.longitude);
    searchResults = [];
    query = r.name;
    if (hit) {
      select({ ...hit, point: { lat: r.latitude, lng: r.longitude } });
      flyTo(r.latitude, r.longitude, 9);
    }
  }

  function fmtFreq(s) {
    return s.band === 'FM' ? `${s.frequency} FM` : `${s.frequency} AM`;
  }

  function fmtKm(km) {
    if (km == null) return '';
    const mi = km * 0.621371;
    return km < 1
      ? `${Math.round(km * 1000)} m away`
      : `${km.toFixed(0)} km (${mi.toFixed(0)} mi) away`;
  }

  function fmtKmShort(km) {
    const mi = km * 0.621371;
    return `${km.toFixed(0)} km · ${mi.toFixed(0)} mi`;
  }

  /**
   * Deep link to the FCC public inspection file profile, which carries
   * the station's licensed facilities, documents and coverage maps.
   * FM profile URLs use the FCC callsign (sometimes suffixed, e.g.
   * KQED-FM); AM profiles use the plain callsign.
   */
  function detailsUrl(s) {
    if (s.band === 'FM') {
      return `https://publicfiles.fcc.gov/fm-profile/${s.fccCall ?? s.callsign}`;
    }
    return `https://publicfiles.fcc.gov/am-profile/${s.callsign}`;
  }
</script>

<div class="app">
  <div id="map" aria-hidden="true"></div>

  <main class="panel" bind:this={panelEl}>
    <header>
      <h1>Find Your Closest <span class="npr-news">NPR&nbsp;News</span> Station</h1>
      <p class="subtitle">
        {stations.length ? stations.length : '…'} NPR News member stations ·
        click the map or use your location
      </p>
    </header>

    <div class="controls">
      <div class="search" role="search">
        <label class="sr-only" for="search-input">Search a US city or ZIP code</label>
        <input
          id="search-input"
          type="text"
          placeholder="Search a US city or ZIP…"
          bind:value={query}
          oninput={onSearchInput}
          autocomplete="off"
        />
        {#if searchResults.length}
          <ul class="results">
            {#each searchResults as r (r.id)}
              <li>
                <button type="button" onclick={() => pickResult(r)}>
                  {r.name}<span class="muted">
                    {r.admin1 ? `, ${r.admin1}` : ''}</span
                  >
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <button class="primary" onclick={locate} disabled={locating}>
        {locating ? 'Locating…' : '📍 Use my location'}
      </button>

    </div>

    {#if loadError}
      <p class="error">{loadError}</p>
    {/if}

    {#if selected}
      {@const outOfRange = selected.km != null && selected.station.rangeKm && selected.km > selected.station.rangeKm * 2}
      <div class="station-card" class:out-of-range={outOfRange}>
        <div class="station-header">
          <div class="callsign">{selected.station.callsign}</div>
          <div class="freq">{fmtFreq(selected.station)}</div>
        </div>
        {#if selected.station.network && selected.station.network !== selected.station.callsign}
          <div class="network">{selected.station.network}</div>
        {/if}
        <div class="place">
          {selected.station.city}, {selected.station.state}
        </div>
        {#if selected.km != null}
          <div class="dist">
            {fmtKm(selected.km)}
            {#if outOfRange}
              <span class="warn"> · probably not receivable</span>
            {/if}
          </div>
        {/if}
        {#if selected.station.rangeKm}
          <div class="contour">
            ~{selected.station.rangeKm} km service range
            {#if selected.station.fccClass}· FCC class {selected.station.fccClass}{/if}
          </div>
        {/if}
        <div class="links">
          <a
            href={detailsUrl(selected.station)}
            target="_blank"
            rel="noreferrer">FCC station profile ↗</a
          >
        </div>
      </div>

      {#if alternatives.length}
        <div class="alts">
          <div class="alts-title">Also potentially receivable:</div>
          {#each alternatives as a (a.station.callsign + a.station.frequency)}
            <button
              type="button"
              class="alt"
              onclick={() => pickAlternative(a)}
            >
              <span class="alt-call">
                {a.station.callsign} · {fmtFreq(a.station)}
              </span>
              <span class="alt-km">{fmtKmShort(a.km)}</span>
            </button>
          {/each}
        </div>
      {/if}
    {:else if stations.length && mapReady}
      <p class="hint">
        Click anywhere on the map to find the NPR News station nearest to
        you. (music-only stations excluded)
      </p>
    {/if}

    <footer>
      <p class="coverage-note">
        Coverage data may not be accurate. This <a
          href="https://github.com/nick123pig/nprmap"
          target="_blank"
          rel="noreferrer"
        >open source project</a> is not affiliated with, endorsed by, or sponsored by NPR.
      </p>
    </footer>
  </main>
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    font-family:
      system-ui,
      -apple-system,
      'Segoe UI',
      Roboto,
      sans-serif;
  }
  :global(#app) {
    height: 100%;
  }

  .app {
    position: relative;
    height: 100%;
  }
  #map {
    position: absolute;
    inset: 0;
  }

  .panel {
    position: absolute;
    top: 12px;
    left: 12px;
    z-index: 10;
    width: 320px;
    max-height: calc(100% - 24px);
    overflow-y: auto;
    background: rgba(255, 255, 255, 0.96);
    backdrop-filter: blur(6px);
    border-radius: 14px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
    padding: 16px;
    box-sizing: border-box;
    color: #1c1917;
  }

  h1 {
    margin: 0 0 2px;
    font-size: 1.15rem;
    line-height: 1.25;
  }
  .npr-news {
    color: #b91c1c;
  }
  .subtitle {
    margin: 0 0 12px;
    font-size: 0.8rem;
    color: #57534e;
  }

  .controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .search {
    position: relative;
  }
  input[type='text'] {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 10px;
    border: 1px solid #d6d3d1;
    border-radius: 8px;
    font-size: 0.9rem;
  }
  input[type='text']:focus {
    outline: 2px solid #0d9488;
    border-color: transparent;
  }
  .results {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin: 4px 0 0;
    padding: 4px;
    list-style: none;
    background: #fff;
    border: 1px solid #e7e5e4;
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
    z-index: 20;
  }
  .results button {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 7px 8px;
    border-radius: 6px;
    font-size: 0.88rem;
    cursor: pointer;
  }
  .results button:hover {
    background: #f0fdfa;
  }
  .muted {
    color: #78716c;
  }

  button.primary {
    padding: 9px 12px;
    border: none;
    border-radius: 8px;
    background: #0d9488;
    color: #fff;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  button.primary:hover {
    background: #0f766e;
  }
  button.primary:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  .error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #b91c1c;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 0.82rem;
  }

  .station-card {
    margin-top: 12px;
    padding: 12px;
    border: 1px solid #ccfbf1;
    background: #f0fdfa;
    border-radius: 10px;
  }
  .station-card.out-of-range {
    border-color: #fca5a5;
    background: #fef2f2;
  }
  .station-card.out-of-range .callsign,
  .station-card.out-of-range .freq {
    color: #b91c1c;
  }
  .station-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .callsign, .freq {
    font-size: 1.25rem;
    font-weight: 800;
    line-height: 1.1;
  }
  .freq {
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #0d9488;
  }

  .alts {
    margin-top: 10px;
    border: 1px solid #e7e5e4;
    border-radius: 10px;
    padding: 10px;
  }
  .alts-title {
    font-size: 0.75rem;
    font-weight: 700;
    color: #57534e;
    margin-bottom: 6px;
  }
  .alt {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
  }
  .alt:hover {
    background: #f0fdfa;
  }
  .alt-call {
    font-size: 0.85rem;
    font-weight: 600;
    color: #1c1917;
  }
  .alt-km {
    font-size: 0.75rem;
    color: #78716c;
    white-space: nowrap;
  }
  .network {
    font-size: 0.78rem;
    color: #57534e;
    font-weight: 600;
  }
  .place {
    color: #44403c;
    font-size: 0.9rem;
  }
  .dist {
    margin-top: 4px;
    font-size: 0.85rem;
    color: #0f766e;
    font-weight: 600;
  }
  .station-card.out-of-range .dist {
    color: #b91c1c;
  }
  .warn {
    font-weight: 700;
  }
  .contour {
    margin-top: 2px;
    font-size: 0.75rem;
    color: #78716c;
  }
  .hint {
    font-size: 0.75rem;
    color: #78716c;
    margin: 8px 0 0;
  }
  .links {
    margin-top: 8px;
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .links a {
    font-size: 0.8rem;
    color: #0f766e;
    font-weight: 600;
  }

  footer {
    margin-top: 14px;
    font-size: 0.68rem;
    line-height: 1.5;
    color: #a8a29e;
  }
  footer p {
    margin: 0 0 6px;
  }
  footer p:last-child {
    margin-bottom: 0;
  }
  footer a {
    color: #78716c;
  }

  @media (max-width: 640px) {
    .subtitle {
      display: none;
    }

    /* With a station card open, the map area is tight: drop the
       coverage-explanation footnote to save vertical space. */
    .panel:has(.station-card) footer .coverage-note {
      display: none;
    }

    .panel {
      width: calc(100% - 24px);
      max-height: 55%;
    }
  }
</style>
