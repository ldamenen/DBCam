// Pipeline verification with a STUBBED MediaPipe module (the real CDN is blocked
// by this environment's network policy). Drives the FULL flow against the v2
// jurisdiction policy layer:
//   1. Manual Singapore (raw kept, audio on): record -> motion alert -> manual
//      alert -> stop -> unlock -> play -> reload -> My recordings -> Watch.
//      Publishing is off in the ruleset, so BOTH save/export controls must be
//      hidden and no raw-export may ever reach the audit log.
//   2. Manual Spain (blur-at-capture): STORAGE-LEVEL assertion that no raw
//      recorder started and the saved IndexedDB record has raw === null.
//   3. Manual France (recording blocked): Start disabled + blocking card.
//   4. GPS auto mode (Barcelona fix): status card shows Spain via GPS.
//   5. Fail-safe default (no location at all) + user override to Singapore
//      via the confirmation modal; override chip + audit entry.
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Serve the REPO ROOT (site layout: /web-poc/ app + /core/ shared Core + data),
// matching the deployed GitHub Pages structure.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 8124;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
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
// (below approach threshold) so the only incidents are the ones we raise.
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

/** New page with the detection stub routed + console error collection. */
async function preparePage(ctx, errors) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept()); // auto-authorize unseal confirms
  await page.route('**/vision_bundle.mjs', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
  await page.route('**/tasks-vision@**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return page;
}
const APP = `http://localhost:${PORT}/web-poc/`;
const waitReady = (page) =>
  page.waitForFunction(() => window.__dbcamDebug && window.__dbcamDebug.policyReady, null, { timeout: 30000 });

// =====================================================================
// Scenario 1 — manual Singapore: the rich full flow (raw kept, audio on)
// =====================================================================
const errors = [];
const ctx = await browser.newContext({
  permissions: ['camera', 'microphone'],
  serviceWorkers: 'block', // keep Playwright routing deterministic
});
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('dbcam.locationMode', 'manual');
    localStorage.setItem('dbcam.manualJurisdiction', 'SG');
  } catch (_e) {}
});
const page = await preparePage(ctx, errors);
await page.goto(APP, { waitUntil: 'load' });
await waitReady(page);
const versionText = await page.evaluate(() => document.getElementById('version').textContent);
const policyState = await page.evaluate(() => ({
  location: document.getElementById('policyLocation').textContent,
  profileName: document.getElementById('policyProfileName').textContent,
  source: document.getElementById('policySource').textContent,
  jurisdictionValue: document.getElementById('jurisdictionSelect').value,
  manualChecked: document.getElementById('locModeManual').checked,
  rawPill: document.getElementById('rawPill').textContent,
  audioPill: document.getElementById('audioPill').textContent,
  blockedHidden: document.getElementById('policyBlockedCard').hidden,
  rulesRows: document.querySelectorAll('#rulesList li').length,
  rulesetInfo: document.getElementById('rulesetInfo').textContent,
}));
await page.click('#startBtn');
await page.waitForTimeout(3000);
// With a face detected and the detector healthy, we must be in FACES-ONLY mode,
// i.e. NOT whole-frame over-blur.
const detStatus = await page.evaluate(() => document.getElementById('detPill').textContent);
// Movement alert: a synthetic devicemotion burst (the violent-shake pattern from
// the golden fixtures) must travel the FULL path: adapter -> Core MotionDetector
// -> fireEvent('imu') -> incident + deterrent. accelerationIncludingGravity is a
// readonly getter on real events, so it is defined onto a plain Event instance.
const motionState = await page.evaluate(async () => {
  const dispatch = (x, y, z) => {
    const e = new Event('devicemotion');
    Object.defineProperty(e, 'accelerationIncludingGravity', { value: { x, y, z } });
    window.dispatchEvent(e);
  };
  for (let i = 0; i < 30; i++) {           // ~600ms of ±25 m/s^2 jolts at ~50Hz
    dispatch(i % 2 ? 25 : -25, 0, 9.81);
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 400)); // let the incident banner/count render
  return {
    alerts: document.getElementById('incidentCount').textContent,
    motionStatus: document.getElementById('motionStatus').textContent,
    motionChecked: document.getElementById('motionEnable').checked,
  };
});
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
  auditHasPolicyResolved: [...document.querySelectorAll('#auditList .a-type')].some(e => e.textContent === 'policy-resolved'),
  firstUnsealText: (document.querySelector('#segmentList .segment button') || {}).textContent || '',
  // publishingAllowed=false everywhere in the current ruleset: the privacy-video
  // download must be hidden and its explanatory note shown.
  downloadHidden: document.getElementById('downloadLink').hidden,
  publishNoteHidden: document.getElementById('publishNote').hidden,
  publishNoteText: document.getElementById('publishNote').textContent,
}));

