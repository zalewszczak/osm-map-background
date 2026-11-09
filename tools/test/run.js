// Runs the built plugin (src/plugin/index.js) in a node vm against a mock phone + mock tile server.
//   node tools/test/run.js [outDir]
const fs = require('fs'), path = require('path'), vm = require('vm'), zlib = require('zlib');
const root = path.join(__dirname, '..', '..');
const outDir = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const script = fs.readFileSync(path.join(root, 'src/plugin/index.js'), 'utf8');
let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };

// ---- tiny PNG encoder + synthetic world: 128px squares in 4 pure colours, keyed on global pixel coords.
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
const COLS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
const worldColor = (gx, gy) => COLS[((gx >> 7) & 1) | (((gy >> 7) & 1) << 1)];
const tilePng = (z, x, y, size = 256) => {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) { const c = worldColor(x * 256 + i, y * 256 + j); raw.set(c, j * (size * 3 + 1) + 1 + i * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

function makeHost(opts = {}) {
  const store = {}; let handler, cfg; const reqs = [];
  const geo = { mode: 'ok', lat: opts.lat ?? 48.2082, lon: opts.lon ?? 16.3738 };
  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {} }, atob, btoa, Date, Math, JSON, Uint8Array, Float32Array, Float64Array, Int32Array, ArrayBuffer, Promise, Error, String, Number, Array, Object, RegExp, Infinity, isFinite, parseInt, Map,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    navigator: { geolocation: { getCurrentPosition: (ok_, err) => {
      if (geo.mode === 'ok') ok_({ coords: { latitude: geo.lat, longitude: geo.lon } });
      else if (geo.mode === 'denied') err({ code: 1, message: 'User denied Geolocation' });
      else err({ code: 3, message: 'timeout' }); } } },
    Pebble: { registerSourceHandler: f => { handler = f; }, registerConfigHandler: f => { cfg = f; }, refreshSources: () => {}, permissions: { query: async () => 'granted' } },
    fetch: async (url, init) => {
      reqs.push({ url, init });
      const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url);
      const failing = opts.fail && opts.fail(url, reqs.length);
      if (!m || failing) return { ok: false, status: failing === 'throw' ? 500 : 404, headers: { get: () => null } };
      let b = tilePng(+m[1], +m[2], +m[3]);
      if (!(init && init.responseType === 'arraybuffer') && !opts.binarySafe) b = Buffer.from(Array.from(b).map(v => (v >= 0x80 ? 0xFD : v)));
      return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
  };
  ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(script, ctx, { filename: 'index.js' });
  return { ctx, reqs, store, geo, source: (req) => new Promise(res => handler(req, { data: d => res({ data: d }), error: (c, m) => res({ error: c + ': ' + m }) })), config: (msg) => new Promise(res => cfg(msg, res)) };
}

function validBitmap(b, w, h) {
  const px = Buffer.from(b.pixels, 'base64'), pal = Buffer.from(b.palette, 'base64');
  return b.width <= w && b.height <= h && px.length === ((b.width + 1) >> 1) * b.height && pal.length >= 1 && pal.length <= 16 && pal.every(v => (v & 0xC0) === 0xC0);
}
function pixelAt(b, x, y) { const px = Buffer.from(b.pixels, 'base64'), pal = Buffer.from(b.palette, 'base64'), v = px[y * ((b.width + 1) >> 1) + (x >> 1)]; return pal[(x & 1) ? v & 15 : v >> 4]; }
const bytesOf = (c) => 0xC0 | ((c[0] / 85) << 4) | ((c[1] / 85) << 2) | (c[2] / 85);
const preset = (o) => Object.assign({ id: 'p1', name: 'T', style: 'osm', widthM: 500, tone: 'normal', brightness: 0, color: 'color', dither: 'off', marker: 'none', markerColor: 'red' }, o);
const save = (h, presets, fixed) => h.config({ type: 'save', settings: { presets, fixed } });

