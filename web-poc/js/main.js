// main.js
// Orchestration — wires every module and runs the single render loop.
//
// The loop implements the core PoC contract (§1, §4, §11.3):
//   raw frame (captureLayer)                         <- single camera, opened once
//     -> detect faces + animals (detection/MediaPipe)
//     -> pixelate faces onto the visible canvas (faceBlur, fail-safe)  <- preview is BLURRED
//     -> estimate animal approach -> deterrent + early incident
//     -> record the BLURRED canvas (default, freely viewable)
//   In parallel, when the policy profile is `raw-sealed`, the UNBLURRED camera feed
//   is recorded continuously ("raw exists but is sealed", §1). It is NEVER shown live;
//   after Stop, each incident becomes a sealed segment that requires authorized unseal
//   (Evidence Sealer + Store + Review UI + Audit Log).

import { CONFIG } from './config.js';
import { PolicyEngine, listRegions } from './policyEngine.js';
import { CaptureLayer } from './captureLayer.js';
import { Detection } from './detection.js';
import { FaceBlur } from './faceBlur.js';
import { AnimalDeterrent } from './animalDeterrent.js';
import { DeterrentSound } from './deterrentSound.js';
import { VoiceTrigger } from './voiceTrigger.js';
import { AudioMonitor } from './audioMonitor.js';
import { IncidentDetector } from './incidentDetector.js';
import { Recorder } from './recorder.js';
import { EvidenceStore } from './evidenceStore.js';
import { SessionController } from './sessionController.js';
import { AuditLog } from './auditLog.js';
import { saveSession, listSessions, getSession, deleteSession, purgeOlderThan } from './storageStore.js';
import { UI } from './ui.js';
import { buildManifest, summarize } from '../../core/src/capabilities.js';

// Offline support (self-contained after first load; ARCHITECTURE §0).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// WEB capability report (ARCHITECTURE §5) — honest about this platform's limits.
const CAPABILITIES = buildManifest({
  camera: { supported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) },
  faceDetection: { supported: true },
  animalDetection: { supported: true },
  audioMonitor: { supported: !!(window.AudioContext || window.webkitAudioContext) },
  voiceTrigger: {
    supported: VoiceTrigger.isSupported(),
    selfContained: false, // Web Speech API routes audio to vendor servers
    reason: VoiceTrigger.isSupported() ? 'Web Speech API uses vendor servers' : 'API unavailable',
  },
  deterrent: { supported: !!(window.AudioContext || window.webkitAudioContext) },
  rawRecording: { supported: !!window.MediaRecorder },
  secureSealing: { supported: false, reason: 'no hardware keystore in the browser' },
  backgroundSafe: { supported: false, reason: 'browser suspends hidden tabs' },
});

const ui = new UI();

// Long-lived singletons.
const auditLog = new AuditLog();
const policy = new PolicyEngine(); // resolves from the Core region table; defaults to the 'unknown' fail-safe
const deterrentSound = new DeterrentSound();
const animalDeterrent = new AnimalDeterrent();
const audioMonitor = new AudioMonitor();
const voice = new VoiceTrigger();
const VOICE_LS = 'dbcam.voice';

// Per-session objects (recreated on Start).
let capture = null;
let detection = null;
let faceBlur = null;
let incident = null;
let session = null;
let blurredRecorder = null;
let rawRecorder = null;
let evidence = null;
let recorderStartMs = 0;
let sessionStartMs = 0;
let activeProfile = null;

let running = false;
let rafId = 0;
let frameCount = 0;
let lastFrameTs = 0;
let lastFaceResult = { boxes: [], maxScore: 0, ok: false };
let lastAnimals = [];

ui.onSensitivity((v) => animalDeterrent.setSensitivity(v));
ui.setVersion(CONFIG.version);
ui.setStatus('Ready. Tap the red button to start.');

// §7 region selection — restore the user's pick; with nothing stored the Core
// fails safe to the strictest rules ('unknown'). The rules themselves live in
// the Core policy table — this file only stores and forwards the chosen id.
const REGION_LS = 'dbcam.region';
const REGION_HINT_LS = 'dbcam.regionHintDismissed';
let storedRegion = null;
try { storedRegion = JSON.parse(localStorage.getItem(REGION_LS)); } catch (_e) {}
policy.setRegion(typeof storedRegion === 'string' ? storedRegion : 'unknown');
ui.populateRegions(listRegions(), policy.getProfile().regionId);
ui.showProfile(policy.getProfile());