// Unseal the first segment (unlock/play must still work with publishing off).
await page.click('#segmentList .segment button');
await page.waitForTimeout(1500);
const afterUnseal = await page.evaluate(() => ({
  rawPlayerHidden: document.getElementById('rawPlayerWrap').hidden,
  rawHasSrc: !!document.getElementById('rawVideo').src,
  segUnsealedClass: !!document.querySelector('#segmentList .segment.unsealed'),
  auditHasUnseal: [...document.querySelectorAll('#auditList .a-type')].some(e => e.textContent === 'raw-unseal'),
  // publishingAllowed=false: the export button must NOT exist, the in-row note
  // must, and the audit log must NOT gain a raw-export entry.
  exportBtnCount: document.querySelectorAll('#segmentList .segment .btn.export').length,
  exportNotePresent: !!document.querySelector('#segmentList .segment .export-note'),
  auditHasExport: [...document.querySelectorAll('#auditList .a-type')].some(e => e.textContent === 'raw-export'),
}));

// Persistence: reload the page — the finished session must have been saved to
// IndexedDB, appear under "My recordings", and Watch must reopen the review UI.
await page.goto(APP, { waitUntil: 'load' });
await waitReady(page);
await page.waitForTimeout(1200); // async IndexedDB list render
const afterReload = await page.evaluate(() => ({
  recordingsHidden: document.getElementById('recordings').hidden,
  recordingRows: document.querySelectorAll('#recordingsList .segment').length,
}));
await page.click('#recordingsList .segment .btn.watch');
await page.waitForTimeout(1200);
const afterWatch = await page.evaluate(() => ({
  playbackHidden: document.getElementById('playback').hidden,
  downloadHidden: document.getElementById('downloadLink').hidden,
}));
await ctx.close();

// =====================================================================
// Scenario 2 — manual Spain: STORAGE-LEVEL "no raw was ever recorded"
// =====================================================================
const errors2 = [];
const ctx2 = await browser.newContext({ permissions: ['camera', 'microphone'], serviceWorkers: 'block' });
await ctx2.addInitScript(() => {
  try {
    localStorage.setItem('dbcam.locationMode', 'manual');
    localStorage.setItem('dbcam.manualJurisdiction', 'ES');
  } catch (_e) {}
});
const page2 = await preparePage(ctx2, errors2);
await page2.goto(APP, { waitUntil: 'load' });
await waitReady(page2);
const esLoad = await page2.evaluate(() => ({
  location: document.getElementById('policyLocation').textContent,
  profileName: document.getElementById('policyProfileName').textContent,
  rawPill: document.getElementById('rawPill').textContent,
  audioPill: document.getElementById('audioPill').textContent,
}));
await page2.click('#startBtn');
await page2.waitForTimeout(2500);
const esDuring = await page2.evaluate(() => ({
  // ES profile carries a noticeText -> the dismissible strip must show it.
  noticeHidden: document.getElementById('noticeStrip').hidden,
  noticeText: document.getElementById('noticeStripText').textContent,
  soundPill: document.getElementById('soundPill').textContent,
}));
await page2.click('#eventBtn');
await page2.waitForTimeout(1500);
await page2.click('#stopBtn');
await page2.waitForTimeout(2500);
const esStop = await page2.evaluate(async () => {
  const btn = document.querySelector('#segmentList .segment button');
  // STORAGE assertion (§ critical test): read the saved record straight out of
  // IndexedDB — the truth about what was stored, not what the UI intended.
  const records = await new Promise((resolve, reject) => {
    const req = indexedDB.open('dbcam');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('sessions', 'readonly');
      const all = tx.objectStore('sessions').getAll();
      all.onsuccess = () => resolve(all.result.map((r) => ({
        rawIsNull: r.raw === null,
        hasBlurred: !!r.blurred,
        policyProfileId: r.policy && r.policy.profile && r.policy.profile.id,
        policyChangesLen: (r.policyChanges || []).length,
      })));
      all.onerror = () => reject(all.error);
    };
    req.onerror = () => reject(req.error);
  });
  return {
    rawRecorderStarted: window.__dbcamDebug.rawRecorderStarted,
    records,
    unsealBtnText: btn ? btn.textContent : '',
    unsealBtnDisabled: btn ? btn.disabled : false,
    rawPill: document.getElementById('rawPill').textContent,
  };
});
await ctx2.close();

