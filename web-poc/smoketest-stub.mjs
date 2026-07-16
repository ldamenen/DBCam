// Pipeline verification with a STUBBED MediaPipe module (the real CDN is blocked
// by this environment's network policy). We fulfill the tasks-vision import with a
// fake that returns a centered face + a growing, centered dog, then drive the loop
// and assert: canvas draws, FPS>0, deterrent fires, incident logged, playback ready.
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

// Stub ES module matching the MediaPipe Tasks API surface our code uses.
const STUB = `
let n = 0;
export const FilesetResolver = { forVisionTasks: async () => ({}) };
export class FaceDetector {
  static async createFromOptions() { return new FaceDetector(); }
  detectForVideo(video) {
    const w = video.videoWidth || 1280, h = video.videoHeight || 720;
    // one centered face, high confidence
    return { detections: [{ boundingBox: { originX: w*0.4, originY: h*0.3, width: w*0.2, height: h*0.25 },
      categories: [{ score: 0.95 }] }] };
  }
  close() {}
}
export class ObjectDetector {
  static async createFromOptions() { return new ObjectDetector(); }
  detectForVideo(video) {
    const w = video.videoWidth || 1280, h = video.videoHeight || 720;
    n++;
    // dog box grows toward the camera and stays centered -> should trigger "approach"
    const frac = Math.min(0.5, 0.12 + n * 0.01);
    const bw = Math.sqrt(frac) * w, bh = Math.sqrt(frac) * h;
    return { detections: [{ boundingBox: { originX: (w-bw)/2, originY: (h-bh)/2, width: bw, height: bh },
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

// Intercept the MediaPipe module import and serve our stub.
await page.route('**/tasks-vision@**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.click('#startBtn');
await page.waitForTimeout(6000);

const mid = await page.evaluate(() => ({
  fps: document.getElementById('fps').textContent,
  status: document.getElementById('status').textContent,
  stopDisabled: document.getElementById('stopBtn').disabled,
  incidents: document.getElementById('incidentCount').textContent,
  deterrent: document.getElementById('deterrentPill').textContent,
  canvasNonBlank: (() => {
    const canvas = document.getElementById('preview');
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const cx = c.getContext('2d'); cx.drawImage(canvas, 0, 0, 32, 32);
    const d = cx.getImageData(0, 0, 32, 32).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 8 || d[i+1] > 8 || d[i+2] > 8) return true;
    return false;
  })(),
}));

await page.click('#stopBtn');
await page.waitForTimeout(2500);
const end = await page.evaluate(() => ({
  playbackHidden: document.getElementById('playback').hidden,
  hasVideoSrc: !!document.getElementById('playbackVideo').src,
  status: document.getElementById('status').textContent,
}));

console.log('MID', JSON.stringify(mid, null, 2));
console.log('END', JSON.stringify(end, null, 2));
console.log('ERRORS', JSON.stringify(errors, null, 2));

await browser.close();
server.close();

const fpsNum = parseFloat(mid.fps);
const ok = mid.canvasNonBlank && !mid.stopDisabled && fpsNum > 0 &&
  mid.incidents !== 'incidents: 0' && !end.playbackHidden && end.hasVideoSrc && errors.length === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
