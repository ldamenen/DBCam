// animalDeterrent.js
// §2.2 Animal Deterrent Detector — approach estimation.
//
// "Approach" = a detected animal's bounding box is (a) large, (b) growing fast,
// and (c) roughly centered on the wearer. When the threshold is crossed we:
//   1. signal the Incident Detector to begin EARLY sealing (buildup before contact),
//   2. ask the DeterrentSound module to blast (with its own cooldown).
//
// A sensitivity setting (0..1) scales the thresholds. Approach is estimated from a
// short history of the largest animal box's area fraction.

import { CONFIG } from './config.js';

export class AnimalDeterrent {
  constructor() {
    this.sensitivity = CONFIG.animals.defaultSensitivity;
    this._history = []; // [{tMs, areaFrac, centered}]
  }

  setSensitivity(v) {
    this.sensitivity = Math.min(1, Math.max(0, v));
  }

  /** Higher sensitivity => lower thresholds (easier to trigger). */
  _scaled(base) {
    // sensitivity 0 -> 1.75x threshold, 0.5 -> 1x, 1 -> ~0.4x
    const mult = 1.75 - this.sensitivity * 1.35;
    return base * mult;
  }

  /**
   * @param {Array<{x,y,w,h,score,label}>} animals detections in frame pixels
   * @param {number} frameW
   * @param {number} frameH
   * @param {number} nowMs
   * @returns {{approaching:boolean, animal:Object|null, areaFrac:number, growthPerSec:number, centered:boolean}}
   */
  update(animals, frameW, frameH, nowMs) {
    const frameArea = frameW * frameH || 1;

    // Pick the largest animal box as the primary threat.
    let biggest = null;
    let biggestArea = 0;
    for (const a of animals) {
      const area = a.w * a.h;
      if (area > biggestArea) { biggestArea = area; biggest = a; }
    }

    if (!biggest) {
      this._history.length = 0;
      return { approaching: false, animal: null, areaFrac: 0, growthPerSec: 0, centered: false };
    }

    const areaFrac = biggestArea / frameArea;
    const cx = biggest.x + biggest.w / 2;
    const cy = biggest.y + biggest.h / 2;
    const offX = Math.abs(cx - frameW / 2) / frameW;
    const offY = Math.abs(cy - frameH / 2) / frameH;
    const centered =
      offX <= this._scaled(CONFIG.animals.centerToleranceFrac) &&
      offY <= this._scaled(CONFIG.animals.centerToleranceFrac);

    // Maintain a short history window for growth estimation.
    this._history.push({ tMs: nowMs, areaFrac, centered });
    const cutoff = nowMs - CONFIG.animals.historyMs;
    while (this._history.length && this._history[0].tMs < cutoff) this._history.shift();

    let growthPerSec = 0;
    if (this._history.length >= 2) {
      const first = this._history[0];
      const last = this._history[this._history.length - 1];
      const dt = (last.tMs - first.tMs) / 1000;
      if (dt > 0) growthPerSec = (last.areaFrac - first.areaFrac) / dt;
    }

    const bigEnough = areaFrac >= this._scaled(CONFIG.animals.approachAreaFrac);
    const growingFast = growthPerSec >= this._scaled(CONFIG.animals.approachGrowthFrac);

    const approaching = bigEnough && growingFast && centered;

    return { approaching, animal: biggest, areaFrac, growthPerSec, centered };
  }

  reset() {
    this._history.length = 0;
  }
}
