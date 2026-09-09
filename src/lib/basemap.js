// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Basemap style loading.
 *
 * OpenFreeMap's "Liberty" style has a quirk: some boundary layers filter
 * with `[">=", ["get", "admin_level"], 3]`, and OpenMapTiles data contains
 * boundary features whose `admin_level` is null. Evaluating a comparison
 * against null throws a type error inside MapLibre's worker, which logs
 * "Expected value to be of type number, but found null instead" on every
 * first load of a boundary tile.
 *
 * `loadSanitizedStyle()` fetches the style JSON and wraps `get` operands
 * of comparison expressions in `coalesce`, defaulting null to the other
 * side's literal value. The visual result is identical (null admin_level
 * features were never drawn by these filters anyway), but the console
 * noise disappears.
 */

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const isGet = (node) =>
  Array.isArray(node) && node[0] === 'get' && node.length === 2;

/** Guard a comparison expression's `get` operand against null. */
function guardComparison(node) {
  if (
    Array.isArray(node) &&
    ['>', '>=', '<', '<='].includes(node[0]) &&
    node.length === 3
  ) {
    const [op, a, b] = node;
    let left = a;
    let right = b;
    if (isGet(a) && typeof b === 'number') left = ['coalesce', a, b];
    if (isGet(b) && typeof a === 'number') right = ['coalesce', b, a];
    return [op, left, right];
  }
  if (Array.isArray(node)) return node.map(guardComparison);
  return node;
}

function sanitizeStyle(style) {
  for (const layer of style.layers ?? []) {
    if (layer.filter) layer.filter = guardComparison(layer.filter);
    for (const section of ['paint', 'layout']) {
      const props = layer[section];
      if (!props) continue;
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (Array.isArray(value)) props[key] = guardComparison(value);
      }
    }
  }
  return style;
}

/**
 * Serve fallback icons for dynamic shield names the sprite atlas is
 * missing. The Liberty style builds icon names like
 * "us-interstate_" + ref_length, but the atlas only ships
 * us-interstate_1..3 and road_1..6, so requests for e.g.
 * "us-interstate_4" log a missing-image error. On
 * `styleimagemissing` we copy the closest existing atlas entry under
 * the requested name (e.g. us-interstate_1), which renders a sensible
 * shield and silences the error.
 */
export async function installSpriteFallback(map, style) {
  const spriteUrl = Array.isArray(style.sprite)
    ? style.sprite[0]?.url
    : style.sprite;
  if (!spriteUrl) return;

  let atlas = null;
  const load = async () => {
    if (atlas) return atlas;
    try {
      const [index, image] = await Promise.all([
        fetch(`${spriteUrl}.json`).then((r) => r.json()),
        new Promise((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = `${spriteUrl}.png`;
        }),
      ]);
      atlas = { index, image };
    } catch {
      atlas = { index: {}, image: null };
    }
    return atlas;
  };
  // Preload immediately so the styleimagemissing handler below can
  // register fallback icons synchronously (an async addImage would be
  // too late and MapLibre would still log the missing-image error).
  load();

  const fallbackName = (name, index) => {
    const base = name.replace(/\d+$/, '');
    const candidates = [
      base.replace(/_$/, '_1'),
      base.replace(/_$/, ''),
      base + '_1',
      base,
    ];
    for (const c of candidates) {
      if (c !== name && index[c]) return c;
    }
    return null;
  };

  const requested = new Set();
  map.on('styleimagemissing', (e) => {
    const name = e.id;
    if (requested.has(name) || map.hasImage(name)) return;
    requested.add(name);
    const { index, image } = atlas ?? { index: {}, image: null };
    const source = image ? fallbackName(name, index) : null;

    if (source) {
      // Copy the closest existing atlas entry under the missing name.
      const meta = index[source];
      const canvas = document.createElement('canvas');
      canvas.width = meta.width;
      canvas.height = meta.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, meta.x, meta.y, meta.width, meta.height, 0, 0, meta.width, meta.height);
      map.addImage(name, ctx.getImageData(0, 0, meta.width, meta.height), {
        pixelRatio: meta.pixelRatio ?? 1,
      });
    } else {
      // The atlas has nothing resembling the requested icon (e.g. POI
      // icons like "office", "atm"). Register a fully transparent
      // placeholder so MapLibre stops logging missing-image errors;
      // the affected features simply render without an icon.
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      map.addImage(name, canvas.getContext('2d').createImageData(1, 1));
    }
  });
}

export async function loadSanitizedStyle() {
  try {
    const res = await fetch(STYLE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return sanitizeStyle(await res.json());
  } catch (e) {
    console.error(
      `Could not load basemap style, falling back to raw URL (${e.message}).`,
    );
    return STYLE_URL; // MapLibre will fetch it itself, warning included
  }
}
