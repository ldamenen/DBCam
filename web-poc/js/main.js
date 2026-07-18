// main.js
// Orchestration — wires every module and runs the single render loop.
//
// The loop implements the core PoC contract (§1, §4, §11.3):
//   raw frame (captureLayer)                         <- single camera, opened once
//     -> detect faces + animals (detection/MediaPipe)
//     -> pixelate faces onto the visible canvas (faceBlur, fail-safe)  <- preview is BLURRED
//     -> estimate animal approach -> deterrent + early incident
//     -> record the BLURRED canvas (default, freely viewable)
//   In parallel, when the policy profile keeps raw sealed, the UNBLURRED camera
//   feed is recorded continuously ("raw exists but is sealed", §1). It is NEVER
//   shown live; after Stop, each incident becomes a sealed segment that requires
//   authorized unseal (Evidence Sealer + Store + Review UI + Audit Log).
//
// §6/§7 Jurisdiction policy: the Core PolicyEngine v2 resolves the governing
// profile (admin pin > user override > GPS > manual choice > fail-safe default).
// This file is a THIN ADAPTER: it loads the bundled ruleset/geo data, forwards
// location fixes and user choices, and mechanically obeys the resolved profile.
// No thresholds, no rules, no per-jurisdiction strings live here.

import { CONFIG } from './config.js';
import { PolicyEngine, compareStrictness, OVERRIDE_TTL_MS } from './policyEngine.js';
import { CaptureLayer } from './captureLayer.js';
import { Detection } from './detection.js';
import { FaceBlur } from './faceBlur.js';
import { AnimalDeterrent } from './animalDeterrent.js';
import { DeterrentSound } from './deterrentSound.js';
import { VoiceTrigger } from './voiceTrigger.js';
import { MotionSensor } from './motionSensor.js';
import { MotionDetector } from '../../core/src/motion.js';
import { AudioMonitor } from './audioMonitor.js';
import { IncidentDetector } from './incidentDetector.js';
import { Recorder } from './recorder.js';
import { EvidenceStore } from './evidenceStore.js';
import { SessionController } from './sessionController.js';
import { AuditLog } from './auditLog.js';
import { saveSession, listSessions, getSession, deleteSession, purgeOlderThan } from './storageStore.js';
import { UI, describePolicyChange } from './ui.js';
import { buildManifest, summarize } from '../../core/src/capabilities.js';

// Offline support (self-contained after first load; ARCHITECTURE §0).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Debug hooks for the smoke tests (assert on storage/behavior, not intent).
window.__dbcamDebug = { rawRecorderStarted: false, policyReady: false };

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
  motionSensor: { supported: MotionSensor.isSupported() },
  location: { supported: 'geolocation' in navigator },
  rawRecording: { supported: !!window.MediaRecorder },
  secureSealing: { supported: false, reason: 'no hardware keystore in the browser' },
  backgroundSafe: { supported: false, reason: 'browser suspends hidden tabs' },
});

const ui = new UI();

// Long-lived singletons.
const auditLog = new AuditLog();
const engine = new PolicyEngine(); // governs on its built-in fail-safe until the ruleset loads
const deterrentSound = new DeterrentSound();
const animalDeterrent = new AnimalDeterrent();
const audioMonitor = new AudioMonitor();
const voice = new VoiceTrigger();
const VOICE_LS = 'dbcam.voice';
const motionSensor = new MotionSensor();
const MOTION_LS = 'dbcam.motion';
let motionDetector = null; // session-scoped Core detector (recreated on Start)

// §6 policy persistence keys.
const LOCMODE_LS = 'dbcam.locationMode';
const MANUAL_LS = 'dbcam.manualJurisdiction';
const OVERRIDE_SS = 'dbcam.override'; // sessionStorage: override dies with the app
const DATA_BASE = './../core/data/'; // relative to /web-poc/ -> /core/data/

