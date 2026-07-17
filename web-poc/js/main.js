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
import { PolicyEngine } from './policyEngine.js';
import { CaptureLayer } from './captureLayer.js';
import { Detection } from './detection.js';
import { FaceBlur } from './faceBlur.js';
import { AnimalDeterrent } from './animalDeterrent.js';
import { DeterrentSound } from './deterrentSound.js';
import { VoiceTrigger } from './voiceTrigger.js';
import { IncidentDetector } from './incidentDetector.js';
import { Recorder } from './recorder.js';
import { EvidenceStore } from './evidenceStore.js';
import { SessionController } from './sessionController.js';
import { AuditLog } from './auditLog.js';
import { UI } from './ui.js';

const ui = new UI();

// Long-lived singletons.
const auditLog = new AuditLog();
const policy = new PolicyEngine(); // injectable stub; swap for GPS/manual resolver in Phase 7
const deterrentSound = new DeterrentSound();
const animalDeterrent = new AnimalDeterrent();
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
ui.setStatus('Idle. Press Start to request camera + mic.');
ui.showProfile(policy.getProfile());

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
        incident.trigger('voice', performance.now());
        ui.flashVoiceHeard();
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
  // The preview stays blurred; this seals the raw incident window for later review.
  incident.trigger('manual', performance.now());
});

async function start() {
  ui.setRunning(true);
  ui.setStatus('Resolving policy profile…');

  // §7: capture behavior is read from the policy profile, not hard-coded.
  const profile = await policy.resolveForSession();
  activeProfile = profile;
  ui.showProfile(profile);

  // Prime the audio context from this user gesture (autoplay policy).
  deterrentSound.ensureContext();

  ui.setStatus('Requesting camera…');
  capture = new CaptureLayer();
  const info = await capture.start(profile.audioEnabled);
  ui.sizeCanvases(info.width, info.height);

  faceBlur = new FaceBlur(ui.el.preview);
  faceBlur.resize(info.width, info.height);

  ui.setStatus('Loading on-device models (MediaPipe)…');
  detection = new Detection();
  await detection.init();

  session = new SessionController({ auditLog });
  await session.start(performance.now());
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

  running = true;
  applyVoice(); // begin listening for the trigger word if enabled
  frameCount = 0;
  lastFrameTs = performance.now();
  const rawNote = rawRecorder ? 'raw sealed in background' : 'blur-at-capture (no raw)';
  ui.setStatus(`Recording ${info.width}×${info.height}. Preview is BLURRED · ${rawNote}.`);
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

  // --- Animal threat -> deterrent + early incident sealing ---
  const threat = animalDeterrent.update(lastAnimals, capture.width, capture.height, now);
  if (threat.hostile) {
    if (deterrentSound.canPlay(now)) {
      deterrentSound.play(now);
      auditLog.append('deterrent-fired', { label: threat.animal.label, threat: Number(threat.threatScore.toFixed(2)) }, now);
    }
    // Early trigger: seal the buildup before contact (§2.2).
    incident.trigger('hostile-animal', now, {
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
  ui.setStatus('Finalizing recordings…');

  const stopMs = performance.now();
  voice.stop();
  applyVoice(); // reset voice status to ready/off now that we're idle
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
    onUnseal: async (seg, rowEl) => {
      const ok = window.confirm(
        `Authorize unsealing Incident ${seg.index} (${seg.reasons.join(', ')})?\n\n` +
        'In production this needs approver / split-key authorization. This action is written to the audit log.',
      );
      if (!ok) return;
      const win = await evidence.unseal(seg, performance.now());
      if (!win) return;
      ui.markSegmentUnsealed(rowEl);
      ui.playRawWindow(win.url, win.startSec, win.endSec, `Incident ${seg.index} — ${seg.reasons.join(', ')}`);
      ui.renderAuditLog(auditLog.toJSON());
    },
  });
  ui.renderAuditLog(auditLog.toJSON());

  const n = incident.count();
  ui.setSessionState(blurredResult ? 'review' : 'idle');
  ui.setStatus(
    `Session stopped. Blurred recording ready · ${n} incident${n === 1 ? '' : 's'} ` +
    `${evidence.hasRaw() ? 'sealed (authorize to view raw)' : 'flagged (policy: no raw retained)'}.`,
  );
}
