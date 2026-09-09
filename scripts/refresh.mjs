#!/usr/bin/env node
/**
 * NPR News Station Map: manual data-refresh stage.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Data sources: NPR member directory (organization.api.npr.org),
 * FCC FM Query (transition.fcc.gov), Open-Meteo geocoding API.
 *
 * Builds the "NPR news stations" dataset from NPR's own live directory
 * (organization.api.npr.org, the service behind npr.org/stations):
 *
 * 1. Discovery: a converging fixed-point crawl. Seeds = US state names +
 *    codes + territories. Every result's callsign, relay (tier2) callsigns
 *    and market city are fed back as new queries until nothing new shows
 *    up. Raw responses are cached in data/npr-directory-cache.json.
 * 2. Cross-check: callsigns from data/npr_station_list.csv are looked up
 *    too; anything not in NPR's live directory is dropped with a log
 *    (e.g. KEXP, WWOZ, music/community stations that are not NPR news members).
 * 3. Classification: stations are kept unless marked music-only:
 *    - NPR's eligibility.musicOnly flag
 *    - "Classical"/"Jazz" etc. in the station or stream name
 *    - data/news-format.json overrides { "CALL": "music" | "news" }
 * 4. Geocoding: market city/state via the free Open-Meteo geocoding API,
 *    cached in data/geocode-cache.json (hand-edit to fix misses).
 * 5. Writes public/data/stations.json for the static app.
 *
 * Usage:  npm run refresh
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CSV_PATH = path.join(root, 'data', 'npr_station_list.csv');
const DIRECTORY_CACHE_PATH = path.join(root, 'data', 'npr-directory-cache.json');
const GEO_CACHE_PATH = path.join(root, 'data', 'geocode-cache.json');
const FCC_CACHE_PATH = path.join(root, 'data', 'fcc-cache.json');
const OVERRIDES_PATH = path.join(root, 'data', 'overrides.json');
const NEWS_FORMAT_PATH = path.join(root, 'data', 'news-format.json');
const OUT_PATH = path.join(root, 'public', 'data', 'stations.json');

const API = 'https://organization.api.npr.org/v3/stations?q=';
const FCC_API = 'https://transition.fcc.gov/fcc-bin/fmq?call=';
const DELAY_MS = 200;

// Rough broadcast-range estimates in km for the coverage rings.
const RANGE_KM = { FM: 50, AM: 40 };

// Music keywords in station/network/stream names.
const MUSIC_RE =
  /\b(classical|jazz|blues|folk|bluegrass|opera|symphony|kbach|aaa music)\b/i;
const NEWS_RE = /\b(news|talk|information)\b/i;

const STATE_NAMES = [
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut',
  'Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa',
  'Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan',
  'Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire',
  'New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio',
  'Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota',
  'Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia',
  'Wisconsin','Wyoming',
];
const SEED_QUERIES = [
  ...STATE_NAMES,
  'District of Columbia',
  'Puerto Rico',
  'Virgin Islands',
  'Guam',
  'Mariana',
  'American Samoa',
  // 2-letter codes: the search indexes some stations by code only
  ...STATE_NAMES.map((s) => null).filter(Boolean),
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR','VI','GU','MP','AS',
];

const STATE_TO_NAME = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
  IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
  ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',
  NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',
  NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',
  PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',
  TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
  DC:'District of Columbia',
};
const TERRITORIES = {
  PR: ['Puerto Rico'],
  VI: ['U.S. Virgin Islands', 'United States Virgin Islands'],
  GU: ['Guam'],
  MP: ['Northern Mariana Islands'],
  AS: ['American Samoa'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isCall = (s) => /^[KW][A-Z]{3}(-FM|-AM)?$/.test(s);
const stripCall = (s) => s.replace(/-(FM|AM)$/, '');

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'npr-station-map/1.0 (manual data refresh)' },
      });
      if (res.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      await sleep(1000);
    }
  }
  return null;
}

/* ---------------- phase 1: NPR directory discovery ---------------- */