// Policy state (all DECISIONS live in the Core engine; this is display/wiring state).
let locationMode = 'auto';
let manualJurisdiction = null;
let locationUnavailable = false; // geolocation denied/unavailable in auto mode
let usingBuiltInRules = false;   // ruleset fetch/load failed -> engine failsafe
let overrideUiOpen = false;      // the override toggle is on (picker visible)
let currentResolved = null;      // last ResolvedPolicy render (idle display)
let blockedStatusShown = false;  // status line currently shows the blocked message

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
let activePolicy = null;       // the CURRENT governing ResolvedPolicy (may tighten mid-session)
let sessionStartPolicy = null; // the snapshot taken at Start (saved with the recording)
let policyChanges = [];        // [{tMs, fromProfileId, toProfileId}] segment-boundary markers
let audioMonitorOn = false;

let running = false;
let rafId = 0;
let frameCount = 0;
let lastFrameTs = 0;
let lastFaceResult = { boxes: [], maxScore: 0, ok: false };
let lastAnimals = [];
let lastPersons = [];

const nowIso = () => new Date().toISOString();
const rawModeFor = (profile) => (profile.rawRetention === 'sealed' ? 'raw-sealed' : 'blur-at-capture');

ui.onSensitivity((v) => animalDeterrent.setSensitivity(v));
ui.setVersion(CONFIG.version);
ui.setStatus('Ready. Tap the red button to start.');

// ===== §6 Jurisdiction policy layer =====

/** Drain the engine's queued events into the audit log, verbatim. */
function drainPolicyEvents() {
  const events = engine.takeEvents();
  const t = performance.now();
  for (const ev of events) {
    const { type, ...detail } = ev;
    auditLog.append(type, detail, t);
    if (
      type === 'override-expired' ||
      type === 'override-invalidated-jurisdiction-change' ||
      type === 'override-invalidated-ruleset-change'
    ) {
      try { sessionStorage.removeItem(OVERRIDE_SS); } catch (_e) {}
    }
  }
  return events;
}

const SOURCE_LABELS = {
  gps: 'Automatic (GPS)',
  manualSelection: 'Chosen manually',
  userOverride: 'Override',
  adminConfig: 'Organisation setting',
  default: 'Standard rules',
};
const CONFIDENCE_LABELS = { high: 'High', low: 'Low', unknown: 'Unknown' };

/** "Spain (ES)" from a jurisdiction code, purely from engine data. */
function jurisdictionLabel(code) {
  if (!code) return 'Unknown';
  const j = engine.listJurisdictions().find((x) => x.code === code);
  return j ? `${j.displayName} (${j.code})` : code;
}

function rulesetLine() {
  const info = engine.getRulesetInfo();
  const updated = info.updatedAt ? new Date(info.updatedAt).toLocaleDateString() : '—';
  return `Rules version ${info.version} · updated ${updated} · ${info.authoredBy || '—'}`;
}

function fmtRemaining(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Re-render everything policy-related from the engine's current resolution. */
function renderPolicy() {
  const t = performance.now();
  const resolved = engine.getResolved({ nowMs: t, nowIso: nowIso() });
  currentResolved = resolved;
  const p = resolved.profile;

  let note = null;
  if (usingBuiltInRules) note = 'Using built-in safety rules';
  else if (locationMode === 'auto' && locationUnavailable) note = 'Location unavailable — using strictest rules';

  ui.renderPolicyStatus({
    locationLabel: jurisdictionLabel(resolved.jurisdictionCode),
    profileName: p.displayName,
    sourceLabel: SOURCE_LABELS[resolved.source] || resolved.source,
    confidenceLabel: CONFIDENCE_LABELS[resolved.confidence] || resolved.confidence,
    note,
  });
  ui.showBlockedCard(p.recordingAllowed ? null : p.displayName);
  ui.setRecordingAllowed(p.recordingAllowed);
  ui.renderRulesList(p);
  ui.renderWhyRules(p, rulesetLine());
  ui.setRulesetInfo(rulesetLine());

  // Idle pills reflect the live resolution; during a session they show the
  // session's own (possibly tightened) snapshot instead.
  if (!running) {
    ui.showProfile(p);
    ui.setVisibleIndicator(p.requiresVisibleIndicator);
    applyVoice();
    // Keep the status line honest when recording is blocked here.
    if (!p.recordingAllowed && !blockedStatusShown) {
      ui.setStatus('Recording is not available at this location.');
      blockedStatusShown = true;
    } else if (p.recordingAllowed && blockedStatusShown) {
      ui.setStatus('Ready. Tap the red button to start.');
      blockedStatusShown = false;
    }
  }

  const st = engine.getOverrideStatus({ nowMs: t });
  if (st.active) {
    const prof = engine.getProfileById(st.profileId);
    const name = prof ? prof.displayName : st.profileId;
    ui.showOverrideBanner(`Override active — ${name} · expires in ${fmtRemaining(st.remainingMs)}`);
    ui.setOverrideChecked(true);
    ui.showOverridePicker(true);
  } else {
    ui.showOverrideBanner(null);
    ui.setOverrideChecked(overrideUiOpen);
    ui.showOverridePicker(overrideUiOpen);
  }
}

/**
 * One GPS refresh (auto mode only). Denied/unavailable -> the engine simply
 * keeps fail-safing; we only reflect it in the status card.
 * @returns {Promise<boolean>} whether a fix was delivered to the engine
 */
function refreshLocation() {
  return new Promise((resolve) => {
    if (locationMode !== 'auto') return resolve(false);
    if (!('geolocation' in navigator)) { locationUnavailable = true; return resolve(false); }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locationUnavailable = false;
        engine.updateLocation({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          ageMs: 0,
          nowMs: performance.now(),
        });
        drainPolicyEvents();
        resolve(true);
      },
      () => { locationUnavailable = true; resolve(false); },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 },
    );
  });
}

