// detection.js
// MediaPipe Tasks (Vision) wrappers for face + object detection.
//
// Why MediaPipe: it is the same detection family that underlies Android ML Kit
// and mirrors iOS Vision (VNDetectFaceRectangles / VNRecognizeAnimals), so the
// detect -> approach -> blur logic here ports conceptually to both native apps.
//
// Both detectors run in VIDEO mode via detectForVideo(video, timestampMs). Each
// detector instance keeps its own monotonically-increasing timestamp state, so we
// pass a strictly increasing integer timestamp per call.

import { CONFIG } from './config.js';

// Loaded as an ES module directly from the CDN. Requires network at run time.
const TASKS_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${CONFIG.detection.tasksVisionVersion}`;
const WASM_URL = `${TASKS_URL}/wasm`;

export class Detection {
  constructor() {
    this.faceDetector = null;
    this.objectDetector = null;
    this.ready = false;
    this._lastTs = 0;
  }

  async init() {
    const { FilesetResolver, FaceDetector, ObjectDetector } = await import(
      /* @vite-ignore */ TASKS_URL
    );
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);

    // CPU (XNNPACK) delegate by default — reliable on iOS Safari, where the WebGL
    // GPU delegate is flaky. Configurable via CONFIG.detection.delegate.
    const delegate = CONFIG.detection.delegate || 'CPU';
    [this.faceDetector, this.objectDetector] = await Promise.all([
      FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: CONFIG.detection.faceModelUrl, delegate },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.25, // keep low; we apply our own thresholds
      }),
      ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: CONFIG.detection.objectModelUrl, delegate },
        runningMode: 'VIDEO',
        scoreThreshold: 0.25,
        maxResults: 10,
      }),
    ]);

    this.ready = true;
  }

  _nextTs(tsMs) {
    // Ensure strictly increasing integer timestamps for MediaPipe.
    let ts = Math.floor(tsMs);
    if (ts <= this._lastTs) ts = this._lastTs + 1;
    this._lastTs = ts;
    return ts;
  }

  /**
   * @returns {{boxes: Array<{x,y,w,h,score}>, maxScore: number, ok: boolean}}
   * Boxes are in source-video pixel coordinates. `ok` is true when the detector
   * call succeeded (even if it found zero faces) — the fail-safe uses it to tell
   * "detector stalled/errored" (over-blur everything) apart from "no face in view".
   */
  detectFaces(video, tsMs) {
    if (!this.ready) return { boxes: [], maxScore: 0, ok: false };
    const ts = this._nextTs(tsMs);
    let res;
    try {
      res = this.faceDetector.detectForVideo(video, ts);
    } catch (e) {
      if (!this._warnedFace) { console.warn('face detectForVideo failed:', e); this._warnedFace = true; }
      return { boxes: [], maxScore: 0, ok: false };
    }
    const boxes = [];
    let maxScore = 0;
    for (const d of res.detections || []) {
      const bb = d.boundingBox;
      if (!bb) continue;
      const score = d.categories && d.categories[0] ? d.categories[0].score : 0;
      maxScore = Math.max(maxScore, score);
      boxes.push({ x: bb.originX, y: bb.originY, w: bb.width, h: bb.height, score });
    }
    return { boxes, maxScore, ok: true };
  }

  /**
   * @returns {Array<{x,y,w,h,score,label}>} animal detections in video pixels.
   */
  detectAnimals(video, tsMs) {
    if (!this.ready) return [];
    const ts = this._nextTs(tsMs);
    let res;
    try {
      res = this.objectDetector.detectForVideo(video, ts);
    } catch (_e) {
      return [];
    }
    const out = [];
    for (const d of res.detections || []) {
      const cat = d.categories && d.categories[0];
      if (!cat) continue;
      const label = (cat.categoryName || '').toLowerCase();
      if (!CONFIG.animals.classes.includes(label)) continue;
      if (cat.score < CONFIG.detection.animalMinConfidence) continue;
      const bb = d.boundingBox;
      out.push({ x: bb.originX, y: bb.originY, w: bb.width, h: bb.height, score: cat.score, label });
    }
    return out;
  }

  close() {
    try { this.faceDetector && this.faceDetector.close(); } catch (_e) {}
    try { this.objectDetector && this.objectDetector.close(); } catch (_e) {}
    this.faceDetector = this.objectDetector = null;
    this.ready = false;
  }
}