async function discoverDirectory() {
  const cache = existsSync(DIRECTORY_CACHE_PATH)
    ? JSON.parse(readFileSync(DIRECTORY_CACHE_PATH, 'utf8'))
    : { queries: {}, items: {} };

  const queue = SEED_QUERIES.filter((q) => !(q in cache.queries));
  const seenCalls = new Set();

  const recordItem = (item, query) => {
    const a = item.attributes;
    if (!a || !a.brand) return;
    const orgId = a.orgId;
    const prev = cache.items[orgId];
    const enriched = { ...a, foundVia: prev?.foundVia ?? query };
    // Prefer entries that carry tier2 relay info (call-sign queries).
    const prevRelays = relayCalls(prev);
    const newRelays = relayCalls(enriched);
    cache.items[orgId] =
      newRelays.length >= prevRelays.length ? enriched : { ...enriched, tier2: prev?.network?.tier1?.tier2 ?? enriched.network?.tier1?.tier2 ?? null };
  };

  const relayCalls = (item) => {
    const tier2 = item?.network?.tier1?.tier2;
    if (!Array.isArray(tier2)) return [];
    return tier2.map((t) => t.name).filter(isCall).map(stripCall);
  };

  while (queue.length) {
    const query = queue.shift();
    cache.queries[query] = true;
    process.stdout.write(`\rq="${query}" (${queue.length} queued, ${Object.keys(cache.items).length} stations)   `);
    const doc = await fetchJson(API + encodeURIComponent(query));
    const items = doc?.items ?? [];
    for (const item of items) {
      recordItem(item, query);
      const a = item.attributes;
      if (!a?.brand) continue;
      const call = a.brand.call;
      if (!seenCalls.has(call)) {
        seenCalls.add(call);
        // Relay services are only returned by call/city queries, so
        // re-query the callsign to pick up its tier2 list.
        if (!(call in cache.queries)) queue.push(call);
      }
      for (const relay of relayCalls(a)) {
        if (!(relay in cache.queries) && !seenCalls.has(relay)) {
          seenCalls.add(relay);
          queue.push(relay);
        }
      }
      const city = a.brand.marketCity;
      const state = a.brand.marketState;
      if (city && state && !seenCalls.has(`${city}|${state}`)) {
        seenCalls.add(`${city}|${state}`);
        // City queries surface stations the state query misses.
        if (!(city in cache.queries) && city.length >= 4) queue.push(city);
      }
    }
    // Persist incrementally so an interrupted run resumes.
    writeFileSync(DIRECTORY_CACHE_PATH, JSON.stringify(cache));
    await sleep(DELAY_MS);
  }
  process.stdout.write('\n');
  const items = Object.values(cache.items);
  console.log(`Discovered ${items.length} NPR directory entries`);
  return { cache, items };
}

/* ---------------- phase 2: CSV cross-check ---------------- */

function readCsvCalls() {
  try {
    return readFileSync(CSV_PATH, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(','))
      .filter((p) => p.length === 5)
      .map((p) => ({ call: p[1].trim().toUpperCase(), band: p[2].trim().toUpperCase() }));
  } catch {
    return [];
  }
}

/* ---------------- phase 4: geocoding ---------------- */

function nameVariants(city) {
  const raw = city.trim();
  const candidates = new Set([raw]);
  for (const part of raw.split(/\s*[/,]\s*/)) if (part) candidates.add(part);
  for (const c of [...candidates]) {
    candidates.add(c.replace(/\bMt\.?\s*/gi, 'Mount '));
    candidates.add(c.replace(/\bSt\.?\s*/gi, 'Saint '));
    candidates.add(c.replace(/\bFt\.?\s*/gi, 'Fort '));
    candidates.add(c.replace(/\./g, ''));
    candidates.add(c.replace(/-/g, ' '));
  }
  return [...candidates].map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function geocode(city, stateCode) {
  const stateName = STATE_TO_NAME[stateCode];
  const territoryNames = TERRITORIES[stateCode];

  for (const name of nameVariants(city)) {
    const attempts = [
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=25&language=en&format=json&countryCode=US`,
    ];
    if (territoryNames) {
      attempts.push(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=25&language=en&format=json`,
      );
    }
    for (const url of attempts) {
      const json = await fetchJson(url);
      for (const r of json?.results ?? []) {
        const admin1 = (r.admin1 ?? '').toLowerCase();
        const country = (r.country ?? '').toLowerCase();
        const match =
          (stateName && admin1 === stateName.toLowerCase()) ||
          (territoryNames &&
            territoryNames.some((t) => t.toLowerCase() === country));
        if (match && Number.isFinite(r.latitude)) {
          return { lat: r.latitude, lng: r.longitude, matched: r.name };
        }
      }
    }
    await sleep(150);
  }
  return null;
}