function persistOverride(profileId, ackIso, jurisdictionCode) {
  try {
    sessionStorage.setItem(OVERRIDE_SS, JSON.stringify({
      profileId, ackIso, activatedAtEpochMs: Date.now(), jurisdictionCode,
    }));
  } catch (_e) {}
}

/** Re-apply a persisted override on load (or discard it if it aged out). */
function restoreOverride() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(OVERRIDE_SS)); } catch (_e) {}
  if (!saved || typeof saved.profileId !== 'string') return;
  const age = Date.now() - (saved.activatedAtEpochMs || 0);
  if (!Number.isFinite(age) || age < 0 || age >= OVERRIDE_TTL_MS) {
    try { sessionStorage.removeItem(OVERRIDE_SS); } catch (_e) {}
    auditLog.append('override-expired', { profileId: saved.profileId }, performance.now());
    return;
  }
  // Backdate the activation so the 24h expiry stays anchored to the ORIGINAL
  // activation time, not the reload time.
  const res = engine.confirmOverride(saved.profileId, {
    nowMs: performance.now() - age,
    ackIso: saved.ackIso || undefined,
  });
  drainPolicyEvents();
  if (res.ok) {
    overrideUiOpen = true;
    populateOverridePicker();
    auditLog.append('override-restored', {
      profileId: saved.profileId, ackIso: saved.ackIso || null, jurisdictionCode: saved.jurisdictionCode || null,
    }, performance.now());
  } else {
    try { sessionStorage.removeItem(OVERRIDE_SS); } catch (_e) {}
  }
}

/** Fill the override profile picker with strictness hints vs the auto profile. */
function populateOverridePicker() {
  const t = performance.now();
  const auto = engine.requestOverride('__probe__', { nowMs: t }).autoProfile;
  const options = engine.listProfiles().map((p) => {
    let hint;
    if (p.id === auto.id) hint = 'current rules';
    else {
      const cmp = compareStrictness(p, auto);
      hint = cmp < 0 ? 'stricter' : cmp > 0 ? 'less strict' : 'same strictness';
    }
    return { id: p.id, label: `${p.displayName} — ${hint}` };
  });
  const st = engine.getOverrideStatus({ nowMs: t });
  ui.populateOverrideProfiles(options, st.active ? st.profileId : null);
}

