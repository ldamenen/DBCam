// Pipeline verification with a STUBBED MediaPipe module (the real CDN is blocked
// by this environment's network policy). Drives the FULL flow: start -> flag a
// manual incident -> stop -> verify blurred playback, a sealed evidence segment,
// authorized unseal (with audit entry) and clamped raw playback.
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Serve the REPO ROOT (site layout: /web-poc/ app + /core/ shared Core), matching
// the deployed GitHub Pages structure.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 8124;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('nf');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  if (req.method === 'HEAD') return res.end();
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
const ctx = await browser.newContext({
  permissions: ['camera', 'microphone'],
  serviceWorkers: 'block', // keep Playwright routing deterministic
});
// This scenario asserts the raw-kept flow, so pick the 'demo' region (raw-sealed)
// BEFORE the app loads — the app stores the region as a JSON string.
await ctx.addInitScript(() => {
  try { localStorage.setItem('dbcam.region', '"demo"'); } catch (_e) {}
});
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept()); // auto-authorize the unseal confirm

// Stub the detection module wherever it loads from (local vendor or CDN fallback).
await page.route('**/vision_bundle.mjs', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
await page.route('**/tasks-vision@**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(`http://localhost:${PORT}/web-poc/`, { waitUntil: 'load' });
const versionText = await page.evaluate(() => document.getElementById('version').textContent);
const regionState = await page.evaluate(() => ({
  selectValue: document.getElementById('regionSelect').value,
  optionCount: document.getElementById('regionSelect').options.length,
  hintHidden: document.getElementById('regionHint').hidden,
  rawPill: document.getElementById('rawPill').textContent,
}));
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

// Persistence: reload the page — the finished session must have been saved to
// IndexedDB, appear under "My recordings", and Watch must reopen the review UI.
await page.goto(`http://localhost:${PORT}/web-poc/`, { waitUntil: 'load' });
await page.waitForTimeout(1500); // async IndexedDB list render
const afterReload = await page.evaluate(() => ({
  recordingsHidden: document.getElementById('recordings').hidden,
  recordingRows: document.querySelectorAll('#recordingsList .segment').length,
}));
await page.click('#recordingsList .segment .btn.watch');
await page.waitForTimeout(1200);
const afterWatch = await page.evaluate(() => ({
  playbackHidden: document.getElementById('playback').hidden,
}));
await ctx.close();

// ===== Fail-safe scenario: NO stored region -> strictest rules, raw NOT kept =====
// A fresh context has no 'dbcam.region' key (and no init script re-adding one),
// so the app must fail safe to the 'unknown' profile: first-run tip visible,
// raw pill "not kept", and after a session the alert shows a disabled
// "Original not kept" button — no unlock possible.
const ctx2 = await browser.newContext({
  permissions: ['camera', 'microphone'],
  serviceWorkers: 'block',
});
const page2 = await ctx2.newPage();
page2.on('dialog', (d) => d.accept());
await page2.route('**/vision_bundle.mjs', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
await page2.route('**/tasks-vision@**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
const errors2 = [];
page2.on('console', (m) => { if (m.type() === 'error') errors2.push(m.text()); });
page2.on('pageerror', (e) => errors2.push('pageerror: ' + e.message));

await page2.goto(`http://localhost:${PORT}/web-poc/`, { waitUntil: 'load' });
const failSafeLoad = await page2.evaluate(() => ({
  storedRegion: localStorage.getItem('dbcam.region'),
  selectValue: document.getElementById('regionSelect').value,
  hintHidden: document.getElementById('regionHint').hidden,
  rawPill: document.getElementById('rawPill').textContent,
}));
await page2.click('#startBtn');
await page2.waitForTimeout(2500);
await page2.click('#eventBtn');          // flag an alert under the strictest rules
await page2.waitForTimeout(1500);
await page2.click('#stopBtn');
await page2.waitForTimeout(2500);
const failSafeStop = await page2.evaluate(() => {
  const btn = document.querySelector('#segmentList .segment button');
  return {
    evidenceHidden: document.getElementById('evidence').hidden,
    segmentCount: document.querySelectorAll('#segmentList .segment').length,
    unsealBtnText: btn ? btn.textContent : '',
    unsealBtnDisabled: btn ? btn.disabled : false,
    enabledSegmentButtons: [...document.querySelectorAll('#segmentList .segment button')]
      .filter((b) => !b.disabled).length,
    rawPill: document.getElementById('rawPill').textContent,
  };
});
await ctx2.close();

console.log('VERSION', versionText);
console.log('REGION_STATE', JSON.stringify(regionState, null, 2));
console.log('DET_STATUS', detStatus);
console.log('AFTER_STOP', JSON.stringify(afterStop, null, 2));
console.log('AFTER_UNSEAL', JSON.stringify(afterUnseal, null, 2));
console.log('AFTER_RELOAD', JSON.stringify(afterReload, null, 2));
console.log('AFTER_WATCH', JSON.stringify(afterWatch, null, 2));
console.log('FAILSAFE_LOAD', JSON.stringify(failSafeLoad, null, 2));
console.log('FAILSAFE_STOP', JSON.stringify(failSafeStop, null, 2));
console.log('ERRORS', JSON.stringify(errors, null, 2));
console.log('ERRORS2', JSON.stringify(errors2, null, 2));

await browser.close();
server.close();

const facesOnly = /faces\s*1/.test(detStatus) && !/over-blur/.test(detStatus);
const ok =
  /^v\d/.test(versionText) &&
  regionState.selectValue === 'demo' &&
  regionState.optionCount >= 5 &&
  regionState.hintHidden === true &&      // a region is chosen -> no first-run tip
  /kept locked/.test(regionState.rawPill) &&
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
  afterReload.recordingsHidden === false &&
  afterReload.recordingRows >= 1 &&
  afterWatch.playbackHidden === false &&
  // Fail-safe scenario: no stored region -> strictest rules, raw never kept.
  failSafeLoad.storedRegion === null &&
  failSafeLoad.selectValue === 'unknown' &&
  failSafeLoad.hintHidden === false &&    // first-run tip is showing
  /not kept/.test(failSafeLoad.rawPill) &&
  failSafeStop.evidenceHidden === false &&
  failSafeStop.segmentCount >= 1 &&
  failSafeStop.unsealBtnText === 'Original not kept' &&
  failSafeStop.unsealBtnDisabled === true &&
  failSafeStop.enabledSegmentButtons === 0 &&
  /not kept/.test(failSafeStop.rawPill) &&
  errors.length === 0 &&
  errors2.length === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