// =====================================================================
// Scenario 3 — manual France: recording blocked
// =====================================================================
const errors3 = [];
const ctx3 = await browser.newContext({ permissions: ['camera', 'microphone'], serviceWorkers: 'block' });
await ctx3.addInitScript(() => {
  try {
    localStorage.setItem('dbcam.locationMode', 'manual');
    localStorage.setItem('dbcam.manualJurisdiction', 'FR');
  } catch (_e) {}
});
const page3 = await preparePage(ctx3, errors3);
await page3.goto(APP, { waitUntil: 'load' });
await waitReady(page3);
const frState = await page3.evaluate(() => ({
  startDisabled: document.getElementById('startBtn').disabled,
  blockedHidden: document.getElementById('policyBlockedCard').hidden,
  blockedText: document.getElementById('policyBlockedCard').textContent,
  profileName: document.getElementById('policyProfileName').textContent,
}));
await ctx3.close();

// =====================================================================
// Scenario 4 — GPS auto mode: a Barcelona fix must resolve Spain (ES)
// =====================================================================
const errors4 = [];
const ctx4 = await browser.newContext({
  permissions: ['geolocation'],
  geolocation: { latitude: 41.39, longitude: 2.17, accuracy: 50 },
  serviceWorkers: 'block',
});
const page4 = await preparePage(ctx4, errors4);
await page4.goto(APP, { waitUntil: 'load' });
await waitReady(page4);
const gpsState = await page4.evaluate(() => ({
  location: document.getElementById('policyLocation').textContent,
  profileName: document.getElementById('policyProfileName').textContent,
  source: document.getElementById('policySource').textContent,
  confidence: document.getElementById('policyConfidence').textContent,
  rawPill: document.getElementById('rawPill').textContent,
}));
await ctx4.close();