/** The user picked a profile in the override picker. */
function applyOverridePick(profileId) {
  const t = performance.now();
  const req = engine.requestOverride(profileId, { nowMs: t });

  if (req.tier === 'blocked') {
    ui.setOverrideMessage("The rules for this location can't be loosened here.");
    ui.resetOverridePick();
    return;
  }
  ui.setOverrideMessage(null);

  if (req.tier === 'tighten') {
    // Stricter than the location's own rules -> applies silently.
    const res = engine.confirmOverride(profileId, { nowMs: t });
    drainPolicyEvents();
    if (res.ok) {
      auditLog.append('override-enabled', {
        fromProfileId: req.autoProfile.id,
        toProfileId: profileId,
        jurisdictionCode: res.override.jurisdictionCodeAtActivation,
        ackIso: null,
      }, t);
      persistOverride(profileId, null, res.override.jurisdictionCodeAtActivation);
    }
    renderPolicy();
    return;
  }

  // tier 'loosen' -> explicit acknowledgment via the modal.
  const detectedCode = currentResolved ? currentResolved.jurisdictionCode : null;
  ui.openOverrideModal({
    contextLines: [
      `Where you are: ${jurisdictionLabel(detectedCode)}`,
      `Rules for this location: ${req.autoProfile.displayName}`,
      `Rules you're switching to: ${req.targetProfile.displayName}`,
    ],
    sentences: req.diff.map(describePolicyChange),
    onConfirm: () => {
      const t2 = performance.now();
      const ack = nowIso();
      const res = engine.confirmOverride(profileId, { nowMs: t2, ackIso: ack });
      drainPolicyEvents();
      if (res.ok) {
        auditLog.append('override-enabled', {
          fromProfileId: req.autoProfile.id,
          toProfileId: profileId,
          jurisdictionCode: res.override.jurisdictionCodeAtActivation,
          ackIso: ack,
        }, t2);
        persistOverride(profileId, ack, res.override.jurisdictionCodeAtActivation);
      } else {
        ui.setOverrideMessage("The override couldn't be turned on.");
        ui.resetOverridePick();
      }
      renderPolicy();
    },
    onCancel: () => { ui.resetOverridePick(); },
  });
}

/** User-initiated override off (toggle or banner button). */
function turnOffOverride() {
  const t = performance.now();
  const st = engine.getOverrideStatus({ nowMs: t });
  if (st.active) auditLog.append('override-disabled', { profileId: st.profileId }, t);
  engine.clearOverride(); // no engine event — user-initiated
  try { sessionStorage.removeItem(OVERRIDE_SS); } catch (_e) {}
  overrideUiOpen = false;
  ui.resetOverridePick();
  ui.setOverrideMessage(null);
  renderPolicy();
}