// First-run nudge: shown until a region is chosen or the tip is dismissed.
let regionHintDismissed = false;
try { regionHintDismissed = localStorage.getItem(REGION_HINT_LS) === '1'; } catch (_e) {}
ui.showRegionHint(!storedRegion && !regionHintDismissed);
ui.onRegionHintClose(() => {
  ui.showRegionHint(false);
  try { localStorage.setItem(REGION_HINT_LS, '1'); } catch (_e) {}
});

ui.onRegionChange((regionId) => {
  const profile = policy.setRegion(regionId);
  try { localStorage.setItem(REGION_LS, JSON.stringify(profile.regionId)); } catch (_e) {}
  ui.showProfile(profile);
  ui.showRegionHint(false);
  // A live session keeps the rules it started with — the new rules apply next time.
  if (running) ui.setStatus('Privacy rules will apply from the next recording.');
});

// Saved recordings: enforce the ACTIVE profile's retention rule (the number
// lives in the Core policy profile, not here), then show what's kept.
(async () => {
  try { await purgeOlderThan(policy.getProfile().retentionSeconds * 1000); } catch (_e) {}
  await refreshRecordings();
})();

// Restore voice-trigger settings and reflect availability.
try { ui.setVoiceConfig(JSON.parse(localStorage.getItem(VOICE_LS) || '{}')); } catch (_e) {}
ui.onVoiceChange(() => applyVoice());
applyVoice(); // sets initial status (off / ready / unsupported)

/** Start/stop/refresh the voice keyword listener based on settings + session state. */
function applyVoice() {
  const cfg = ui.getVoiceConfig();
  try { localStorage.setItem(VOICE_LS, JSON.stringify(cfg)); } catch (_e) {}

  if (!VoiceTrigger.isSupported()) { ui.setVoiceStatus('unsupported'); return; }
  voice.stop();
  if (running && cfg.enabled && cfg.word) {
    voice.start(cfg.word, {
      onTrigger: () => {
        if (!running || !incident) return;
        ui.flashVoiceHeard();
        // Same effect as a hostile-animal event: seal + sound the deterrent.
        fireEvent('voice', performance.now());
      },
      onStatus: (s) => ui.setVoiceStatus(s),
    });
  } else {
    ui.setVoiceStatus(cfg.enabled ? (running ? 'starting…' : 'ready') : 'off');
  }
}

ui.onStart(async () => {
  try {
    await start();
  } catch (err) {
    console.error(err);
    ui.setStatus(`Error: ${err.message}`);
    ui.setRunning(false);
  }
});

ui.onStop(async () => { await stop(); });

ui.onEvent(() => {
  if (!running || !incident) return;
  // Manual "Event" button — the non-negotiable hard override into evidence mode.
  // The preview stays blurred; this seals the raw incident window AND sounds the
  // deterrent, the same effect as a detected hostile animal.
  fireEvent('manual', performance.now());
});

/**
 * Fire an incident AND sound the deterrent alarm — the shared effect of any
 * "event" trigger (manual button, voice word, hostile animal). Deterrent respects
 * its own cooldown so rapid re-triggers don't blast repeatedly.
 */
function fireEvent(reason, nowMs, detail = {}) {
  if (!running || !incident) return;
  incident.trigger(reason, nowMs, detail);
  if (deterrentSound.canPlay(nowMs)) {
    deterrentSound.play(nowMs);
    audioMonitor.notifyDeterrent(nowMs);
    auditLog.append('deterrent-fired', { reason, ...detail }, nowMs);
  }
}