// =====================================================================
// Scenario 5 — fail-safe default (no location) + override to Singapore
// =====================================================================
const errors5 = [];
const ctx5 = await browser.newContext({ permissions: ['camera', 'microphone'], serviceWorkers: 'block' });
const page5 = await preparePage(ctx5, errors5);
await page5.goto(APP, { waitUntil: 'load' });
await waitReady(page5);
// Fail-safe: fresh context, auto mode, geolocation denied -> strictest rules.
const failSafeLoad = await page5.evaluate(() => ({
  source: document.getElementById('policySource').textContent,
  profileName: document.getElementById('policyProfileName').textContent,
  noteHidden: document.getElementById('policyStatusNote').hidden,
  noteText: document.getElementById('policyStatusNote').textContent,
  rawPill: document.getElementById('rawPill').textContent,
  startDisabled: document.getElementById('startBtn').disabled,
}));
// Open Settings and turn the override on.
await page5.evaluate(() => { document.querySelector('details.sheet').open = true; });
await page5.click('#overrideEnable');
const pickerState = await page5.evaluate(() => ({
  pickerHidden: document.getElementById('overrideProfileSelect').hidden,
  optionCount: document.getElementById('overrideProfileSelect').options.length,
}));
await page5.selectOption('#overrideProfileSelect', 'SG_PERSONAL');
await page5.waitForTimeout(300);
const modalState = await page5.evaluate(() => ({
  modalHidden: document.getElementById('overrideModal').hidden,
  confirmDisabledBefore: document.getElementById('ovmConfirm').disabled,
  changeCount: document.querySelectorAll('#ovmChanges li').length,
  contextText: document.getElementById('ovmContext').textContent,
}));
await page5.check('#ovmAck');
const confirmEnabled = await page5.evaluate(() => !document.getElementById('ovmConfirm').disabled);
await page5.click('#ovmConfirm');
await page5.waitForTimeout(300);
const afterOverride = await page5.evaluate(() => ({
  modalHidden: document.getElementById('overrideModal').hidden,
  bannerHidden: document.getElementById('overrideBanner').hidden,
  bannerText: document.getElementById('overrideBannerText').textContent,
  source: document.getElementById('policySource').textContent,
  profileName: document.getElementById('policyProfileName').textContent,
  rawPill: document.getElementById('rawPill').textContent,
  stored: sessionStorage.getItem('dbcam.override'),
}));
// Record under the override: the amber chip must show on the stage.
await page5.click('#startBtn');
await page5.waitForTimeout(2500);
const overrideDuring = await page5.evaluate(() => ({
  chipHidden: document.getElementById('overrideChip').hidden,
}));
await page5.click('#stopBtn');
await page5.waitForTimeout(2500);
const overrideStop = await page5.evaluate(() => ({
  auditHasOverrideEnabled: [...document.querySelectorAll('#auditList .a-type')].some(e => e.textContent === 'override-enabled'),
  auditHasPolicyResolved: [...document.querySelectorAll('#auditList .a-type')].some(e => e.textContent === 'policy-resolved'),
  // The recording row is tagged as made under an override.
  overrideTag: !!document.querySelector('#recordingsList .override-tag'),
}));
await ctx5.close();

// =====================================================================
// Scenario 6 — blurMode 'facesAndBodies': person boxes reach the blur layer.
// The shipped ruleset only uses 'faces', so a MODIFIED ruleset (ES switched to
// facesAndBodies) is served for this scenario and the object-detector stub also
// reports a 'person'.
// =====================================================================
const errors6 = [];
const ctx6 = await browser.newContext({ permissions: ['camera', 'microphone'], serviceWorkers: 'block' });
await ctx6.addInitScript(() => {
  try {
    localStorage.setItem('dbcam.locationMode', 'manual');
    localStorage.setItem('dbcam.manualJurisdiction', 'ES');
  } catch (_e) {}
});
const page6 = await preparePage(ctx6, errors6);
const rulesetBodies = JSON.parse(fs.readFileSync(path.join(ROOT, 'core/data/ruleset.json'), 'utf8'));
for (const p of rulesetBodies.profiles) if (p.id === 'ES_STRICT') p.blurMode = 'facesAndBodies';
await page6.route('**/core/data/ruleset.json*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rulesetBodies) }));
const STUB_PERSON = STUB.replace(
  "categories: [{ categoryName: 'dog', score: 0.9 }] }] };",
  `categories: [{ categoryName: 'dog', score: 0.9 }] },
      { boundingBox: { originX: w*0.55, originY: h*0.2, width: w*0.2, height: h*0.6 },
        categories: [{ categoryName: 'person', score: 0.9 }] }] };`,
);
await page6.unroute('**/vision_bundle.mjs');
await page6.route('**/vision_bundle.mjs', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB_PERSON }));
await page6.goto(APP, { waitUntil: 'load' });
await waitReady(page6);
const bodiesLoad = await page6.evaluate(() => ({
  blurRule: [...document.querySelectorAll('#rulesList li')]
    .map((li) => li.textContent).find((t) => t.startsWith('Blur')) || '',
}));
await page6.click('#startBtn');
await page6.waitForTimeout(2500);
const bodiesDuring = await page6.evaluate(() => ({
  extraRegions: window.__dbcamDebug.lastExtraRegions,
  det: document.getElementById('detPill').textContent,
}));
await page6.click('#stopBtn');
await page6.waitForTimeout(1500);
await ctx6.close();

