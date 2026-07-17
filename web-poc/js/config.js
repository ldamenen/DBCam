// config.js
// Central tunables for the web PoC. In the native apps these values live in the
// Jurisdiction Policy Engine profile (§7) and per-detector settings; here they
// are gathered in one place so the demo is easy to tweak while presenting.

export const CONFIG = {
  // Bump on every deploy so the header shows which build is loaded (cache check).
  version: 'v0.6.0',

  capture: {
    // Target capture constraints. Native target is 1080p30 (§4 real-time budget);
    // the browser will negotiate the closest it can and we adapt to what we get.
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
    facingMode: 'environment', // rear camera on phones; falls back to any camera
    audio: true,               // gated again by the policy profile (audioEnabled)
  },

  detection: {
    // Run detectors every N rendered frames. Blur always reuses the most recent
    // boxes, so throttling detection protects framerate without leaking faces.
    faceEveryN: 1,
    animalEveryN: 2,
    faceMinConfidence: 0.5,   // faces below this are still blurred, just flagged low-conf
    animalMinConfidence: 0.4,
    // MediaPipe inference delegate. 'CPU' (XNNPACK) is reliable on iOS Safari; 'GPU'
    // (WebGL) is faster on desktop but flaky on iOS. CPU is the safe default here.
    delegate: 'CPU',
    // MediaPipe model + wasm locations (loaded from CDN when served online).
    tasksVisionVersion: '0.10.14',
    faceModelUrl:
      'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    objectModelUrl:
      'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
  },

  blur: {
    // Fail-safe blur (§2.2, §4). Faces are obscured by PIXELATION (mosaic), not
    // canvas gaussian blur: iOS Safari does not support CanvasRenderingContext2D
    // .filter, so a downscale->upscale mosaic is the only obscuring method that
    // works reliably across browsers. Fewer blocks = stronger obscuring.
    facePaddingPct: 0.35,        // expand each face box by this fraction on all sides
    mosaicBlocksFace: 8,         // ~blocks across the larger side of a face region
    mosaicBlocksLowConf: 6,      // stronger (fewer blocks) when confidence is low
    mosaicBlocksFullFrame: 20,   // whole-frame fail-safe pixelation
    // Whole-frame over-blur triggers only when the DETECTOR itself stalls/errors
    // (no successful detector call within this window) — NOT when it healthily
    // reports zero faces. A healthy "no face in view" blurs nothing.
    stallOverblurMs: 900,
  },

  animals: {
    // Approach estimation: an animal is "approaching" when its box is large,
    // growing, and roughly centered on the wearer.
    classes: ['dog', 'cat', 'bear', 'horse', 'sheep', 'cow', 'elephant', 'zebra', 'giraffe', 'bird'],
    approachAreaFrac: 0.06,    // box area must exceed this fraction of the frame
    approachGrowthFrac: 0.015, // and be growing by at least this much area-frac/sec
    centerToleranceFrac: 0.30, // box center within this fraction of frame center
    historyMs: 1200,           // window used to estimate growth
    // Sensitivity slider maps 0..1 onto a multiplier applied to the thresholds.
    defaultSensitivity: 0.5,
  },

  deterrent: {
    cooldownMs: 8000,          // avoid repeated blasting (§2.2 honest-limits)
    blastDurationMs: 1400,
    // Alternating two-tone "alarm". Phone speakers are weak — this is documentation-first.
    toneAHz: 2200,
    toneBHz: 3100,
    toneSwapMs: 120,
    gain: 0.9,
  },

  incident: {
    // How long an incident stays "active" after the last trigger (the hold/cooldown
    // during which the evidence segment keeps sealing).
    holdMs: 6000,
    // Pre-roll: how far BEFORE the trigger the sealed segment reaches back, so the
    // buildup is captured (§1). Native uses an encrypted ring buffer; here the raw
    // is recorded continuously and the segment just seeks back this far.
    prerollSeconds: 6,
  },

  recorder: {
    // MediaRecorder preferred container/codec, in order of preference.
    mimeCandidates: [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ],
    timesliceMs: 1000,
  },
};
