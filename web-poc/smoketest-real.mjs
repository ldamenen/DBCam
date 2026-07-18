// Real-detection check: NO stub — loads the vendored MediaPipe wasm + models and
// verifies the detectors initialize and run on the fake camera feed.
import { chromium } from 'playwright-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.wasm':'application/wasm', '.tflite':'application/octet-stream' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(8126, r));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--no-sandbox'] });
const ctx = await browser.newContext({ permissions: ['camera','microphone'], serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; const reqs = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type()==='error' && !/^INFO:/.test(m.text()) && !/favicon/.test(m.text()) && !/404/.test(m.text())) errors.push(m.text()); });
page.on('request', r => { const u=r.url(); if (!u.startsWith('http://localhost')) reqs.push(u); });
await page.goto('http://localhost:8126/web-poc/', { waitUntil: 'load' });
await page.click('#startBtn');
await page.waitForTimeout(15000); // wasm + model init on CPU can take a while
const state = await page.evaluate(() => ({
  status: document.getElementById('status').textContent,
  det: document.getElementById('detPill').textContent,
  fps: document.getElementById('fps').textContent,
}));
console.log('STATE', JSON.stringify(state));
console.log('EXTERNAL_REQUESTS', JSON.stringify(reqs));
console.log('ERRORS', JSON.stringify(errors.slice(0,5)));
await browser.close(); server.close();
const ok = /detector: ok/.test(state.det) && reqs.length === 0 && errors.length === 0;
console.log(ok ? 'REAL-DETECT PASS (fully self-contained)' : 'REAL-DETECT FAIL');
process.exit(ok ? 0 : 1);