// =====================================================================
// Scenario 7 — service worker scope: the SW registered at /web-poc/ must
// intercept the page's same-origin fetches to /core/data/ (interception is by
// controlled PAGE, not URL path) and cache them network-first.
// =====================================================================
const errors7 = [];
const ctx7 = await browser.newContext({ permissions: [] }); // service workers ALLOWED
const page7 = await ctx7.newPage();
page7.on('console', (m) => { if (m.type() === 'error') errors7.push(m.text()); });
page7.on('pageerror', (e) => errors7.push('pageerror: ' + e.message));
await page7.goto(APP, { waitUntil: 'load' });
await page7.evaluate(() => navigator.serviceWorker.ready);
await page7.reload({ waitUntil: 'load' });
await waitReady(page7);
const swState = await page7.evaluate(async () => {
  const keys = await caches.keys();
  const cache = await caches.open('dbcam-v0.14.0');
  const hit = await cache.match(new URL('../core/data/ruleset.json', location.href).href);
  return {
    controlled: !!navigator.serviceWorker.controller,
    cacheKeys: keys,
    rulesetCached: !!hit,
    rulesRows: document.querySelectorAll('#rulesList li').length,
  };
});
await ctx7.close();

console.log('VERSION', versionText);
console.log('POLICY_STATE', JSON.stringify(policyState, null, 2));
console.log('DET_STATUS', detStatus);
console.log('MOTION_STATE', JSON.stringify(motionState, null, 2));
console.log('AFTER_STOP', JSON.stringify(afterStop, null, 2));
console.log('AFTER_UNSEAL', JSON.stringify(afterUnseal, null, 2));
console.log('AFTER_RELOAD', JSON.stringify(afterReload, null, 2));
console.log('AFTER_WATCH', JSON.stringify(afterWatch, null, 2));
console.log('ES_LOAD', JSON.stringify(esLoad, null, 2));
console.log('ES_DURING', JSON.stringify(esDuring, null, 2));
console.log('ES_STOP', JSON.stringify(esStop, null, 2));
console.log('FR_STATE', JSON.stringify(frState, null, 2));
console.log('GPS_STATE', JSON.stringify(gpsState, null, 2));
console.log('FAILSAFE_LOAD', JSON.stringify(failSafeLoad, null, 2));
console.log('PICKER_STATE', JSON.stringify(pickerState, null, 2));
console.log('MODAL_STATE', JSON.stringify(modalState, null, 2));
console.log('CONFIRM_ENABLED', confirmEnabled);
console.log('AFTER_OVERRIDE', JSON.stringify(afterOverride, null, 2));
console.log('OVERRIDE_DURING', JSON.stringify(overrideDuring, null, 2));
console.log('OVERRIDE_STOP', JSON.stringify(overrideStop, null, 2));
console.log('BODIES_LOAD', JSON.stringify(bodiesLoad, null, 2));
console.log('BODIES_DURING', JSON.stringify(bodiesDuring, null, 2));
console.log('SW_STATE', JSON.stringify(swState, null, 2));
console.log('ERRORS', JSON.stringify([errors, errors2, errors3, errors4, errors5, errors6, errors7], null, 2));

await browser.close();
server.close();