/* ---------------- main ---------------- */

/* ---------------- phase 4.5: FCC licensed coverage ---------------- */

// FCC FM station classes (47 CFR 73.211/73.205): reference ERP (kW),
// reference HAAT (m) and the maximum licensed 60 dBu F(50,50) contour
// distance (km) for the class. Real stations may operate below the
// reference values (smaller contour) or be grandfathered above (capped
// at 1.3x the class maximum).
const FCC_CLASS = {
  A: { erp: 6, haat: 100, d: 28 },
  B1: { erp: 25, haat: 100, d: 39 },
  B: { erp: 50, haat: 150, d: 72 },
  C3: { erp: 25, haat: 100, d: 39 },
  C2: { erp: 50, haat: 150, d: 52 },
  C1: { erp: 100, haat: 299, d: 72 },
  C0: { erp: 100, haat: 449, d: 82 },
  C: { erp: 100, haat: 599, d: 92 },
  D: { erp: 0.01, haat: 100, d: 12 },
};
const DEFAULT_RANGE_KM = { FM: 50, AM: 40 };

/**
 * Parse the FCC FM Query page. The page embeds per-record JS variable
 * assignments (c_callsign, c_service, c_station_class, p_erp_max, ...),
 * which is more robust than scraping the rendered table.
 */
function parseFmQuery(html) {
  const records = [];
  let cur = null;
  const re =
    /(c_callsign|c_service|c_station_class|c_dom_status|freq|p_erp_max|p_haat_max|c_comm_city_app|c_comm_state_app)\s*=\s*'([^']*)'/g;
  for (const m of html.matchAll(re)) {
    const [ , key, value ] = m;
    if (key === 'c_callsign') {
      cur = { call: value.trim() };
      records.push(cur);
    } else if (cur) {
      cur[key] = value.trim();
    }
  }
  return records
    .filter((r) => r.freq && r.p_erp_max)
    .map((r) => ({
      call: r.call,
      fccClass: r.c_station_class ?? '',
      service: r.c_service,
      frequency: parseFloat(r.freq),
      status: r.c_dom_status,
      city: r.c_comm_city_app ?? '',
      state: r.c_comm_state_app ?? '',
      erpKw: parseFloat(r.p_erp_max),
      haatM: parseFloat(r.p_haat_max),
    }))
    .filter((r) => Number.isFinite(r.erpKw) && Number.isFinite(r.haatM));
}

async function fetchFccData(calls) {
  const cache = existsSync(FCC_CACHE_PATH)
    ? JSON.parse(readFileSync(FCC_CACHE_PATH, 'utf8'))
    : {};
  let fetched = 0;
  for (const call of calls) {
    if (call in cache) continue;
    process.stdout.write(`\rfcc: ${call} (${Object.keys(cache).length} cached)   `);
    try {
      const res = await fetch(FCC_API + encodeURIComponent(call), {
        headers: {
          'User-Agent': 'npr-station-map/1.0 (manual data refresh)',
          Accept: 'text/html',
        },
      });
      const html = res.ok ? await res.text() : '';
      const base = call.replace(/-FM\d*$/i, '');
      const rows = parseFmQuery(html).filter(
        (r) =>
          r.service === 'FM' &&
          r.status === 'LIC' &&
          (r.call === call || r.call.replace(/-FM\d*$/i, '') === base) &&
          Number.isFinite(r.erpKw),
      );
      // The main transmitter = the licensed full-service entry with the
      // largest ERP (boosters/translators/CP applications are ignored).
      rows.sort((a, b) => b.erpKw - a.erpKw);
      cache[call] = rows[0] ?? null;
    } catch {
      cache[call] = null;
    }
    writeFileSync(FCC_CACHE_PATH, JSON.stringify(cache));
    await sleep(DELAY_MS);
  }
  process.stdout.write('\n');
  return cache;
}

/**
 * Estimate the 60 dBu F(50,50) service contour from the licensed ERP,
 * HAAT and station class. Anchored on each class's reference ERP/HAAT
 * (which map to its maximum licensed contour distance), scaled by the
 * station's actual ERP/HAAT, clamped to [0.35x, 1.3x] the class max
 * (1.3x accommodates grandfathered super-power stations like KQED).
 * This is an approximation: real contours depend on terrain.
 */