(async () => {
  // 1. Geometry/alignment: compare against an independently computed ideal picture.
  let h = makeHost({ lat: 0, lon: 0 });
  await save(h, [preset({})]);
  let r = await h.source({ category: 'location', item: 'map', iconPixelSize: { w: 200, h: 228 } });
  ok(!!r.data, 'source returns data: ' + (r.error || ''));
  const inst = r.data.instances[0], img = inst.properties.image.image;
  ok(validBitmap(img, 200, 228) && img.width === 200 && img.height === 228, 'image valid 200x228');
  {
    // ideal: z=16 (500 m wide, lat 0), k = 2^(16 - log2(156543.03*200/500))
    const z = 16, k = Math.pow(2, z - Math.log2(156543.03392804097 * 200 / 500)), n = Math.pow(2, z) * 256, cx = n / 2, cy = n / 2;
    let same = 0, total = 0;
    for (let y = 4; y < 224; y++) for (let x = 4; x < 196; x++) {
      const gx = Math.floor(cx + (x + 0.5 - 100) * k), gy = Math.floor(cy + (y + 0.5 - 114) * k);
      total++; if (pixelAt(img, x, y) === bytesOf(worldColor(gx, gy))) same++;
    }
    ok(same / total > 0.97, `tiles stitched and aligned: ${(100 * same / total).toFixed(2)}% of pixels match the ideal picture`);
  }
  ok(h.reqs.length <= 9 && h.reqs.every(q => q.url.startsWith('https://tile.openstreetmap.org/') && /OSM-Map/.test(q.init.headers['User-Agent']) && q.init.responseType === 'arraybuffer'), `tile requests: ${h.reqs.length}, identifying User-Agent, arraybuffer`);
  ok(inst.properties.name.shortText.text === 'T' && inst.properties.width_m.numericValue.value === 500 && /OpenStreetMap/.test(inst.properties.attribution.longText.text), 'instance properties');
  fs.writeFileSync(path.join(outDir, 'align.json'), JSON.stringify(img));

  // 2. Caching: same position = no network; small move = new bitmap but no tiles; far move = new tiles.
  const n0 = h.reqs.length;
  await h.source({ category: 'location', item: 'map', iconPixelSize: { w: 200, h: 228 } });
  ok(h.reqs.length === n0, 'second request served from cache');
  h.geo.lon += 0.00005;  // ~5.5 m at 500 m width (> 2%)
  await h.source({ category: 'location', item: 'map', iconPixelSize: { w: 200, h: 228 } });
  ok(h.reqs.length === n0, 'small move re-drew from cached tiles (0 downloads)');
  h.geo.lon += 0.05;
  await h.source({ category: 'location', item: 'map', iconPixelSize: { w: 200, h: 228 } });
  ok(h.reqs.length > n0, 'large move downloaded new tiles');

  // 3. Marker, tones, gray, brightness, styles, zoom limit.
  h = makeHost();
  for (const [name, p] of [['marker', { marker: 'large', markerColor: 'red' }], ['dark', { tone: 'dark', marker: 'medium', markerColor: 'orange' }], ['gray', { color: 'gray', marker: 'small', markerColor: 'black' }], ['bright', { brightness: 40, dither: 'full' }], ['topo', { style: 'topo', widthM: 150 }], ['cyclo', { style: 'cyclo', widthM: 3000 }], ['wide', { widthM: 20000, dither: 'light' }]]) {
    const W = name === 'topo' ? 260 : 144, H = name === 'topo' ? 260 : 168;
    const pv = await h.config({ type: 'preview', preset: preset(p), width: W, height: H, fresh: true });
    ok(pv.image && validBitmap(pv.image, W, H), `preview ${name}: ${pv.error || 'ok'} zoom ${pv.info && pv.info.zoom}${pv.info && pv.info.limited ? ' (limited)' : ''}`);
    if (pv.image) fs.writeFileSync(path.join(outDir, `p-${name}.json`), JSON.stringify(pv.image));
    if (name === 'marker') { ok(pixelAt(pv.image, 72, 84) === 0xF0, 'marker centre is red'); ok([0xFF, 0xC0].includes(pixelAt(pv.image, 72 + Math.round(144 * 0.045) + 1, 84)) || pixelAt(pv.image, 72 + Math.round(144 * 0.045) + 1, 84) === 0xFF, 'marker has a white ring'); }
    if (name === 'topo') ok(pv.info.limited && pv.info.zoom === 17 && /opentopomap/.test(h.reqs[h.reqs.length - 1].url), 'topo capped at its max zoom 17 and uses its own host');
  }

  // 4. Several presets => several instances, tile memo shared.
  h = makeHost();
  await save(h, [preset({ id: 'a', name: 'Street' }), preset({ id: 'b', name: 'Topo', style: 'topo', widthM: 2000 }), preset({ id: 'c', name: 'Street', widthM: 500, tone: 'dark' })]);
  r = await h.source({ category: 'location', item: 'map', iconPixelSize: { w: 200, h: 228 } });
  ok(r.data.instances.length === 3 && r.data.instances.every(i => i.properties.image && validBitmap(i.properties.image.image, 200, 228)), '3 presets -> 3 instances with images');
  ok(r.data.instances.map(i => i.instanceId).join() === 'a,b,c', 'instance ids kept');
  const dup = h.reqs.map(q => q.url).filter((u, i, a) => a.indexOf(u) !== i);
  ok(dup.length === 0, 'no tile downloaded twice (shared between presets)');
  r = await h.source({ category: 'location', item: 'map', properties: ['name'] });
  ok(Object.keys(r.data.instances[0].properties).join() === 'name', 'property filter; no image without iconPixelSize');
  const lim = await save(h, new Array(9).fill(0).map((_, i) => preset({ id: 'x' + i })));
  ok(lim.settings.presets.length === 4, 'presets limited to 4');

  // 5. Failures.
  h = makeHost({ fail: (u) => /\/\d+\/\d+\/\d+\.png/.test(u) && /\/(\d+)\.png$/.test(u) && (+/\/(\d+)\.png$/.exec(u)[1]) % 2 === 1 });
  let pv = await h.config({ type: 'preview', preset: preset({}), width: 200, height: 228 });
  ok(pv.image && pv.info.tiles.failed > 0, `partial tile failure still draws (${pv.info && pv.info.tiles.failed} failed)`);
  const nf = h.reqs.length; await h.config({ type: 'preview', preset: preset({}), width: 200, height: 228 });
  ok(h.reqs.length > nf, 'partial maps are not cached (failed tiles retried)');
  h = makeHost({ fail: () => true });
  pv = await h.config({ type: 'preview', preset: preset({}), width: 200, height: 228 });
  ok(!pv.image && /no map tile/.test(pv.error), 'all tiles failing -> clear error: ' + pv.error);
  h = makeHost(); h.ctx.fetch = ((o) => (u, i) => o(u, Object.assign({}, i, { responseType: undefined })))(h.ctx.fetch);
  pv = await h.config({ type: 'preview', preset: preset({}), width: 200, height: 228 });
  ok(!pv.image && /text-decoded/.test(pv.log.join(' ')), 'mangled binary is diagnosed');

  // 6. Location handling.
  h = makeHost(); h.geo.mode = 'denied';
  r = await h.source({ category: 'location', item: 'map', iconPixelSize: { w: 100, h: 100 } });
  ok(/PERMISSION_DENIED/.test(r.error), 'denied location -> PERMISSION_DENIED');
  h = makeHost(); await h.source({ category: 'location', item: 'map', properties: ['latitude'] }); h.geo.mode = 'timeout';
  r = await h.source({ category: 'location', item: 'map', properties: ['latitude'] });
  ok(r.data && r.data.instances[0].properties.latitude.numericValue.value === 48.2082, 'falls back to last known location');
  h = makeHost(); h.geo.mode = 'denied'; await save(h, [preset({})], { lat: 10, lon: 20 });
  r = await h.source({ category: 'location', item: 'map', properties: ['latitude', 'longitude'] });
  ok(r.data && r.data.instances[0].properties.longitude.numericValue.value === 20, 'fixed location needs no GPS');
  pv = await h.config({ type: 'preview', preset: preset({}), width: 100, height: 100, fixed: { lat: 47, lon: 8 } });
  ok(pv.image && pv.position.lat === 47, 'preview honours the fixed location in the form');

  // 7. Config + misc.
  h = makeHost();
  const init = await h.config({ type: 'init' });
  ok(init.settings.presets.length === 1 && init.styles.length === 3 && Array.isArray(init.missingPermissions), 'config init');
  r = await h.source({ category: 'x', item: 'y' }); ok(/PLUGIN_UNAVAILABLE/.test(r.error), 'wrong source rejected');
  r = await h.config({ type: 'clearCache' }); ok(r.ok && Object.keys(h.store).filter(k => k.startsWith('osmmap.tile')).length === 0, 'clear cache');

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