const facesOnly = /faces\s*1/.test(detStatus) && !/over-blur/.test(detStatus);
const ok =
  /^v\d/.test(versionText) &&
  // Scenario 1 — manual Singapore
  policyState.location === 'Singapore (SG)' &&
  /Singapore/.test(policyState.profileName) &&
  policyState.source === 'Chosen manually' &&
  policyState.jurisdictionValue === 'SG' &&
  policyState.manualChecked === true &&
  /kept locked/.test(policyState.rawPill) &&
  /Sound: on/.test(policyState.audioPill) &&
  policyState.blockedHidden === true &&
  policyState.rulesRows === 7 &&
  /Rules version 0\./.test(policyState.rulesetInfo) &&
  facesOnly &&
  motionState.motionChecked === true &&
  motionState.motionStatus === 'on' &&
  motionState.alerts === 'Alerts: 1' &&
  afterStop.blurredHidden === false &&
  afterStop.evidenceHidden === false &&
  afterStop.segmentCount >= 1 &&
  afterStop.auditCount > 0 &&
  afterStop.auditHasPolicyResolved === true &&
  afterStop.downloadHidden === true &&               // publishingAllowed=false
  afterStop.publishNoteHidden === false &&
  /turned off by this location/.test(afterStop.publishNoteText) &&
  afterUnseal.rawPlayerHidden === false &&
  afterUnseal.rawHasSrc === true &&
  afterUnseal.segUnsealedClass === true &&
  afterUnseal.auditHasUnseal === true &&
  afterUnseal.exportBtnCount === 0 &&                // export button absent
  afterUnseal.exportNotePresent === true &&
  afterUnseal.auditHasExport === false &&            // and no raw-export logged
  afterReload.recordingsHidden === false &&
  afterReload.recordingRows >= 1 &&
  afterWatch.playbackHidden === false &&
  afterWatch.downloadHidden === true &&
  // Scenario 2 — manual Spain: storage-level raw-never-kept
  esLoad.location === 'Spain (ES)' &&
  /not kept/.test(esLoad.rawPill) &&
  /Sound: off/.test(esLoad.audioPill) &&
  esDuring.noticeHidden === false &&
  esDuring.noticeText.length > 0 &&
  /off \(privacy rules\)/.test(esDuring.soundPill) &&
  esStop.rawRecorderStarted === false &&
  esStop.records.length === 1 &&
  esStop.records[0].rawIsNull === true &&
  esStop.records[0].hasBlurred === true &&
  esStop.records[0].policyProfileId === 'ES_STRICT' &&
  esStop.unsealBtnText === 'Original not kept' &&
  esStop.unsealBtnDisabled === true &&
  /not kept/.test(esStop.rawPill) &&
  // Scenario 3 — France: blocked
  frState.startDisabled === true &&
  frState.blockedHidden === false &&
  /Recording is not available at this location/.test(frState.blockedText) &&
  // Scenario 4 — GPS
  gpsState.location === 'Spain (ES)' &&
  gpsState.source === 'Automatic (GPS)' &&
  gpsState.confidence === 'High' &&
  /Spain/.test(gpsState.profileName) &&
  /not kept/.test(gpsState.rawPill) &&
  // Scenario 5 — fail-safe default + override
  failSafeLoad.source === 'Standard rules' &&
  /Restricted/.test(failSafeLoad.profileName) &&
  failSafeLoad.noteHidden === false &&
  /Location unavailable/.test(failSafeLoad.noteText) &&
  /not kept/.test(failSafeLoad.rawPill) &&
  failSafeLoad.startDisabled === false &&
  pickerState.pickerHidden === false &&
  pickerState.optionCount > 1 &&
  modalState.modalHidden === false &&
  modalState.confirmDisabledBefore === true &&
  modalState.changeCount > 0 &&
  confirmEnabled === true &&
  afterOverride.modalHidden === true &&
  afterOverride.bannerHidden === false &&
  /Override active — Singapore/.test(afterOverride.bannerText) &&
  afterOverride.source === 'Override' &&
  /kept locked/.test(afterOverride.rawPill) &&
  !!afterOverride.stored &&
  overrideDuring.chipHidden === false &&
  overrideStop.auditHasOverrideEnabled === true &&
  overrideStop.auditHasPolicyResolved === true &&
  overrideStop.overrideTag === true &&
  // Scenario 6 — facesAndBodies: person boxes are pixelated as extra regions
  /Faces and bodies/.test(bodiesLoad.blurRule) &&
  bodiesDuring.extraRegions >= 1 &&
  /detector: ok/.test(bodiesDuring.det) &&
  // Scenario 7 — the SW covers same-origin /core/data fetches from the page
  swState.controlled === true &&
  swState.cacheKeys.includes('dbcam-v0.14.0') &&
  swState.rulesetCached === true &&
  swState.rulesRows === 7 &&
  errors.length === 0 && errors2.length === 0 && errors3.length === 0 &&
  errors4.length === 0 && errors5.length === 0 && errors6.length === 0 &&
  errors7.length === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
