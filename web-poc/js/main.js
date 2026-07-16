// main.js
// Orchestration — wires every module and runs the single render loop.
//
// The loop implements the core PoC contract (§11.3 / §4):
//   raw frame (captureLayer)                         <- single camera, opened once
//     -> detect faces + animals (detection/MediaPipe)
//     -> blur faces onto the visible canvas (faceBlur, fail-safe)   <- preview is BLURRED
//     -> estimate animal approach -> deterrent + early incident
//     -> record the BLURRED canvas (recorder)
//   The raw <video> is never shown and never recorded.

import { CONFIG } from './config.js';
import { PolicyEngine } from './policyEngine.js';
import { CaptureLayer } from './captureLayer.js';
import { Detection } from './detection.js';
import { FaceBlur } from './faceBlur.js';
import { AnimalDeterrent } from './animalDeterrent.js';
import { DeterrentSound } from './deterrentSound.js';
import { IncidentDetector } from './incidentDetector.js';
import { Recorder } from './recorder.js';
import { SessionController } from './sessionController.js';
import { AuditLog } from './auditLog.js';
import { UI } from './ui.js';

const ui = new UI();

// Long-lived singletons.
const auditLog = new AuditLog();
const policy = new PolicyEngine(); // injectable stub; swap for GPS/manual resolver in Phase 7
const deterrentSound = new DeterrentSound();
const animalDeterrent = new AnimalDeterrent();

// Per-session objects (recreated on Start).
let capture = null;
let detection = null;
let faceBlur = null;
let incident = null;
let session = null;
let recorder = null;

let running = false;
let rafId = 0;
let frameCount = 0;
let lastFrameTs = 0;
let lastFaceResult = { boxes: [], maxScore: 0 };
let lastAnimals = [];

ui.onSensitivity((v) => animalDeterrent.setSensitivity(v));
ui.setStatus('Idle. Press Start to request camera + mic.');
ui.showProfile(policy.getProfile());

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
  incident.trigger('manual', performance.now());
});

async function start() {
  ui.setRunning(true);
  ui.setStatus('Resolving policy profile…');

  // §7: capture behavior is read from the policy profile, not hard-coded.
  const profile = await policy.resolveForSession();
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

  // Record the BLURRED canvas; audio track only if the profile allows it.
  recorder = new Recorder(ui.el.preview);
  const audioTrack = profile.audioEnabled ? capture.getAudioTrack() : null;
  recorder.start(audioTrack);

  // Reset per-session animal/deterrent state.
  animalDeterrent.reset();

  running = true;
  frameCount = 0;
  lastFrameTs = performance.now();
  ui.el.playback.hidden = true;
  ui.setStatus(`Recording ${info.width}×${info.height}. Preview is BLURRED.`);
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

  // --- Animal approach -> deterrent + early incident sealing ---
  const approach = animalDeterrent.update(lastAnimals, capture.width, capture.height, now);
  if (approach.approaching) {
    if (deterrentSound.canPlay(now)) {
      deterrentSound.play(now);
      auditLog.append('deterrent-fired', { label: approach.animal.label }, now);
    }
    // Early trigger: seal the buildup before contact (§2.2).
    incident.trigger('animal-approach', now, {
      label: approach.animal.label,
      areaFrac: Number(approach.areaFrac.toFixed(3)),
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
    approach,
  });
  ui.updateFps(dt);
  ui.setWake(session.hasWakeLock());

  rafId = requestAnimationFrame(loop);
}

async function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  ui.setStatus('Finalizing recording…');

  let result = null;
  try { result = recorder ? await recorder.stop() : null; } catch (e) { console.error(e); }
  try { await session.stop(performance.now()); } catch (e) { console.error(e); }
  if (detection) detection.close();
  if (capture) capture.stop();
  ui.clearOverlay();
  ui.setWake(false);
  ui.setRunning(false);

  if (result) {
    ui.showPlayback(result.url, result.mimeType);
    ui.setStatus('Session stopped. Blurred recording ready below.');
  } else {
    ui.setStatus('Session stopped. (No recording produced.)');
  }
}