async function start() {
  ui.setRunning(true);
  ui.setStatus('Getting ready…');

  // §7: capture behavior is read from the policy profile, not hard-coded.
  const profile = await policy.resolveForSession();
  activeProfile = profile;
  ui.showProfile(profile);

  // Prime the audio context from this user gesture (autoplay policy).
  deterrentSound.ensureContext();

  ui.setStatus('Turning on the camera…');
  capture = new CaptureLayer();
  const info = await capture.start(profile.audioEnabled);
  ui.sizeCanvases(info.width, info.height);

  faceBlur = new FaceBlur(ui.el.preview);
  faceBlur.resize(info.width, info.height);

  ui.setStatus('Loading the privacy filter…');
  detection = new Detection();
  await detection.init();

  session = new SessionController({ auditLog });
  await session.start(performance.now());
  // Record this platform's capability manifest with the session (auditable honesty).
  auditLog.append('capabilities', summarize(CAPABILITIES), performance.now());
  // Record which policy governed this session (§7): region + ruleset version.
  auditLog.append(
    'policy-resolved',
    { regionId: profile.regionId, rawMode: profile.rawMode, version: profile.version },
    performance.now(),
  );
  ui.setWake(session.hasWakeLock());

  incident = new IncidentDetector({
    auditLog,
    onIncident: (inc) => {
      ui.showIncident(true, inc.reason);
      ui.setIncidentCount(incident.count());
    },
  });

  evidence = new EvidenceStore({ auditLog });
  evidence.setRawMode(profile.rawMode);

  // Reset review UI from any prior session.
  ui.el.reviewHeader.hidden = true;
  ui.el.playback.hidden = true;
  ui.el.evidence.hidden = true;
  ui.el.auditSection.hidden = true;
  ui.closeRawPlayer();
  ui.setSessionState('recording');
  sessionStartMs = performance.now();
  ui.setRecTimer(0);

  // Recorders. Blurred default = the canvas. Raw sealed evidence = the camera track
  // itself, recorded only when the policy permits retaining raw (§7).
  const audioTrack = profile.audioEnabled ? capture.getAudioTrack() : null;
  blurredRecorder = new Recorder({ canvas: ui.el.preview });
  rawRecorder = null;
  if (profile.rawMode === 'raw-sealed') {
    const rawVideoTrack = capture.stream.getVideoTracks()[0];
    rawRecorder = new Recorder({ stream: new MediaStream([rawVideoTrack]) });
  }

  // Audio goes to the sealed evidence when raw is retained (voices are sensitive);
  // otherwise it rides on the blurred default so it isn't lost.
  recorderStartMs = performance.now();
  if (rawRecorder) {
    rawRecorder.start(audioTrack);
    blurredRecorder.start(null);
  } else {
    blurredRecorder.start(audioTrack);
  }

  animalDeterrent.reset();
  // Aggressive-sound detector taps the mic (only when the policy allows audio).
  audioMonitor.start(profile.audioEnabled ? capture.getAudioTrack() : null);

  running = true;
  applyVoice(); // begin listening for the trigger word if enabled
  frameCount = 0;
  lastFrameTs = performance.now();
  const rawNote = rawRecorder
    ? 'the original is kept locked in the background'
    : 'the original is not kept';
  ui.setStatus(`Recording — faces are hidden; ${rawNote}.`);
  rafId = requestAnimationFrame(loop);
}

function loop() {
  if (!running) return;
  const now = performance.now();
  const dt = now - lastFrameTs;
  lastFrameTs = now;
  frameCount++;

  const video = capture.video;
  if (!video || video.readyState < 2) {
    rafId = requestAnimationFrame(loop);
    return;
  }

  // Guard: camera track ended (unplugged / seized) -> mark a gap.
  const vtrack = capture.stream && capture.stream.getVideoTracks()[0];
  if (vtrack && vtrack.readyState === 'ended') {
    session.markCameraLost(now);
    stop();
    return;
  }

  // --- Detection (throttled independently to protect framerate) ---
  if (frameCount % CONFIG.detection.faceEveryN === 0) {
    lastFaceResult = detection.detectFaces(video, now);
  }
  if (frameCount % CONFIG.detection.animalEveryN === 0) {
    lastAnimals = detection.detectAnimals(video, now);
  }

  // --- Blur render (fail-safe) -> visible canvas ---
  const blurInfo = faceBlur.render(video, lastFaceResult, now);

  // --- Animal threat (vision + sound) -> deterrent + early incident sealing ---
  const audioLevel = audioMonitor.getLevel(now);
  ui.setSoundLevel(audioLevel);
  const threat = animalDeterrent.update(lastAnimals, capture.width, capture.height, now, audioLevel);
  if (threat.hostile) {
    // Early trigger: seal the buildup before contact (§2.2) + sound the deterrent.
    fireEvent('hostile-animal', now, {
      label: threat.animal.label,
      threatScore: Number(threat.threatScore.toFixed(2)),
      reasons: threat.reasons,
    });
  }
  const cd = deterrentSound.cooldownRemainingMs(now);
  ui.setDeterrent(cd > 0 ? `deterrent: cooldown ${(cd / 1000).toFixed(1)}s` : 'deterrent: ready');

  // --- Incident window bookkeeping ---
  const incidentActive = incident.tick(now);
  if (!incidentActive) ui.showIncident(false);

  // --- Debug overlay + FPS (does not touch the recorded frames) ---
  ui.drawOverlay({
    faces: lastFaceResult.boxes,
    animals: lastAnimals,
    overBlurred: blurInfo.overBlurred,
    threat,
  });
  ui.setDetectorStatus({
    ok: lastFaceResult.ok,
    faces: lastFaceResult.boxes.length,
    overBlurred: blurInfo.overBlurred,
  });
  ui.updateFps(dt);
  ui.setRecTimer(now - sessionStartMs);
  ui.setWake(session.hasWakeLock());

  rafId = requestAnimationFrame(loop);
}

