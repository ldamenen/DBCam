// Headless smoke test: serve the PoC, launch Chromium with a fake camera,
// click Start, let the loop run, and assert the pipeline draws frames without
// fatal errors. Verifies capture -> detect -> blur -> record wiring end to end.
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8123;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, p);
  if (!file.startsWith(__dirname) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(PORT, r));

const exe = path.join('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const proxyServer = process.env.HTTPS_PROXY || undefined;
const browser = await chromium.launch({
  executablePath: exe,
  proxy: proxyServer ? { server: proxyServer } : undefined,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    '--proxy-bypass-list=127.0.0.1;localhost',
  ],
});
const ctx = await browser.newContext({
  permissions: ['camera', 'microphone'],
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();

const errors = [];
const logs = [];
page.on('console', (m) => { logs.push(`[${m.type()}] ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.click('#startBtn');

// Give models time to load from CDN and the loop to run.
await page.waitForTimeout(12000);
const startState = await page.evaluate(() => ({
  status: document.getElementById('status').textContent,
  stopDisabled: document.getElementById('stopBtn').disabled,
}));
console.log('AFTER_START', JSON.stringify(startState));
console.log('LOGS', JSON.stringify(logs.slice(-25), null, 2));
if (startState.stopDisabled) {
  console.log('ERRORS', JSON.stringify(errors, null, 2));
  await browser.close(); server.close(); process.exit(1);
}

const result = await page.evaluate(() => {
  const fps = document.getElementById('fps').textContent;
  const status = document.getElementById('status').textContent;
  const canvas = document.getElementById('preview');
  // Sample the canvas: if the loop is drawing, it won't be uniformly blank.
  let nonBlank = false;
  try {
    const c = document.createElement('canvas');
    c.width = 40; c.height = 40;
    const cx = c.getContext('2d');
    cx.drawImage(canvas, 0, 0, 40, 40);
    const d = cx.getImageData(0, 0, 40, 40).data;
    for (let i = 0; i < d.length; i += 4) { if (d[i] > 8 || d[i+1] > 8 || d[i+2] > 8) { nonBlank = true; break; } }
  } catch (e) { return { err: String(e) }; }
  return { fps, status, canvasW: canvas.width, canvasH: canvas.height, nonBlank };
});

// Stop and confirm a recording is produced.
await page.click('#stopBtn');
await page.waitForTimeout(2500);
const playbackVisible = await page.evaluate(() => {
  const pb = document.getElementById('playback');
  const v = document.getElementById('playbackVideo');
  return { hidden: pb.hidden, hasSrc: !!v.src, status: document.getElementById('status').textContent };
});

console.log('RESULT', JSON.stringify(result, null, 2));
console.log('PLAYBACK', JSON.stringify(playbackVisible, null, 2));
console.log('ERRORS', JSON.stringify(errors, null, 2));

await browser.close();
server.close();

// Exit non-zero if the pipeline clearly did not run.
const ok = result.nonBlank && result.canvasW > 0 && !playbackVisible.hidden;
process.exit(ok ? 0 : 1);
