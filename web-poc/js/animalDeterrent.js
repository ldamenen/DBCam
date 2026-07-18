// animalDeterrent.js
// §2.2 Animal Deterrent Detector — THREAT estimation.
//
// A generic on-device object detector only yields a box + class label (dog/cat…),
// so it cannot read true aggression (bared teeth, growl, posture). Instead we infer
// THREATENING BEHAVIOUR from motion, which is a reasonable proxy for "this animal
// seems hostile":
//   - proximity  : how large the animal is in frame (how close it is)
//   - approach   : how fast it is lunging toward the wearer (box-area growth rate)
//   - agitation  : how erratic/fast its lateral movement is (center jitter speed)
// Each term is normalized, weighted, and combined into a threatScore in [0,1],
// scaled down when the animal is not centered on the wearer. When the score crosses
// a sensitivity-scaled threshold we treat the animal as hostile → deterrent + early
// incident sealing.
//
// Honest limit (surfaced in the UI): this is behaviour-based inference, NOT emotion
// or aggression recognition.

import { CONFIG } from './config.js';

export class AnimalDeterrent {
  constructor() {
    this.sensitivity = CONFIG.animals.defaultSensitivity;
    this._history = []; // [{tMs, nx, ny, areaFrac}]  (nx,ny = center in 0..1)
    this._aboveSinceMs = null; // when the score first crossed the threshold (dwell)
  }

  setSensitivity(v) {
    this.sensitivity = Math.min(1, Math.max(0, v));
  }

  /** Sensitivity 0 -> 1.4x threshold (harder), 0.5 -> 1x, 1 -> 0.6x (easier). */
  _threshold() {
    return CONFIG.animals.threat.triggerScore * (1.4 - 0.8 * this.sensitivity);
  }

  /**
   * @param {Array<{x,y,w,h,score,label}>} animals detections in frame pixels
   * @param {number} frameW
   * @param {number} frameH
   * @param {number} nowMs
   * @param {number} [audioLevel=0] aggressive-sound level 0..1 (audioMonitor.js)
   * @returns {{hostile:boolean, threatScore:number, animal:Object|null,
   *            areaFrac:number, growthPerSec:number, agitation:number,
   *            audioLevel:number, centered:boolean, reasons:string[]}}
   */
  update(animals, frameW, frameH, nowMs, audioLevel = 0) {
    const frameArea = frameW * frameH || 1;
    const T = CONFIG.animals.threat;

    // Largest animal box = the primary subject.
    let biggest = null;
    let biggestArea = 0;
    for (const a of animals) {
      const area = a.w * a.h;
      if (area > biggestArea) { biggestArea = area; biggest = a; }
    }

    if (!biggest) {
      this._history.length = 0;
      this._aboveSinceMs = null;
      return { hostile: false, threatScore: 0, animal: null, areaFrac: 0,
        growthPerSec: 0, agitation: 0, audioLevel, centered: false, reasons: [] };
    }

    const areaFrac = biggestArea / frameArea;
    const nx = (biggest.x + biggest.w / 2) / frameW;
    const ny = (biggest.y + biggest.h / 2) / frameH;
    const offX = Math.abs(nx - 0.5);
    const offY = Math.abs(ny - 0.5);
    const centered = offX <= T.centerToleranceFrac && offY <= T.centerToleranceFrac;

    // History window.
    this._history.push({ tMs: nowMs, nx, ny, areaFrac });
    const cutoff = nowMs - CONFIG.animals.historyMs;
    while (this._history.length && this._history[0].tMs < cutoff) this._history.shift();

    // Approach = area growth per second across the window.
    let growthPerSec = 0;
    if (this._history.length >= 2) {
      const f = this._history[0];
      const l = this._history[this._history.length - 1];
      const dt = (l.tMs - f.tMs) / 1000;
      if (dt > 0) growthPerSec = (l.areaFrac - f.areaFrac) / dt;
    }

    // Agitation = total lateral center travel per second (erratic/fast movement).
    let agitation = 0;
    if (this._history.length >= 2) {
      let dist = 0;
      for (let i = 1; i < this._history.length; i++) {
        const a = this._history[i - 1], b = this._history[i];
        dist += Math.hypot(b.nx - a.nx, b.ny - a.ny);
      }
      const span = (this._history[this._history.length - 1].tMs - this._history[0].tMs) / 1000;
      if (span > 0) agitation = dist / span;
    }

    // Normalized [0,1] terms.
    const proximityTerm = clamp01(areaFrac / T.areaRef);
    // Approach: growth below walkGrowthFloor (a calm walk-up) counts as ZERO —
    // only charge-like growth scores. This is what keeps a passive dog walking
    // toward the wearer from reading as a lunge.
    const approachTerm = clamp01(
      (Math.max(0, growthPerSec) - T.walkGrowthFloor) / (T.lungeGrowthRef - T.walkGrowthFloor),
    );
    const agitationTerm = clamp01(agitation / T.agitationRef);
    const audioTerm = clamp01(audioLevel);

    let score =
      T.weights.proximity * proximityTerm +
      T.weights.approach * approachTerm +
      T.weights.agitation * agitationTerm +
      T.weights.audio * audioTerm;

    // Off-center animals are less of a direct threat: fade the score out.
    if (!centered) score *= 0.5;

    // Sustained requirement: the score must stay above threshold for sustainMs
    // before firing, so one-frame box jitter can't spike a false alarm.
    const above = score >= this._threshold();
    if (above) {
      if (this._aboveSinceMs === null) this._aboveSinceMs = nowMs;
    } else {
      this._aboveSinceMs = null;
    }
    const hostile = above && nowMs - this._aboveSinceMs >= T.sustainMs;

    // Human-readable contributors (for UI / incident detail).
    const reasons = [];
    if (proximityTerm > 0.5) reasons.push('very close');
    if (approachTerm > 0.5) reasons.push('lunging');
    if (agitationTerm > 0.5) reasons.push('agitated');
    if (audioTerm > T.audioReasonAt) reasons.push('barking/loud');
    if (centered) reasons.push('aimed at you');

    return { hostile, threatScore: score, animal: biggest, areaFrac,
      growthPerSec, agitation, audioLevel: audioTerm, centered, reasons };
  }

  reset() {
    this._history.length = 0;
    this._aboveSinceMs = null;
  }
}

function clamp01(n) { return Math.min(1, Math.max(0, n)); }
