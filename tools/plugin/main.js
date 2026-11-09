/*
 * OSM Map Background - PebbleOS plugin (source: location/map, one instance per preset).
 * Draws a north-up OpenStreetMap-based map of where you are as a watch-ready image.
 *
 * Bundled with the vendored PNG decoder into src/plugin/index.js by tools/build-plugin.js.
 * Plugin scripts are evaluated as plain scripts by the phone app: no import/export here.
 * Globals provided by the host: Pebble, fetch, localStorage, navigator.geolocation, atob/btoa.
 */
'use strict';

var UPNG = require('upng-js');

// ---------------------------------------------------------------- shared helpers
function makeLog() {
  var lines = [];
  var t0 = Date.now();
  function log(message) {
    lines.push(((Date.now() - t0) / 1000).toFixed(1) + 's ' + message);
    try { console.log('APOD: ' + message); } catch (e) { /* ignore */ }
  }
  log.lines = lines;
  return log;
}

function errText(e) {
  return (e && e.message) ? String(e.message) : String(e);
}

function storeGet(key) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function storeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

function storeRemove(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

function clampInt(v, lo, hi, fallback) {
  var n = Math.round(Number(v));
  if (!isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------- palette, dithering, packing
function gcolor(r2, g2, b2) { return 0xC0 | (r2 << 4) | (g2 << 2) | b2; }

var GRAY_PALETTE = [gcolor(0, 0, 0), gcolor(1, 1, 1), gcolor(2, 2, 2), gcolor(3, 3, 3)];

function colorOf(byte) {
  return [((byte >> 4) & 3) * 85, ((byte >> 2) & 3) * 85, (byte & 3) * 85];
}

function dist(r1, g1, b1, r2, g2, b2) {
  var dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return 3 * dr * dr + 6 * dg * dg + db * db;
}

/** Greedily pick the n colours (out of the watch's 64) that best represent the image. */
function choosePalette(rgb, n) {
  var counts = new Float64Array(4096), sr = new Float64Array(4096), sg = new Float64Array(4096), sb = new Float64Array(4096);
  var i;
  for (i = 0; i < rgb.length; i += 3) {
    var k = ((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4);
    counts[k]++; sr[k] += rgb[i]; sg[k] += rgb[i + 1]; sb[k] += rgb[i + 2];
  }
  var bins = [];
  for (i = 0; i < 4096; i++) if (counts[i] > 0) bins.push({ w: counts[i], r: sr[i] / counts[i], g: sg[i] / counts[i], b: sb[i] / counts[i] });
  var cands = [];
  for (var c = 0; c < 64; c++) {
    var byte = gcolor(c >> 4, (c >> 2) & 3, c & 3);
    var col = colorOf(byte);
    cands.push({ byte: byte, r: col[0], g: col[1], b: col[2], used: false });
  }
  var best = new Float64Array(bins.length);
  for (i = 0; i < best.length; i++) best[i] = Infinity;
  var palette = [];
  for (var round = 0; round < n; round++) {
    var bestGain = -1, bestIdx = -1;
    for (var ci = 0; ci < cands.length; ci++) {
      if (cands[ci].used) continue;
      var gain = 0;
      for (i = 0; i < bins.length; i++) {
        var d = dist(bins[i].r, bins[i].g, bins[i].b, cands[ci].r, cands[ci].g, cands[ci].b);
        if (best[i] === Infinity) gain += bins[i].w * (1e6 - d); else if (d < best[i]) gain += bins[i].w * (best[i] - d);
      }
      if (gain > bestGain) { bestGain = gain; bestIdx = ci; }
    }
    if (bestIdx < 0 || (round > 0 && bestGain <= 0)) break;
    var pick = cands[bestIdx];
    pick.used = true;
    palette.push(pick.byte);
    for (i = 0; i < bins.length; i++) {
      var dd = dist(bins[i].r, bins[i].g, bins[i].b, pick.r, pick.g, pick.b);
      if (dd < best[i]) best[i] = dd;
    }
  }
  return palette;
}

/** Map RGB to palette indices, optionally with serpentine Floyd-Steinberg error diffusion. */
function quantize(rgb, w, h, paletteBytes, dither) {
  // dither: error-diffusion strength 0..1 (0 = plain nearest colour)
  var pal = paletteBytes.map(colorOf);
  var idx = new Uint8Array(w * h);
  var buf = new Float32Array(rgb.length);
  for (var i = 0; i < rgb.length; i++) buf[i] = rgb[i];
  function nearest(r, g, b) {
    var bi = 0, bd = Infinity;
    for (var p = 0; p < pal.length; p++) {
      var d = dist(r, g, b, pal[p][0], pal[p][1], pal[p][2]);
      if (d < bd) { bd = d; bi = p; }
    }
    return bi;
  }
  for (var y = 0; y < h; y++) {
    var ltr = !dither || (y % 2 === 0);
    for (var s = 0; s < w; s++) {
      var x = ltr ? s : w - 1 - s;
      var o = (y * w + x) * 3;
      var r = Math.max(0, Math.min(255, buf[o])), g = Math.max(0, Math.min(255, buf[o + 1])), b = Math.max(0, Math.min(255, buf[o + 2]));
      var pi = nearest(r, g, b);
      idx[y * w + x] = pi;
      if (!dither) continue;
      var er = r - pal[pi][0], eg = g - pal[pi][1], eb = b - pal[pi][2];
      var dir = ltr ? 1 : -1;
      er *= dither; eg *= dither; eb *= dither;
      diffuse(buf, w, h, x + dir, y, 7 / 16, er, eg, eb);
      diffuse(buf, w, h, x - dir, y + 1, 3 / 16, er, eg, eb);
      diffuse(buf, w, h, x, y + 1, 5 / 16, er, eg, eb);
      diffuse(buf, w, h, x + dir, y + 1, 1 / 16, er, eg, eb);
    }
  }
  return idx;
}

function diffuse(buf, w, h, px, py, f, er, eg, eb) {
  if (px < 0 || px >= w || py >= h) return;
  var q = (py * w + px) * 3;
  buf[q] += er * f; buf[q + 1] += eg * f; buf[q + 2] += eb * f;
}

function toBase64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i += 4096) {
    var chunk = bytes.subarray(i, Math.min(bytes.length, i + 4096));
    var part = '';
    for (var j = 0; j < chunk.length; j++) part += String.fromCharCode(chunk[j]);
    s += part;
  }
  return btoa(s);
}

function packBitmap(idx, w, h, paletteBytes) {
  var stride = (w + 1) >> 1;
  var pixels = new Uint8Array(stride * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var v = idx[y * w + x] & 15;
      var o = y * stride + (x >> 1);
      pixels[o] |= (x & 1) ? v : (v << 4);
    }
  }
  return { pixels: toBase64(pixels), palette: toBase64(new Uint8Array(paletteBytes)), width: w, height: h };
}

// ---------------------------------------------------------------- constants

var VERSION = '1.0.0';
var SOURCE_KEY = 'location/map';

var SETTINGS_KEY = 'osmmap.settings.v1';
var ERROR_KEY = 'osmmap.lasterror.v1';
var POS_KEY = 'osmmap.lastpos.v1';
var TILE_INDEX_KEY = 'osmmap.tileindex.v1';
var TILE_PREFIX = 'osmmap.tile.v1:';
var BMP_INDEX_KEY = 'osmmap.bmpindex.v1';
var BMP_PREFIX = 'osmmap.bmp.v1:';

// OSM's tile policy asks for an identifying User-Agent (not a library default) and for tiles
// to be cached for at least 7 days. No prefetching or bulk download is done: only the tiles
// needed for the map being drawn are requested.
var USER_AGENT = 'PebbleOS-OSM-Map-Background/1.0 (personal Pebble plugin)';
var TILE_TTL_MS = 7 * 24 * 3600 * 1000;
var MAX_CACHED_TILES = 48;
var MAX_CACHED_BITMAPS = 8;
var BITMAP_TTL_MS = 60 * 60 * 1000;
var REUSE_FRACTION = 0.02;          // reuse a drawn map until you moved 2% of its width
var REQUEST_BUDGET_MS = 14000;      // the host gives a source request 20 s
var TILE_CONCURRENCY = 4;
var TILE_SIZE = 256;
var MAX_PRESETS = 4;
var NEUTRAL = [242, 239, 233];      // shown where a tile is missing

var WIDTHS = [150, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 20000];

// One host per style: the Internet permission is per exact host name.
var STYLES = {
  osm: {
    id: 'osm', label: 'OpenStreetMap Standard', short: 'Streets', maxZoom: 19,
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    host: 'tile.openstreetmap.org',
    attribution: '© OpenStreetMap contributors'
  },
  topo: {
    id: 'topo', label: 'OpenTopoMap (topographic)', short: 'Topo', maxZoom: 17,
    url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    host: 'tile.opentopomap.org',
    attribution: 'Map © OpenTopoMap (CC-BY-SA), data © OpenStreetMap contributors'
  },
  cyclo: {
    id: 'cyclo', label: 'CyclOSM (cycling)', short: 'Cycle', maxZoom: 20,
    url: 'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    host: 'a.tile-cyclosm.openstreetmap.fr',
    attribution: '© CyclOSM, data © OpenStreetMap contributors'
  }
};

var MARKER_COLORS = {
  red: gcolor(3, 0, 0), orange: gcolor(3, 1, 0), blue: gcolor(0, 0, 3),
  green: gcolor(0, 3, 0), magenta: gcolor(3, 0, 3), black: gcolor(0, 0, 0)
};
var MARKER_SIZES = { small: 0.022, medium: 0.032, large: 0.045 };

var DITHER = { off: 0, light: 0.35, full: 1 };

var DEFAULT_PRESET = {
  id: 'p1', name: 'Streets', style: 'osm', widthM: 1000, tone: 'normal', brightness: 0,
  color: 'color', dither: 'light', marker: 'medium', markerColor: 'red'
};

function base64ToBytes(s) {
  var bin = atob(s), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hostOf(url) {
  var m = /^https?:\/\/([^\/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

function hex(bytes, n) {
  var out = [];
  for (var i = 0; i < Math.min(n, bytes.length); i++) out.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
  return out.join(' ');
}

function oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function formatWidth(m) {
  if (m < 1000) return Math.round(m) + ' m';
  var km = Math.round(m / 100) / 10;
  return (km === Math.round(km) ? String(Math.round(km)) : km.toFixed(1)) + ' km';
}

// ---------------------------------------------------------------- settings

function nearestWidth(v) {
  var best = WIDTHS[0], d = Infinity;
  for (var i = 0; i < WIDTHS.length; i++) {
    var dd = Math.abs(Math.log(WIDTHS[i] / v));
    if (dd < d) { d = dd; best = WIDTHS[i]; }
  }
  return best;
}

function sanitizePreset(p, index, used) {
  p = p || {};
  var id = /^[a-z0-9_-]{1,16}$/.test(p.id || '') ? p.id : 'p' + (index + 1);
  while (used[id]) id = id + 'x';
  used[id] = true;
  var style = STYLES[p.style] ? p.style : 'osm';
  var name = oneLine(p.name).slice(0, 24) || STYLES[style].short;
  var width = Number(p.widthM);
  return {
    id: id,
    name: name,
    style: style,
    widthM: isFinite(width) && width > 0 ? nearestWidth(width) : DEFAULT_PRESET.widthM,
    tone: p.tone === 'dark' ? 'dark' : 'normal',
    brightness: clampInt(p.brightness, -70, 70, 0),
    color: p.color === 'gray' ? 'gray' : 'color',
    dither: (p.dither === 'off' || p.dither === false) ? 'off' : ((p.dither === 'full' || p.dither === true) ? 'full' : 'light'),
    marker: MARKER_SIZES[p.marker] ? p.marker : (p.marker === 'none' ? 'none' : DEFAULT_PRESET.marker),
    markerColor: MARKER_COLORS[p.markerColor] !== undefined ? p.markerColor : 'red'
  };
}

function sanitizeFixed(f) {
  if (!f) return null;
  var lat = Number(f.lat), lon = Number(f.lon);
  if (f.lat === '' || f.lon === '' || f.lat == null || f.lon == null) return null;
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: lat, lon: lon };
}

function sanitizeSettings(s) {
  s = s || {};
  var used = {}, presets = [];
  var list = Array.isArray(s.presets) ? s.presets.slice(0, MAX_PRESETS) : [];
  for (var i = 0; i < list.length; i++) presets.push(sanitizePreset(list[i], i, used));
  if (!presets.length) presets.push(sanitizePreset(DEFAULT_PRESET, 0, {}));
  return { presets: presets, fixed: sanitizeFixed(s.fixed) };
}

function loadSettings() { return sanitizeSettings(storeGet(SETTINGS_KEY)); }

// ---------------------------------------------------------------- location

function geolocate() {
  return new Promise(function (resolve, reject) {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { reject(new Error('geolocation is not available')); return; }
    navigator.geolocation.getCurrentPosition(
      function (position) { resolve(position.coords); },
      function (error) { reject(error); },
      { maximumAge: 5 * 60 * 1000, timeout: 15 * 1000, enableHighAccuracy: false }
    );
  });
}

async function getPosition(settings, override) {
  var fixed = override ? sanitizeFixed(override) : settings.fixed;
  if (fixed) return { lat: fixed.lat, lon: fixed.lon, source: 'fixed location' };
  try {
    var c = await geolocate();
    var pos = { lat: c.latitude, lon: c.longitude, source: 'phone location' };
    storeSet(POS_KEY, { lat: pos.lat, lon: pos.lon, t: Date.now() });
    return pos;
  } catch (e) {
    var last = storeGet(POS_KEY);
    var denied = e && (e.code === 1 || /denied|permission/i.test(e.message || ''));
    if (last && !denied) return { lat: last.lat, lon: last.lon, source: 'last known location (' + errText(e) + ')', stale: true };
    var err = new Error(denied ? 'Location permission is off for this plugin' : 'no location: ' + errText(e));
    err.code = denied ? 'PERMISSION_DENIED' : 'UNKNOWN';
    throw err;
  }
}

function distanceM(lat1, lon1, lat2, lon2) {
  var r = 6371000, p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  var dp = p2 - p1, dl = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------- map geometry

function mercator(lat, lon, z) {
  lat = Math.max(-85.0511, Math.min(85.0511, lat));
  var n = Math.pow(2, z) * TILE_SIZE, s = Math.sin(lat * Math.PI / 180);
  return { x: (lon + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}

/** Which tile zoom to use so the image is widthM metres across; k = tile pixels per output pixel. */
function plan(lat, widthM, w, style) {
  var clat = Math.max(-85.0511, Math.min(85.0511, lat));
  var mpp0 = 156543.03392804097 * Math.cos(clat * Math.PI / 180);
  var zf = Math.log(mpp0 * w / widthM) / Math.LN2;
  var z = Math.max(0, Math.min(style.maxZoom, Math.ceil(zf - 1e-6)));
  var k = Math.pow(2, z - zf);
  return { z: z, zf: zf, k: k, limited: zf > style.maxZoom + 1e-6, actualWidthM: mpp0 / Math.pow(2, z) * w * k };
}

// ---------------------------------------------------------------- tiles

function isPng(b) { return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47; }

function decodeTile(bytes) {
  var png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (png.width !== TILE_SIZE || png.height !== TILE_SIZE) throw new Error('unexpected tile size ' + png.width + 'x' + png.height);
  return new Uint8Array(UPNG.toRGBA8(png)[0]);
}

function cacheTile(key, bytes) {
  var index = storeGet(TILE_INDEX_KEY) || [];
  index = index.filter(function (k) { return k !== key; });
  index.push(key);
  while (index.length > MAX_CACHED_TILES) storeRemove(TILE_PREFIX + index.shift());
  var rec = { t: Date.now(), d: toBase64(bytes) };
  if (!storeSet(TILE_PREFIX + key, rec)) {
    // Quota: drop the older half and retry once.
    var drop = Math.ceil(index.length / 2);
    while (drop-- > 0 && index.length > 1) storeRemove(TILE_PREFIX + index.shift());
    if (!storeSet(TILE_PREFIX + key, rec)) index = index.filter(function (k) { return k !== key; });
  }
  storeSet(TILE_INDEX_KEY, index);
}

async function fetchTilePng(style, z, x, y) {
  var url = style.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  var response = await fetch(url, { responseType: 'arraybuffer', headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + hostOf(url));
  var bytes = new Uint8Array(await response.arrayBuffer());
  if (!isPng(bytes)) {
    var hint = (bytes.length > 0 && bytes[0] === 0xFD) ? ' (bytes look text-decoded: responseType was ignored)' : '';
    throw new Error('tile is not a PNG: ' + hex(bytes, 8) + hint);
  }
  return bytes;
}

function loadTile(style, z, x, y, memo, stats) {
  var n = Math.pow(2, z), xi = ((x % n) + n) % n;
  var key = style.id + '/' + z + '/' + xi + '/' + y;
  if (!memo[key]) {
    memo[key] = (async function () {
      var rec = storeGet(TILE_PREFIX + key);
      if (rec && Date.now() - rec.t < TILE_TTL_MS) {
        try { var cached = decodeTile(base64ToBytes(rec.d)); stats.cached++; return cached; } catch (e) { storeRemove(TILE_PREFIX + key); }
      }
      var bytes = await fetchTilePng(style, z, xi, y);
      var data = decodeTile(bytes);
      cacheTile(key, bytes);
      stats.fetched++;
      return data;
    })();
  }
  return memo[key];
}

async function mapLimit(items, limit, fn) {
  var next = 0, workers = [];
  async function worker() {
    for (;;) {
      var i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }
  for (var i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
}

// ---------------------------------------------------------------- drawing

/** Area-average (k >= 1) or bilinear (k < 1) resample of a window of the mosaic into tw x th RGB. */
function resampleWindow(src, sw, sh, rx, ry, rw, rh, tw, th) {
  var out = new Uint8Array(tw * th * 3), x, y;
  function clampX(v) { return v < 0 ? 0 : (v > sw - 1 ? sw - 1 : v); }
  function clampY(v) { return v < 0 ? 0 : (v > sh - 1 ? sh - 1 : v); }
  for (y = 0; y < th; y++) {
    for (x = 0; x < tw; x++) {
      var o = (y * tw + x) * 3, r = 0, g = 0, b = 0;
      if (rw >= tw) {
        var xa = rx + x * rw / tw, xb = rx + (x + 1) * rw / tw, ya = ry + y * rh / th, yb = ry + (y + 1) * rh / th;
        var x0 = Math.floor(xa), x1 = Math.max(x0 + 1, Math.ceil(xb)), y0 = Math.floor(ya), y1 = Math.max(y0 + 1, Math.ceil(yb)), n = 0;
        for (var yy = y0; yy < y1; yy++) {
          var cy = clampY(yy) * sw;
          for (var xx = x0; xx < x1; xx++) {
            var p = (cy + clampX(xx)) * 4;
            r += src[p]; g += src[p + 1]; b += src[p + 2]; n++;
          }
        }
        r /= n; g /= n; b /= n;
      } else {
        var fx = rx + (x + 0.5) * rw / tw - 0.5, fy = ry + (y + 0.5) * rh / th - 0.5;
        var ix = Math.floor(fx), iy = Math.floor(fy), wx = fx - ix, wy = fy - iy;
        var p00 = (clampY(iy) * sw + clampX(ix)) * 4, p10 = (clampY(iy) * sw + clampX(ix + 1)) * 4;
        var p01 = (clampY(iy + 1) * sw + clampX(ix)) * 4, p11 = (clampY(iy + 1) * sw + clampX(ix + 1)) * 4;
        r = (src[p00] * (1 - wx) + src[p10] * wx) * (1 - wy) + (src[p01] * (1 - wx) + src[p11] * wx) * wy;
        g = (src[p00 + 1] * (1 - wx) + src[p10 + 1] * wx) * (1 - wy) + (src[p01 + 1] * (1 - wx) + src[p11 + 1] * wx) * wy;
        b = (src[p00 + 2] * (1 - wx) + src[p10 + 2] * wx) * (1 - wy) + (src[p01 + 2] * (1 - wx) + src[p11 + 2] * wx) * wy;
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }
  return out;
}

/** Invert lightness but keep hue and saturation: white roads on dark ground, blue water stays blue. */
function darkTone(rgb) {
  for (var i = 0; i < rgb.length; i += 3) {
    var r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min, h = 0, s = 0;
    if (d > 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d + 6) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    }
    var l2 = 1 - l, c = (1 - Math.abs(2 * l2 - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l2 - c / 2, rr, gg, bb;
    if (h < 1) { rr = c; gg = x; bb = 0; } else if (h < 2) { rr = x; gg = c; bb = 0; } else if (h < 3) { rr = 0; gg = c; bb = x; }
    else if (h < 4) { rr = 0; gg = x; bb = c; } else if (h < 5) { rr = x; gg = 0; bb = c; } else { rr = c; gg = 0; bb = x; }
    rgb[i] = (rr + m) * 255; rgb[i + 1] = (gg + m) * 255; rgb[i + 2] = (bb + m) * 255;
  }
}

function applyBrightness(rgb, amount) {
  var i;
  if (amount < 0) { var k = 1 + amount / 100; for (i = 0; i < rgb.length; i++) rgb[i] = rgb[i] * k; }
  else if (amount > 0) { var f = amount / 100; for (i = 0; i < rgb.length; i++) rgb[i] = rgb[i] + (255 - rgb[i]) * f; }
}

function drawMarker(idx, w, h, radius, fill, white, black) {
  var cx = w / 2, cy = h / 2, R = radius + 2;
  for (var y = Math.max(0, Math.floor(cy - R - 1)); y <= Math.min(h - 1, Math.ceil(cy + R + 1)); y++) {
    for (var x = Math.max(0, Math.floor(cx - R - 1)); x <= Math.min(w - 1, Math.ceil(cx + R + 1)); x++) {
      var dx = x + 0.5 - cx, dy = y + 0.5 - cy, d2 = dx * dx + dy * dy;
      if (d2 <= radius * radius) idx[y * w + x] = fill;
      else if (d2 <= (radius + 1) * (radius + 1)) idx[y * w + x] = white;
      else if (d2 <= R * R) idx[y * w + x] = black;
    }
  }
}

// ---------------------------------------------------------------- bitmap cache

function bitmapKey(p, w, h) {
  return BMP_PREFIX + [p.style, p.widthM, p.tone, p.brightness, p.color, p.dither, p.marker, p.markerColor, w, h].join('|');
}

function cacheBitmap(key, rec) {
  var index = storeGet(BMP_INDEX_KEY) || [];
  index = index.filter(function (k) { return k !== key; });
  index.push(key);
  while (index.length > MAX_CACHED_BITMAPS) storeRemove(index.shift());
  if (!storeSet(key, rec)) { while (index.length > 1) storeRemove(index.shift()); storeSet(key, rec); }
  storeSet(BMP_INDEX_KEY, index);
}

function clearCaches() {
  [TILE_INDEX_KEY, BMP_INDEX_KEY].forEach(function (indexKey, n) {
    var list = storeGet(indexKey) || [];
    for (var i = 0; i < list.length; i++) storeRemove(n === 0 ? TILE_PREFIX + list[i] : list[i]);
    storeRemove(indexKey);
  });
}

// ---------------------------------------------------------------- render one map

async function renderMap(preset, pos, w, h, ctx) {
  var started = Date.now(), log = ctx.log, style = STYLES[preset.style];
  var key = bitmapKey(preset, w, h);
  if (!ctx.force) {
    var hit = storeGet(key);
    if (hit && hit.bitmap && Date.now() - hit.t < BITMAP_TTL_MS &&
        distanceM(pos.lat, pos.lon, hit.lat, hit.lon) < REUSE_FRACTION * preset.widthM) {
      log('map from cache (moved ' + Math.round(distanceM(pos.lat, pos.lon, hit.lat, hit.lon)) + ' m)');
      var cachedInfo = JSON.parse(JSON.stringify(hit.info)); cachedInfo.fromCache = true;
      return { bitmap: hit.bitmap, info: cachedInfo };
    }
  }

  var pl = plan(pos.lat, preset.widthM, w, style);
  var c = mercator(pos.lat, pos.lon, pl.z);
  var rw = w * pl.k, rh = h * pl.k, left = c.x - rw / 2, top = c.y - rh / 2;
  var n = Math.pow(2, pl.z);
  var tx0 = Math.floor(left / TILE_SIZE), tx1 = Math.floor((left + rw - 1e-6) / TILE_SIZE);
  var ty0 = Math.floor(top / TILE_SIZE), ty1 = Math.floor((top + rh - 1e-6) / TILE_SIZE);
  var tiles = [];
  for (var ty = ty0; ty <= ty1; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (var tx = tx0; tx <= tx1; tx++) tiles.push({ x: tx, y: ty });
  }
  var stats = { total: tiles.length, cached: 0, fetched: 0, failed: 0 };
  log('zoom ' + pl.z + (pl.limited ? ' (style maximum)' : '') + ', ' + style.id + ', ' + tiles.length + ' tile' + (tiles.length === 1 ? '' : 's') + ', window ' + Math.round(rw) + 'x' + Math.round(rh) + ' tile px');
  var lastError = null;
  await mapLimit(tiles, TILE_CONCURRENCY, async function (t) {
    try { t.data = await loadTile(style, pl.z, t.x, t.y, ctx.memo, stats); }
    catch (e) { stats.failed++; lastError = e; log('tile ' + pl.z + '/' + t.x + '/' + t.y + ' failed: ' + errText(e)); if (e && e.name === 'NotAllowedError') lastError = e; }
  });
  if (stats.failed === tiles.length && tiles.length) {
    var fail = new Error('no map tile could be loaded: ' + errText(lastError));
    fail.name = lastError && lastError.name === 'NotAllowedError' ? 'NotAllowedError' : 'Error';
    throw fail;
  }
  log('tiles: ' + stats.cached + ' cached, ' + stats.fetched + ' downloaded, ' + stats.failed + ' failed');

  var mw = (tx1 - tx0 + 1) * TILE_SIZE, mh = (ty1 - ty0 + 1) * TILE_SIZE;
  var mosaic = new Uint8Array(mw * mh * 4), i;
  for (i = 0; i < mosaic.length; i += 4) { mosaic[i] = NEUTRAL[0]; mosaic[i + 1] = NEUTRAL[1]; mosaic[i + 2] = NEUTRAL[2]; mosaic[i + 3] = 255; }
  tiles.forEach(function (t) {
    if (!t.data) return;
    var ox = (t.x - tx0) * TILE_SIZE, oy = (t.y - ty0) * TILE_SIZE;
    for (var row = 0; row < TILE_SIZE; row++) {
      var s = row * TILE_SIZE * 4;
      mosaic.set(t.data.subarray(s, s + TILE_SIZE * 4), ((oy + row) * mw + ox) * 4);
    }
  });

  var rgb = resampleWindow(mosaic, mw, mh, left - tx0 * TILE_SIZE, top - ty0 * TILE_SIZE, rw, rh, w, h);
  if (preset.tone === 'dark') darkTone(rgb);
  if (preset.brightness) applyBrightness(rgb, preset.brightness);
  if (preset.color === 'gray') {
    for (i = 0; i < rgb.length; i += 3) { var l = rgb[i] * 0.299 + rgb[i + 1] * 0.587 + rgb[i + 2] * 0.114; rgb[i] = rgb[i + 1] = rgb[i + 2] = l; }
  }

  var marker = preset.marker !== 'none';
  var fillByte = MARKER_COLORS[preset.markerColor], reserved = [];
  if (marker) { [0xC0, 0xFF, fillByte].forEach(function (b) { if (reserved.indexOf(b) < 0) reserved.push(b); }); }
  var palette = preset.color === 'gray' ? GRAY_PALETTE.slice() : choosePalette(rgb, 16 - reserved.length);
  reserved.forEach(function (b) { if (palette.indexOf(b) < 0) palette.push(b); });
  var idx = quantize(rgb, w, h, palette, DITHER[preset.dither]);
  if (marker) {
    var radius = Math.max(2, Math.round(Math.min(w, h) * MARKER_SIZES[preset.marker]));
    drawMarker(idx, w, h, radius, palette.indexOf(fillByte), palette.indexOf(0xFF), palette.indexOf(0xC0));
  }
  var bitmap = packBitmap(idx, w, h, palette);
  var info = {
    style: style.id, zoom: pl.z, limited: pl.limited, widthM: Math.round(pl.actualWidthM), tiles: stats,
    lat: pos.lat, lon: pos.lon, source: pos.source, ms: Date.now() - started, fromCache: false
  };
  log('drawn ' + w + 'x' + h + ', ' + palette.length + ' colours in ' + (Date.now() - started) + ' ms');
  if (!stats.failed) cacheBitmap(key, { t: Date.now(), lat: pos.lat, lon: pos.lon, bitmap: bitmap, info: info });
  return { bitmap: bitmap, info: info };
}

// ---------------------------------------------------------------- source handler

function propertiesFor(preset, pos, wants) {
  var style = STYLES[preset.style], p = {};
  if (wants('name')) p.name = { shortText: { text: preset.name }, longText: { text: preset.name + ' (' + style.label + ', ' + formatWidth(preset.widthM) + ')' } };
  if (wants('style')) p.style = { shortText: { text: style.short }, longText: { text: style.label } };
  if (wants('width_m')) p.width_m = { numericValue: { value: preset.widthM }, shortText: { text: formatWidth(preset.widthM) }, longText: { text: 'about ' + formatWidth(preset.widthM) + ' across' } };
  if (wants('latitude')) p.latitude = { numericValue: { value: pos.lat } };
  if (wants('longitude')) p.longitude = { numericValue: { value: pos.lon } };
  if (wants('attribution')) p.attribution = { longText: { text: style.attribution } };
  if (wants('updated')) p.updated = { timestamp: { value: Math.floor(Date.now() / 1000) } };
  return p;
}

Pebble.registerSourceHandler(async function (request, respond) {
  if (request.category !== 'location' || request.item !== 'map') {
    respond.error('PLUGIN_UNAVAILABLE', 'this plugin only serves ' + SOURCE_KEY);
    return;
  }
  var started = Date.now(), log = makeLog(), settings = loadSettings(), pos;
  try {
    pos = await getPosition(settings, null);
  } catch (e) {
    storeSet(ERROR_KEY, { at: Date.now(), message: errText(e) });
    respond.error(e.code || 'UNKNOWN', errText(e));
    return;
  }
  var wants = function (name) { return !request.properties || request.properties.indexOf(name) >= 0; };
  var size = request.iconPixelSize, ctx = { log: log, memo: {}, force: false }, instances = [], lastErr = null;
  for (var i = 0; i < settings.presets.length; i++) {
    var preset = settings.presets[i], props = propertiesFor(preset, pos, wants);
    if (wants('image') && size) {
      if (Date.now() - started > REQUEST_BUDGET_MS) {
        log('out of time budget, skipping image for "' + preset.name + '"');
      } else {
        try {
          var r = await renderMap(preset, pos, clampInt(size.w, 1, 260, 144), clampInt(size.h, 1, 260, 168), ctx);
          props.image = { image: r.bitmap };
        } catch (e) { lastErr = e; log('"' + preset.name + '" failed: ' + errText(e)); }
      }
    }
    instances.push({ instanceId: preset.id, properties: props });
  }
  if (lastErr) storeSet(ERROR_KEY, { at: Date.now(), message: errText(lastErr), log: log.lines.slice(-8) }); else storeRemove(ERROR_KEY);
  respond.data({ validUntilMs: Date.now() + (pos.stale ? 2 : 10) * 60 * 1000, instances: instances });
});

// ---------------------------------------------------------------- config page conversation

async function missingPermissions(styleIds, needLocation) {
  var perms = Pebble.permissions;
  if (!perms || typeof perms.query !== 'function') return null;
  var checks = [];
  if (needLocation) checks.push(['Location', 'Location']);
  styleIds.forEach(function (id) { checks.push(['Internet/' + STYLES[id].host, STYLES[id].host]); });
  var missing = [];
  for (var i = 0; i < checks.length; i++) {
    try {
      var state = await perms.query(checks[i][0]);
      var value = state && typeof state === 'object' ? (state.state || state.status) : state;
      if (value && value !== 'granted') missing.push(checks[i][1]);
    } catch (e) { /* unknown: don't nag */ }
  }
  return missing;
}

function styleList() {
  return Object.keys(STYLES).map(function (id) {
    return { id: id, label: STYLES[id].label, maxZoom: STYLES[id].maxZoom, host: STYLES[id].host, attribution: STYLES[id].attribution };
  });
}

Pebble.registerConfigHandler(async function (message, respond) {
  var type = message && message.type, log = makeLog();
  try {
    if (type === 'init') {
      var settings = loadSettings();
      respond({
        version: VERSION, settings: settings, styles: styleList(), widths: WIDTHS, maxPresets: MAX_PRESETS,
        defaultPreset: sanitizePreset(DEFAULT_PRESET, 0, {}),
        lastError: storeGet(ERROR_KEY),
        missingPermissions: await missingPermissions(settings.presets.map(function (p) { return p.style; }), !settings.fixed)
      });
    } else if (type === 'save') {
      var s = sanitizeSettings(message.settings);
      storeSet(SETTINGS_KEY, s);
      try { Pebble.refreshSources([SOURCE_KEY]); } catch (e) { /* ignore */ }
      respond({ ok: true, settings: s });
    } else if (type === 'clearCache') {
      clearCaches();
      storeRemove(ERROR_KEY);
      respond({ ok: true });
    } else if (type === 'preview') {
      var preset = sanitizePreset(message.preset, 0, {});
      var w = clampInt(message.width, 1, 260, 144), h = clampInt(message.height, 1, 260, 168);
      var fixed = sanitizeFixed(message.fixed);
      var res = { version: VERSION, width: w, height: h, preset: preset };
      try {
        var pos = await getPosition({ fixed: null }, fixed);
        res.position = pos;
        var r = await renderMap(preset, pos, w, h, { log: log, memo: {}, force: !!message.fresh });
        res.image = r.bitmap; res.info = r.info;
        res.attribution = STYLES[preset.style].attribution;
        storeRemove(ERROR_KEY);
      } catch (e) {
        res.error = errText(e);
        res.errorCode = e && e.code;
      }
      res.missingPermissions = await missingPermissions([preset.style], !fixed);
      res.log = log.lines;
      respond(res);
    } else {
      respond({ error: 'unknown message type: ' + type });
    }
  } catch (e) {
    respond({ error: errText(e), log: log.lines });
  }
});
