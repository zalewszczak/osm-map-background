// Loads src/config.html in headless Chromium with the real plugin bundle behind a mock Pebble host
// and a synthetic tile server.   usage: node tools/test/browser.js <screenshotDir>
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..', '..'), shots = process.argv[2];
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function mapColor(gx, gy, z) {
  const s = Math.pow(2, 16 - z); // keep features roughly constant in ground size
  const X = gx * s, Y = gy * s;
  if (((Y - 0.4 * X) % 6000 + 6000) % 6000 < 160) return [170, 211, 223];
  const major = (X % 1800 + 1800) % 1800 < 26 || (Y % 1500 + 1500) % 1500 < 26;
  if (major) return [252, 214, 164];
  const minor = (X % 300 + 300) % 300 < 11 || (Y % 260 + 260) % 260 < 11;
  if (minor) return [255, 255, 255];
  if ((((X >> 10) + (Y >> 10)) % 4 + 4) % 4 === 0 && hash(X >> 10, Y >> 10) > 0.3) return [200, 230, 190];
  if (hash(Math.floor(X / 60), Math.floor(Y / 60)) > 0.45) return [217, 208, 201];
  return [242, 239, 233];
}
function tile(z, x, y) {
  const raw = Buffer.alloc(257 * 256 * 3 / 3 * 3 / 1); const stride = 256 * 3 + 1, buf = Buffer.alloc(stride * 256);
  for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) buf.set(mapColor(x * 256 + i, y * 256 + j, z), j * stride + 1 + i * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(buf)), chunk('IEND', Buffer.alloc(0))]);
}
const mock = `
  (function(){ var cfg=null;
    window.Pebble = { registerSourceHandler:function(){}, registerConfigHandler:function(f){cfg=f}, refreshSources:function(){},
      permissions:{ query:function(){ return Promise.resolve('granted'); } },
      sendMessage:function(t,m){ return new Promise(function(res){ cfg(m,res); }); },
      addEventListener:function(ev,fn){ if(ev==='ready') setTimeout(function(){ fn({target:'plugin'}); },50); } };
    Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition:function(ok){ ok({coords:{latitude:48.2082,longitude:16.3738}}); }}});
  })();`;
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 400, height: 900 }, deviceScaleFactor: 2 })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let tiles = 0;
  await page.route(/https:\/\/(tile\.openstreetmap\.org|tile\.opentopomap\.org|a\.tile-cyclosm\.openstreetmap\.fr)\/.*/, r => {
    const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(r.request().url()); tiles++;
    r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'image/png', body: tile(+m[1], +m[2], +m[3]) });
  });
  await page.addInitScript({ content: mock });
  await page.addInitScript({ content: fs.readFileSync(path.join(root, 'src/plugin/index.js'), 'utf8') });
  await page.goto('file://' + path.join(root, 'src/config.html'));
  const works = () => page.waitForFunction(() => /^Works/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
  await works();
  console.log('status:', await page.textContent('#status'), '| info:', (await page.textContent('#info')).slice(0, 160));
  await page.screenshot({ path: path.join(shots, 'map-config-1.png'), fullPage: true });
  // change style + width + dark + marker colour => debounced live preview
  await page.selectOption('#style', 'topo'); await page.selectOption('#widthM', '2000'); await page.selectOption('#tone', 'dark'); await page.selectOption('#markerColor', 'orange');
  await page.waitForFunction(() => /OpenTopoMap/.test(document.getElementById('info').textContent) && /^Works/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
  console.log('live preview after change:', (await page.textContent('#info')).slice(0, 120));
  await page.click('text=+ Add'); await page.selectOption('#style', 'osm'); await page.selectOption('#widthM', '500');
  await page.selectOption('#preset', '260x260'); await page.selectOption('#locMode', 'fixed'); await page.fill('#lat', '47.0707'); await page.fill('#lon', '15.4395');
  await page.waitForFunction(() => /47\.0707/.test(document.getElementById('info').textContent) && /260/.test(document.getElementById('canvas').width), null, { timeout: 20000 });
  await page.click('#save'); await page.waitForFunction(() => /^Saved/.test(document.getElementById('status').textContent));
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, 'map-config-2.png'), fullPage: true });
  console.log('tile requests that reached the network:', tiles, '| page errors:', JSON.stringify(errors));
  await browser.close(); process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
