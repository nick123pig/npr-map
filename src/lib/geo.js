// SPDX-License-Identifier: GPL-3.0-or-later
/** Geo helpers shared by the app. */

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Rough geodesic circle as a GeoJSON Polygon (good enough for display). */
export function ringPolygon(lng, lat, km, segments = 64) {
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.32 * Math.cos((lat * Math.PI) / 180) || 0.001;
  const coords = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    coords.push([
      lng + (km * Math.cos(a)) / kmPerDegLng,
      lat + (km * Math.sin(a)) / kmPerDegLat,
    ]);
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [coords] },
  };
}

/**
 * Coverage "fuzz" bands. Real service contours fade out gradually
 * (terrain, receiver quality), so instead of one hard-edged ring we
 * render 4 concentric bands whose fill opacity fades outward. The
 * outermost band edge is the nominal contour distance.
 */
const BANDS = [
  { radiusFactor: 0.55, opacity: 0.14 },
  { radiusFactor: 0.7, opacity: 0.1 },
  { radiusFactor: 0.85, opacity: 0.07 },
  { radiusFactor: 1.0, opacity: 0.05 },
];

/** GeoJSON FeatureCollection of fuzz bands for the stations array. */
export function ringBands(stations) {
  const features = [];
  for (const s of stations) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng) || !Number.isFinite(s.rangeKm)) {
      continue; // never hand NaN/null coordinates to the map
    }
    BANDS.forEach((band, i) => {
      const ring = ringPolygon(s.lng, s.lat, s.rangeKm * band.radiusFactor);
      ring.properties = { band: i, callsign: s.callsign };
      features.push(ring);
    });
  }
  return { type: 'FeatureCollection', features };
}

/** GeoJSON FeatureCollection of points for the stations array. */
export function stationFeatures(stations) {
  return {
    type: 'FeatureCollection',
    features: stations
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
      .map((s) => ({
        type: 'Feature',
        properties: {
          callsign: s.callsign,
          frequency: s.frequency,
          band: s.band,
          city: s.city,
          state: s.state,
        },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
  };
}

export function nearestStation(stations, lat, lng) {
  let best = null;
  let bestKm = Infinity;
  for (const s of stations) {
    const km = haversineKm(lat, lng, s.lat, s.lng);
    if (km < bestKm) {
      bestKm = km;
      best = s;
    }
  }
  return best ? { station: best, km: bestKm } : null;
}
