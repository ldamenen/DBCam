// Pipeline verification with a STUBBED MediaPipe module (the real CDN is blocked
// by this environment's network policy). Drives the FULL flow: start -> flag a
// manual incident -> stop -> verify blurred playback, a sealed evidence segment,
// authorized unseal (with audit entry) and clamped raw playback.
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8124;
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

// Stub: one centered face (so per-face pixelation runs), and a SMALL static dog
// (below approach threshold) so the only incident is the manual Event we click.
const STUB = `
export const FilesetResolver = { forVisionTasks: async () => ({}) };
export class FaceDetector {
  static async createFromOptions() { return new FaceDetector(); }
  detectForVideo(video) {
    const w = video.videoWidth || 1280, h = video.videoHeight || 720;
    return { detections: [{ boundingBox: { originX: w*0.4, originY: h*0.3, width: w*0.2, height: h*0.25 },
      categories: [{ score: 0.95 }] }] };
  }
  close() {}
}
export class ObjectDetector {
  static async createFromOptions() { return new ObjectDetector(); }
  detectForVideo(video) {
    const w = video.videoWidth || 1280, h = video.videoHeight || 720;
    const bw = w*0.10, bh = h*0.10;
    return { detections: [{ boundingBox: { originX: 10, originY: 10, width: bw, height: bh },
      categories: [{ categoryName: 'dog', score: 0.9 }] }] };
  }
  close() {}
}
`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept()); // auto-authorize the unseal confirm

await page.route('**/tasks-vision@**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
const versionText = await page.evaluate(() => document.getElementById('version').textContent);
await page.click('#startBtn');
await page.waitForTimeout(3000);
// With a face detected and the detector healthy, we must be in FACES-ONLY mode,
// i.e. NOT whole-frame over-blur.
const detStatus = await page.evaluate(() => document.getElementById('detPill').textContent);
await page.click('#eventBtn');          // flag a manual incident
await page.waitForTimeout(2500);
await page.click('#stopBtn');
await page.waitForTimeout(2500);

const afterStop = await page.evaluate(() => ({
  blurredHidden: document.getElementById('playback').hidden,
  evidenceHidden: document.getElementById('evidence').hidden,
  segmentCount: document.querySelectorAll('#segmentList .segment').length,
  auditHidden: document.getElementById('auditSection').hidden,
  auditCount: document.querySelectorAll('#auditList .audit-entry').length,
  firstUnsealText: (document.querySelector('#segmentList .segment button') || {}).textContent || '',
}));

// Unseal the first segment.
await page.click('#segmentList .segment button');
await page.waitForTimeout(1500);
// Export the unsealed raw (should download + write a raw-export audit entry).
await page.click('#segmentList .segment .btn.export');
await page.waitForTimeout(800);
const afterUnseal = await page.evaluate(() => ({
  rawPlayerHidden: document.getElementById('rawPlayerWrap').hidden,
  rawHasSrc: !!document.getElementById('rawVideo').src,
  segUnsealedClass: !!document.querySelector('#segmentList .segment.unsealed'),
  auditHasUnseal: [...document.querySelectorAll('#auditList .a-type')].some(e => e.textContent === 'raw-unseal'),
  auditHasExport: [...document.querySelectorAll('#auditList .a-type')].some(e => e.textContent === 'raw-export'),
}));

console.log('VERSION', versionText);
console.log('DET_STATUS', detStatus);
console.log('AFTER_STOP', JSON.stringify(afterStop, null, 2));
console.log('AFTER_UNSEAL', JSON.stringify(afterUnseal, null, 2));
console.log('ERRORS', JSON.stringify(errors, null, 2));

await browser.close();
server.close();

const facesOnly = /faces\s*1/.test(detStatus) && !/over-blur/.test(detStatus);
const ok =
  /^v\d/.test(versionText) &&
  facesOnly &&
  afterStop.blurredHidden === false &&
  afterStop.evidenceHidden === false &&
  afterStop.segmentCount >= 1 &&
  afterStop.auditCount > 0 &&
  afterUnseal.rawPlayerHidden === false &&
  afterUnseal.rawHasSrc === true &&
  afterUnseal.segUnsealedClass === true &&
  afterUnseal.auditHasUnseal === true &&
  afterUnseal.auditHasExport === true &&
  errors.length === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