async function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  ui.setStatus('Saving your video…');

  const stopMs = performance.now();
  voice.stop();
  applyVoice(); // reset voice status to ready/off now that we're idle
  audioMonitor.stop();
  if (incident) incident.finalize(stopMs);

  let blurredResult = null;
  let rawResult = null;
  try { blurredResult = blurredRecorder ? await blurredRecorder.stop() : null; } catch (e) { console.error(e); }
  try { rawResult = rawRecorder ? await rawRecorder.stop() : null; } catch (e) { console.error(e); }
  try { await session.stop(stopMs); } catch (e) { console.error(e); }
  if (detection) detection.close();
  if (capture) capture.stop();
  ui.clearOverlay();
  ui.setWake(false);
  ui.setRunning(false);

  // Blurred default playback.
  if (blurredResult) ui.showPlayback(blurredResult.url, blurredResult.mimeType);

  // Sealed evidence review.
  evidence.setBlurred(blurredResult);
  evidence.setRaw(rawResult);
  const segments = evidence.buildSegments(incident.incidents, recorderStartMs, stopMs);
  ui.renderEvidence(segments, {
    hasRaw: evidence.hasRaw(),
    prerollSeconds: CONFIG.incident.prerollSeconds,
    onUnseal: makeUnsealHandler({
      store: evidence,
      renderAudit: () => ui.renderAuditLog(auditLog.toJSON()),
    }),
  });
  ui.renderAuditLog(auditLog.toJSON());

  const n = incident.count();
  ui.setSessionState(blurredResult ? 'review' : 'idle');
  if (!blurredResult) {
    ui.setStatus('Stopped. (No video was saved.)');
  } else if (n === 0) {
    ui.setStatus('Done — your video is ready below. No alerts this time.');
  } else {
    ui.setStatus(
      `Done — your video is ready below. ${n} alert${n === 1 ? '' : 's'} ` +
      `${evidence.hasRaw() ? 'kept safely (unlock below to view)' : 'noted'}.`,
    );
  }

  // Persist the finished session on this device so it survives a reload
  // (auto-deleted later by the profile's retention rule). Segments are stored
  // locked — unlock state never persists.
  if (blurredResult) {
    try {
      await saveSession({
        createdAt: Date.now(),
        durationMs: Math.max(0, Math.round(stopMs - sessionStartMs)),
        alertsCount: n,
        version: CONFIG.version,
        profile: { jurisdiction: activeProfile.jurisdiction, rawMode: activeProfile.rawMode },
        blurred: { blob: blurredResult.blob, mimeType: blurredResult.mimeType },
        raw: rawResult ? { blob: rawResult.blob, mimeType: rawResult.mimeType } : null,
        segments,
        auditEntries: auditLog.toJSON().map((e) => ({ ...e })),
      });
      await refreshRecordings();
    } catch (err) {
      console.error(err);
      ui.setStatus("Could not save to this device's storage.");
    }
  }
}

/**
 * Shared unlock-to-view handler for the evidence list (§6 rules live in the
 * Core ledger; this wires confirm dialog -> unseal -> clamped playback -> export).
 * Used by both the live session review and the saved-recording review.
 * @param {{store: EvidenceStore, renderAudit: ()=>void, afterChange?: ()=>Promise<void>}} deps
 */