function estimateContourKm(row) {
  if (!row) return null;
  const cls = FCC_CLASS[row.fccClass] ?? FCC_CLASS.A;
  const erpRatio = Math.max(row.erpKw, 0.001) / cls.erp;
  const haat = Math.max(row.haatM || 0, 20);
  const haatRatio = haat / cls.haat;
  const factor = Math.pow(erpRatio, 0.4) * Math.pow(haatRatio, 0.4);
  return Math.round(cls.d * Math.min(1.3, Math.max(0.35, factor)));
}

async function main() {
  const { items } = await discoverDirectory();

  const byCall = new Map();
  for (const item of items) {
    const call = item.brand?.call;
    if (call && !byCall.has(call)) byCall.set(call, item);
  }

  // CSV callsigns not discovered yet (station may have left NPR).
  const csvCalls = readCsvCalls();
  const missingFromDirectory = [];
  for (const { call, band } of csvCalls) {
    if (byCall.has(call)) continue;
    if (!(call in (JSON.parse(readFileSync(DIRECTORY_CACHE_PATH, 'utf8')).queries))) {
      const doc = await fetchJson(API + encodeURIComponent(call));
      for (const item of doc?.items ?? []) {
        const a = item.attributes;
        if (a?.brand?.call) {
          const orgId = a.orgId;
          const cache = JSON.parse(readFileSync(DIRECTORY_CACHE_PATH, 'utf8'));
          cache.items[orgId] = { ...a, foundVia: `csv:${call}` };
          cache.queries[call] = true;
          writeFileSync(DIRECTORY_CACHE_PATH, JSON.stringify(cache));
        }
      }
    }
    const cache = JSON.parse(readFileSync(DIRECTORY_CACHE_PATH, 'utf8'));
    const found = Object.values(cache.items).some((i) => i.brand?.call === call);
    if (!found) missingFromDirectory.push(call);
  }
  if (missingFromDirectory.length) {
    console.log(`\n${missingFromDirectory.length} CSV stations not in NPR's live directory (dropped):`);
    console.log('  ' + [...new Set(missingFromDirectory)].sort().join(', '));
  }

  // Reload final directory state.
  const cache = JSON.parse(readFileSync(DIRECTORY_CACHE_PATH, 'utf8'));
  const all = Object.values(cache.items);
  const finalByCall = new Map();
  for (const item of all) {
    const call = item.brand?.call;
    if (call && !finalByCall.has(call)) finalByCall.set(call, item);
  }

  // ---- classification ----
  let newsFormat = {};
  if (existsSync(NEWS_FORMAT_PATH)) {
    newsFormat = JSON.parse(readFileSync(NEWS_FORMAT_PATH, 'utf8'));
  }

  const stations = [];
  const musicStations = [];
  const unknownStations = [];
  const byKey = new Map(); // call|band|frequency dedupe
  for (const item of all) {
    const b = item.brand;
    if (!b?.call || !Number.isFinite(Number(b.frequency))) continue;
    const call = b.call;

    const names = [b.name, item.network?.name, ...((item.streamsV2 ?? []).map((s) => s.title ?? ''))]
      .filter(Boolean);
    const primary = [b.name, item.network?.name, (item.streamsV2 ?? [])[0]?.title]
      .filter(Boolean);
    // News keyword anywhere wins (subchannel streams like "Classical
    // KWMU-3" are just subchannels of a news network). Music-only is
    // judged on the primary identity: brand, network and MAIN stream
    // ("KBACH Classical 89.5 FM", "Jazz 91.9 WCLK", "CPR Classical").
    const hasNews = names.some((n) => NEWS_RE.test(n));
    const primaryMusic = primary.some((n) => MUSIC_RE.test(n));
    let unknown = !hasNews && !primaryMusic;
    let music = primaryMusic && !hasNews;
    if (item.eligibility?.musicOnly === true && unknown) music = true;

    const override = newsFormat[call];
    if (override === 'music') music = true;
    else if (override === 'news') music = false;

    if (music) {
      musicStations.push(`${call} (${b.frequency} ${b.band}, ${b.marketCity} ${b.marketState})`);
      continue;
    }
    if (b.band !== 'FM' && b.band !== 'AM') continue;
    if (unknown && !override) {
      unknownStations.push(
        `${call} (${b.frequency} ${b.band}, ${b.marketCity} ${b.marketState}) | ${b.name}`,
      );
    }

    const key = `${call}|${b.band}|${b.frequency}`;
    const prev = byKey.get(key);
    if (prev && !override) continue; // duplicate org for the same frequency
    byKey.set(key, true);

    stations.push({
      callsign: call,
      band: b.band,
      frequency: Number(b.frequency),
      city: b.marketCity,
      state: b.marketState,
      network: item.network?.name || b.name || call,
      foundVia: item.foundVia,
    });
  }
  if (musicStations.length) {
    console.log(`\n${musicStations.length} music-only stations (dropped):`);
    console.log('  ' + musicStations.join('\n  '));
  }
  if (unknownStations.length) {
    console.log(`\n${unknownStations.length} stations with no format signal (kept; review in ${path.relative(root, NEWS_FORMAT_PATH)}):`);
    console.log('  ' + unknownStations.join('\n  '));
  }

  // ---- FCC licensed coverage (ERP / HAAT / class) ----
  const fmCalls = [
    ...new Set(stations.filter((s) => s.band === 'FM').map((s) => s.callsign)),
  ];
  const fcc = await fetchFccData(fmCalls);
  let fccMatched = 0;
  for (const s of stations) {
    const row = s.band === 'FM' ? fcc[s.callsign] : null;
    const est = estimateContourKm(row);
    if (est != null) {
      s.rangeKm = est;
      s.erpKw = row.erpKw;
      s.haatM = row.haatM;
      s.fccClass = row.fccClass;
      // FCC-registered callsign (may carry an -FM suffix, e.g. KQED-FM);
      // needed for deep links to the FCC public file profile.
      s.fccCall = row.call;
      fccMatched++;
    } else {
      s.rangeKm = s.rangeKm ?? DEFAULT_RANGE_KM[s.band];
    }
  }
  console.log(
    `FCC contour estimates: ${fccMatched}/${stations.length} FM stations matched to licensed data`,
  );

  // ---- geocoding ----
  const geoCache = existsSync(GEO_CACHE_PATH)
    ? JSON.parse(readFileSync(GEO_CACHE_PATH, 'utf8'))
    : {};
  const uniquePlaces = [
    ...new Map(stations.map((s) => [`${s.city}|${s.state}`, s])).values(),
  ];
  let newlyGeocoded = 0;
  for (const { city, state } of uniquePlaces) {
    const key = `${city}|${state}`.toLowerCase();
    if (key in geoCache) continue;
    const result = await geocode(city, state);
    geoCache[key] = result;
    newlyGeocoded++;
    if (result) {
      console.log(`  + ${city}, ${state} -> ${result.lat.toFixed(3)}, ${result.lng.toFixed(3)}`);
    } else {
      console.warn(`  ? ${city}, ${state} NOT FOUND (patch ${path.relative(root, GEO_CACHE_PATH)})`);
    }
    await sleep(150);
  }
  if (newlyGeocoded === 0) console.log('All locations resolved from cache');

  let overrides = {};
  if (existsSync(OVERRIDES_PATH)) {
    overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
  }

  const output = [];
  const missingGeo = [];
  for (const s of stations) {
    const loc = geoCache[`${s.city}|${s.state}`.toLowerCase()];
    if (!loc) {
      missingGeo.push(`${s.callsign} (${s.city}, ${s.state})`);
      continue;
    }
    output.push({
      ...s,
      lat: loc.lat,
      lng: loc.lng,
      rangeKm: overrides[`${s.callsign} ${s.frequency}`] ?? s.rangeKm,
    });
  }

  output.sort((a, b) =>
    a.state === b.state ? a.callsign.localeCompare(b.callsign) : a.state.localeCompare(b.state),
  );

  writeFileSync(GEO_CACHE_PATH, JSON.stringify(geoCache, null, 2) + '\n');
  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "NPR live station directory (organization.api.npr.org), cross-checked with data/npr_station_list.csv; geocoded via Open-Meteo",
        stations: output,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(`\nWrote ${output.length} NPR news stations to ${path.relative(root, OUT_PATH)}`);
  if (missingGeo.length) {
    console.warn(`\n${missingGeo.length} stations skipped (no coordinates): ${missingGeo.join(', ')}`);
    console.warn(`Patch them in ${path.relative(root, GEO_CACHE_PATH)} and re-run.`);
    process.exitCode = 1;
  }
}

main();