/** [Check for updates]: refetch the bundled ruleset with a cache-bust query. */
async function checkForUpdates() {
  ui.setRulesetMessage('Checking…');
  try {
    const res = await fetch(`${DATA_BASE}ruleset.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rs = await res.json();
    const out = engine.loadRuleset(rs);
    drainPolicyEvents();
    if (out.ok) {
      usingBuiltInRules = false;
      ui.populateJurisdictions(engine.listJurisdictions(), manualJurisdiction);
      ui.setRulesetMessage('You have the latest rules.');
    } else {
      ui.setRulesetMessage("The update couldn't be used — keeping the current rules.");
    }
  } catch (_e) {
    ui.setRulesetMessage("Couldn't check right now — try again later.");
  }
  renderPolicy();
}

// --- Settings wiring ---

ui.onLocationModeChange((mode) => {
  locationMode = mode;
  try { localStorage.setItem(LOCMODE_LS, mode); } catch (_e) {}
  engine.setLocationMode(mode);
  // In auto mode the engine must fail safe when GPS is unavailable — never
  // silently fall back to a stale manual choice.
  engine.setManualJurisdiction(mode === 'manual' ? manualJurisdiction : null);
  ui.setLocationMode(mode);
  drainPolicyEvents();
  renderPolicy();
  if (mode === 'auto') refreshLocation().then(() => renderPolicy());
});

ui.onJurisdictionChange((code) => {
  manualJurisdiction = code || null;
  try { localStorage.setItem(MANUAL_LS, manualJurisdiction || ''); } catch (_e) {}
  if (locationMode === 'manual') engine.setManualJurisdiction(manualJurisdiction);
  drainPolicyEvents();
  renderPolicy();
});

ui.onRefreshLocation(async () => {
  await refreshLocation();
  renderPolicy();
});

ui.onOverrideToggle((on) => {
  if (on) {
    overrideUiOpen = true;
    populateOverridePicker();
    ui.setOverrideMessage(null);
    ui.showOverridePicker(true);
  } else {
    turnOffOverride();
  }
});
ui.onOverrideProfilePick((profileId) => applyOverridePick(profileId));
ui.onOverrideOff(() => turnOffOverride());
ui.onCheckUpdates(() => { checkForUpdates(); });

// Periodic policy upkeep: expire overrides, and during a session re-resolve
// location + re-evaluate the governing policy (stricter applies immediately).
setInterval(async () => {
  engine.tick({ nowMs: performance.now() });
  if (running) {
    await refreshLocation();
    const ev = engine.evaluateSessionPolicy({ nowMs: performance.now(), nowIso: nowIso() });
    if (ev.action === 'stop') {
      const t = performance.now();
      auditLog.append('policy-stop', {
        fromProfileId: activePolicy.profile.id,
        toProfileId: ev.newPolicy.profile.id,
      }, t);
      policyChanges.push({
        tMs: Math.round(t - sessionStartMs),
        fromProfileId: activePolicy.profile.id,
        toProfileId: ev.newPolicy.profile.id,
      });
      activePolicy = ev.newPolicy;
      // Fail-safe consistency: if the stopping profile keeps no raw, the raw
      // recorded so far is discarded, exactly like a mid-session tighten.
      if (rawRecorder && ev.newPolicy.profile.rawRetention !== 'sealed') {
        const r = rawRecorder;
        rawRecorder = null;
        try {
          const res = await r.stop();
          if (res && res.url) URL.revokeObjectURL(res.url);
        } catch (e) { console.error(e); }
        if (evidence) evidence.setRawMode('blur-at-capture');
      }
      drainPolicyEvents();
      await stop();
    } else if (ev.action === 'tighten') {
      await applyPolicyTighten(ev.newPolicy);
    }
  }
  drainPolicyEvents();
  renderPolicy();
}, 60000);

/**
 * Mid-session tighten (§7): the stricter profile applies IMMEDIATELY. This is
 * mechanical obedience — every decision came from the Core engine.
 */
async function applyPolicyTighten(newPolicy) {
  const t = performance.now();
  const from = activePolicy.profile;
  const to = newPolicy.profile;
  policyChanges.push({ tMs: Math.round(t - sessionStartMs), fromProfileId: from.id, toProfileId: to.id });
  auditLog.append('policy-tighten', { fromProfileId: from.id, toProfileId: to.id }, t);

  // Raw retention tightened (sealed -> blurAtCapture): stop the raw recorder
  // AND DISCARD its data — nothing recorded under the looser rule survives.
  if (rawRecorder && to.rawRetention !== 'sealed') {
    const r = rawRecorder;
    rawRecorder = null;
    try {
      const res = await r.stop();
      if (res && res.url) URL.revokeObjectURL(res.url); // discard, never save
    } catch (e) { console.error(e); }
    if (evidence) evidence.setRawMode('blur-at-capture');
  }

  // Audio capture tightened off: stop the monitor + voice, and (best effort)
  // kill the mic track so no recorder keeps capturing sound.
  if (from.audioCapture && !to.audioCapture) {
    audioMonitor.stop();
    audioMonitorOn = false;
    voice.stop();
    const at = capture && capture.getAudioTrack();
    if (at) { try { at.stop(); } catch (_e) {} }
    ui.setSoundDisabledByPolicy();
  } else if (audioMonitorOn && !to.audioTriggerAllowed) {
    audioMonitor.stop();
    audioMonitorOn = false;
    ui.setSoundDisabledByPolicy();
  }

  activePolicy = newPolicy;
  ui.showProfile(to);
  ui.setVisibleIndicator(to.requiresVisibleIndicator);
  applyVoice();
  ui.setStatus('Privacy rules changed for this location — stricter settings applied.');
}

// ===== Voice + motion triggers =====

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

  // The safety word needs the microphone — when the governing privacy rules
  // turn audio capture off, the trigger is unavailable (honest degradation).
  const prof = running && activePolicy
    ? activePolicy.profile
    : (currentResolved ? currentResolved.profile : null);
  if (cfg.enabled && prof && !prof.audioCapture) {
    ui.setVoiceStatus('off — microphone disabled by privacy rules');
    return;
  }

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

// Restore movement-alert setting (default ON when the device has a motion
// sensor — falls are exactly the moment the wearer can't press a button).
let storedMotion = null;
try { storedMotion = JSON.parse(localStorage.getItem(MOTION_LS) || 'null'); } catch (_e) {}
ui.setMotionConfig(storedMotion && typeof storedMotion.enabled === 'boolean' ? storedMotion : { enabled: true });
ui.onMotionChange(() => applyMotion());
applyMotion(); // sets initial status (off / ready / not available)

/**
 * Start/stop the motion sensor based on settings + session state. All decisions
 * (what counts as a shake or fall) live in the Core MotionDetector; this only
 * moves samples. `sessionActive` is passed explicitly from start() because the
 * iOS permission prompt must run inside the Start tap, before `running` is set.
 */
async function applyMotion(sessionActive = running) {
  const cfg = ui.getMotionConfig();
  try { localStorage.setItem(MOTION_LS, JSON.stringify(cfg)); } catch (_e) {}

  if (!MotionSensor.isSupported()) { ui.setMotionStatus('unsupported'); return; }
  motionSensor.stop();
  motionDetector = null;
  if (sessionActive && cfg.enabled) {
    motionDetector = new MotionDetector();
    ui.setMotionStatus('starting…');
    const ok = await motionSensor.start((ax, ay, az, tMs) => {
      if (!running || !incident || !motionDetector) return;
      const r = motionDetector.update(ax, ay, az, tMs);
      if (r.triggered) {
        // Same effect as the Alert button: seal + sound the deterrent.
        fireEvent('imu', tMs, { kind: r.kind, magnitude: Math.round(r.magnitude * 10) / 10 });
      }
    });
    ui.setMotionStatus(ok ? 'on' : 'denied');
  } else {
    ui.setMotionStatus(cfg.enabled ? 'ready' : 'off');
  }
}

ui.onStart(async () => {
  try {
    await start();
  } catch (err) {
    console.error(err);
    ui.setStatus(`Error: ${err.message}`);
    ui.setRunning(false);
    applyMotion(); // running never became true — release the sensor if it started
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

  // §7: capture behavior is read from the resolved policy, not hard-coded.
  // Refresh the location first (auto mode), then snapshot the session policy.
  await refreshLocation();
  engine.tick({ nowMs: performance.now() });
  const resolved = engine.beginSession({ nowMs: performance.now(), nowIso: nowIso() });
  drainPolicyEvents();
  if (!resolved.profile.recordingAllowed) {
    engine.endSession();
    ui.setRunning(false);
    renderPolicy();
    ui.setStatus('Recording is not available at this location.');
    return;
  }
  activePolicy = resolved;
  sessionStartPolicy = resolved;
  policyChanges = [];
  const profile = resolved.profile;
  ui.showProfile(profile);
  ui.setVisibleIndicator(profile.requiresVisibleIndicator);
  ui.showOverrideChip(resolved.isOverride);
  ui.showNotice(profile.noticeText != null ? profile.noticeText : null);

  // Prime the audio context from this user gesture (autoplay policy).
  deterrentSound.ensureContext();

  // Movement alert: subscribe NOW, still inside the Start tap — iOS 13+ only
  // grants motion permission during a user gesture, and the camera/model
  // loading below can outlive it. Samples are ignored until running is set.
  applyMotion(true);

  ui.setStatus('Turning on the camera…');
  capture = new CaptureLayer();
  const info = await capture.start(profile.audioCapture); // mic never requested when audio is off
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
  // Record which policy governs this session (§7).
  auditLog.append('policy-resolved', {
    profileId: resolved.profile.id,
    source: resolved.source,
    jurisdictionCode: resolved.jurisdictionCode,
    confidence: resolved.confidence,
    rulesetVersion: resolved.rulesetVersion,
    isOverride: resolved.isOverride,
  }, performance.now());
  ui.setWake(session.hasWakeLock());

  incident = new IncidentDetector({
    auditLog,
    onIncident: (inc) => {
      ui.showIncident(true, inc.reason);
      ui.setIncidentCount(incident.count());
    },
  });

  evidence = new EvidenceStore({ auditLog });
  evidence.setRawMode(rawModeFor(profile)); // translate engine field -> ledger mode

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
  // itself, recorded ONLY when the policy keeps raw sealed (§7).
  const audioTrack = profile.audioCapture ? capture.getAudioTrack() : null;
  blurredRecorder = new Recorder({ canvas: ui.el.preview });
  rawRecorder = null;
  if (profile.rawRetention === 'sealed') {
    const rawVideoTrack = capture.stream.getVideoTracks()[0];
    rawRecorder = new Recorder({ stream: new MediaStream([rawVideoTrack]) });
  }

  // Audio goes to the sealed evidence when raw is retained (voices are sensitive);
  // otherwise it rides on the blurred default so it isn't lost.
  recorderStartMs = performance.now();
  if (rawRecorder) {
    rawRecorder.start(audioTrack);
    window.__dbcamDebug.rawRecorderStarted = true;
    blurredRecorder.start(null);
  } else {
    blurredRecorder.start(audioTrack);
  }

  animalDeterrent.reset();
  // Aggressive-sound detector taps the mic — ONLY when the policy allows both
  // audio capture and the sound-based trigger (§7 audioTriggerAllowed).
  audioMonitorOn = false;
  if (profile.audioCapture && profile.audioTriggerAllowed) {
    audioMonitorOn = audioMonitor.start(capture.getAudioTrack());
  }
  if (!(profile.audioCapture && profile.audioTriggerAllowed)) ui.setSoundDisabledByPolicy();

  running = true;
  applyVoice(); // begin listening for the trigger word if enabled (and allowed)
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
    // ONE detector invocation feeds both threat scoring (animals) and the
    // policy-driven body pixelation (persons).
    const objects = detection.detectObjects(video, now);
    lastAnimals = objects.animals;
    lastPersons = objects.persons;
  }

  // --- Blur render (fail-safe) -> visible canvas ---
  // blurMode comes from the governing profile: 'facesAndBodies' also pixelates
  // detected person boxes (§7).
  const extraRegions = activePolicy.profile.blurMode === 'facesAndBodies' ? lastPersons : [];
  window.__dbcamDebug.lastExtraRegions = extraRegions.length;
  const blurInfo = faceBlur.render(video, lastFaceResult, now, extraRegions);

  // --- Animal threat (vision + sound) -> deterrent + early incident sealing ---
  const audioLevel = audioMonitorOn ? audioMonitor.getLevel(now) : 0;
  if (audioMonitorOn) ui.setSoundLevel(audioLevel);
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
  applyMotion(); // unsubscribe the motion sensor; status back to ready/off
  audioMonitor.stop();
  audioMonitorOn = false;
  if (incident) incident.finalize(stopMs);

  let blurredResult = null;
  let rawResult = null;
  try { blurredResult = blurredRecorder ? await blurredRecorder.stop() : null; } catch (e) { console.error(e); }
  try { rawResult = rawRecorder ? await rawRecorder.stop() : null; } catch (e) { console.error(e); }
  try { await session.stop(stopMs); } catch (e) { console.error(e); }
  engine.endSession();
  if (detection) detection.close();
  if (capture) capture.stop();
  ui.clearOverlay();
  ui.setWake(false);
  ui.setRunning(false);
  ui.showOverrideChip(false);
  ui.showNotice(null);

  const publishingAllowed = !!activePolicy.profile.publishingAllowed;

  // Blurred default playback (download gated by publishingAllowed, §7).
  if (blurredResult) ui.showPlayback(blurredResult.url, blurredResult.mimeType, publishingAllowed);

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
      publishingAllowed,
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
  // locked — unlock state never persists. The record carries the FULL resolved
  // policy it was made under + any mid-session policy-change markers.
  if (blurredResult) {
    try {
      await saveSession({
        createdAt: Date.now(),
        durationMs: Math.max(0, Math.round(stopMs - sessionStartMs)),
        alertsCount: n,
        version: CONFIG.version,
        profile: {
          jurisdiction: activePolicy.jurisdictionCode || 'unknown',
          rawMode: rawModeFor(activePolicy.profile),
        },
        policy: JSON.parse(JSON.stringify(sessionStartPolicy)),
        policyChanges: policyChanges.map((c) => ({ ...c })),
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

  renderPolicy(); // idle pills go back to the live resolution
}

/**
 * Shared unlock-to-view handler for the evidence list (§6 rules live in the
 * Core ledger; this wires confirm dialog -> unseal -> clamped playback -> export).
 * Used by both the live session review and the saved-recording review.
 * @param {{store: EvidenceStore, renderAudit: ()=>void, publishingAllowed:boolean,
 *          afterChange?: ()=>Promise<void>}} deps
 */
function makeUnsealHandler({ store, renderAudit, publishingAllowed, afterChange }) {
  return async (seg, rowEl) => {
    const ok = window.confirm(
      `Unlock Alert ${seg.index} (${ui.formatReasons(seg.reasons)})?\n\n` +
      'The original video with faces visible will play. This is noted in the activity log.',
    );
    if (!ok) return;
    const win = await store.unseal(seg, performance.now());
    if (!win) return;
    ui.markSegmentUnsealed(rowEl);
    if (publishingAllowed) {
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
    } else {
      // §7 publishingAllowed=false: no export — viewing stays possible.
      ui.addExportBlockedNote(rowEl);
    }
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

  // The recording is reviewed under the policy IT WAS MADE UNDER (stored with
  // the record). Records without a policy snapshot fail safe: no publishing.
  const rawMode = (rec.profile && rec.profile.rawMode) ||
    (rec.policy && rec.policy.profile.rawRetention === 'sealed' ? 'raw-sealed' : 'blur-at-capture');
  const publishingAllowed = !!(rec.policy && rec.policy.profile.publishingAllowed);

  const store = new EvidenceStore({ auditLog: reviewAudit });
  store.setRawMode(rawMode);
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

  if (blurred) ui.showPlayback(blurred.url, blurred.mimeType, publishingAllowed);
  ui.renderEvidence(segments, {
    hasRaw: store.hasRaw(),
    prerollSeconds: CONFIG.incident.prerollSeconds,
    onUnseal: makeUnsealHandler({ store, renderAudit, publishingAllowed, afterChange: persist }),
  });
  renderAudit();
  ui.setSessionState('review');
  ui.setStatus('Showing a saved recording — it is below.');
  ui.el.reviewHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===== Bootstrap =====

(async () => {
  // Old-model leftovers: the region picker is gone — drop its keys silently.
  try {
    localStorage.removeItem('dbcam.region');
    localStorage.removeItem('dbcam.regionHintDismissed');
  } catch (_e) {}

  // Restore persisted location settings.
  try {
    const m = localStorage.getItem(LOCMODE_LS);
    if (m === 'auto' || m === 'manual') locationMode = m;
    const j = localStorage.getItem(MANUAL_LS);
    if (j) manualJurisdiction = j;
  } catch (_e) {}
  ui.setLocationMode(locationMode);

  // Load the bundled ruleset + geo bounds (the CLIENT does the I/O; the Core
  // is pure). Any failure leaves the engine on its built-in fail-safe.
  try {
    const [rsRes, gbRes] = await Promise.all([
      fetch(`${DATA_BASE}ruleset.json`),
      fetch(`${DATA_BASE}geo-bounds.json`),
    ]);
    if (!rsRes.ok || !gbRes.ok) throw new Error('policy data fetch failed');
    const [rs, gb] = await Promise.all([rsRes.json(), gbRes.json()]);
    engine.setGeoBounds(gb);
    const out = engine.loadRuleset(rs);
    if (!out.ok) usingBuiltInRules = true;
  } catch (_e) {
    usingBuiltInRules = true;
  }
  drainPolicyEvents();

  // Feed the engine the restored inputs (after the ruleset, so codes resolve).
  engine.setLocationMode(locationMode);
  engine.setManualJurisdiction(locationMode === 'manual' ? manualJurisdiction : null);
  ui.populateJurisdictions(engine.listJurisdictions(), manualJurisdiction);
  drainPolicyEvents();

  // Re-apply a persisted override (sessionStorage — dies with the app; 24h cap).
  restoreOverride();

  // First location fix (auto mode; denial just fail-safes).
  await refreshLocation();
  renderPolicy();

  // Saved recordings: enforce the ACTIVE profile's retention rule (the number
  // lives in the policy profile, not here), then show what's kept.
  try { await purgeOlderThan(currentResolved.profile.retentionDays * 86400 * 1000); } catch (_e) {}
  await refreshRecordings();

  window.__dbcamDebug.policyReady = true;
})();