function makeUnsealHandler({ store, renderAudit, afterChange }) {
  return async (seg, rowEl) => {
    const ok = window.confirm(
      `Unlock Alert ${seg.index} (${ui.formatReasons(seg.reasons)})?\n\n` +
      'The original video with faces visible will play. This is noted in the activity log.',
    );
    if (!ok) return;
    const win = await store.unseal(seg, performance.now());
    if (!win) return;
    ui.markSegmentUnsealed(rowEl);
    // Export is only offered once unsealed; every export is audit-logged (§6).
    ui.addExportButton(rowEl, async () => {
      const exp = await store.exportRaw(seg, performance.now());
      if (!exp) return;
      const a = document.createElement('a');
      a.href = exp.url;
      a.download = exp.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      renderAudit();
      if (afterChange) await afterChange();
    });
    ui.playRawWindow(win.url, win.startSec, win.endSec, `Alert ${seg.index} — ${ui.formatReasons(seg.reasons)}`);
    renderAudit();
    if (afterChange) await afterChange();
  };
}

// ===== Saved recordings ("My recordings") =====

let watchUrls = []; // object URLs created for the recording being watched

/** Re-read the saved-sessions list and (re)render the "My recordings" section. */
async function refreshRecordings() {
  try {
    const items = await listSessions();
    ui.renderRecordings(items, {
      onWatch: (item) => { watchRecording(item.id).catch((e) => console.error(e)); },
      onDelete: async (item) => {
        const ok = window.confirm(
          'Delete this recording?\n\nIt will be removed from this device and cannot be brought back.',
        );
        if (!ok) return;
        try {
          await deleteSession(item.id);
          await refreshRecordings();
        } catch (e) { console.error(e); }
      },
    });
  } catch (e) {
    console.error(e);
  }
}

/**
 * Load a saved session into the existing review UI. Every watch starts with all
 * alerts LOCKED again (unlock state is never persisted — by design); unlocking
 * or exporting during this review is appended to the recording's activity log
 * and saved back to the device.
 */
async function watchRecording(id) {
  if (running) return; // never disturb a live session
  const rec = await getSession(id);
  if (!rec) { await refreshRecordings(); return; }

  ui.closeRawPlayer();
  for (const u of watchUrls) URL.revokeObjectURL(u);
  watchUrls = [];

  // Recreate playable URLs from the stored blobs.
  const blurred = rec.blurred ? { blob: rec.blurred.blob, mimeType: rec.blurred.mimeType, url: URL.createObjectURL(rec.blurred.blob) } : null;
  const raw = rec.raw ? { blob: rec.raw.blob, mimeType: rec.raw.mimeType, url: URL.createObjectURL(rec.raw.blob) } : null;
  if (blurred) watchUrls.push(blurred.url);
  if (raw) watchUrls.push(raw.url);

  // Review audit copy: a fresh adapter whose chain CONTINUES from the stored
  // entries (same seq/prevHash lineage), so review-time unlocks/exports append
  // to this recording's log without touching the live session's log.
  const baseEntries = (rec.auditEntries || []).map((e) => ({ ...e }));
  const reviewAudit = new AuditLog();
  const lastEntry = baseEntries[baseEntries.length - 1];
  if (lastEntry) { reviewAudit._seq = lastEntry.seq; reviewAudit._lastHash = lastEntry.hash; }

  const store = new EvidenceStore({ auditLog: reviewAudit });
  store.setRawMode(rec.profile.rawMode);
  store.setBlurred(blurred);
  store.setRaw(raw);
  // Segments start locked again every time — by design.
  const segments = (rec.segments || []).map((s) => ({ ...s, unsealed: false }));
  store.ledger.segments = segments;

  const renderAudit = () => ui.renderAuditLog(baseEntries.concat(reviewAudit.toJSON()));
  const persist = async () => {
    try {
      rec.auditEntries = baseEntries.concat(reviewAudit.toJSON()).map((e) => ({ ...e }));
      rec.segments = segments; // stored locked again by saveSession
      await saveSession(rec);
    } catch (e) { console.error(e); }
  };

  if (blurred) ui.showPlayback(blurred.url, blurred.mimeType);
  ui.renderEvidence(segments, {
    hasRaw: store.hasRaw(),
    prerollSeconds: CONFIG.incident.prerollSeconds,
    onUnseal: makeUnsealHandler({ store, renderAudit, afterChange: persist }),
  });
  renderAudit();
  ui.setSessionState('review');
  ui.setStatus('Showing a saved recording — it is below.');
  ui.el.reviewHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
