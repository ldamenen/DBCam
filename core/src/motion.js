// core/motion.js  (shared Core — ARCHITECTURE §3)
// §2.2 IMU shake/fall trigger — "wearer knocked down / falls".
//
// Input: raw accelerometer samples INCLUDING gravity, in m/s^2, fed one at a
// time via update(ax, ay, az, tMs) by each platform's MotionSensor adapter
// (web DeviceMotionEvent / iOS CoreMotion / Android SensorManager). Time is
// platform-monotonic milliseconds (contracts/ports.d.ts).
//
// Two patterns are detected (all tunables in CONFIG.motion):
//   SHAKE  — the acceleration magnitude deviates from 1g (~9.81) by more than
//            a threshold for several samples inside a short window: a violent
//            jolt/struggle. Normal walking swings the magnitude by only about
//            ±3 m/s^2, so the threshold sits far above it.
//   FALL   — the free-fall signature: magnitude near zero (weightless) for a
//            sustained stretch, followed shortly by a hard impact spike. The
//            trigger fires ON THE IMPACT — that is when the fall completed.
//
// After any trigger further triggers are ignored for CONFIG.motion.retriggerMs
// so one violent episode raises one alert, not one per sample.
//
// Pure logic: no DOM, no sensors, no timers. History is pruned to a small
// window so a long session never grows memory.

import { CONFIG } from './config.js';

export class MotionDetector {
  constructor(cfg = CONFIG.motion) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    /** @type {Array<{tMs:number, dev:number}>} recent samples: time + |mag-1g| */
    this._history = [];
    this._lastTriggerMs = -Infinity;
    this._freefallStartMs = null;  // when the current below-threshold stretch began
    this._impactDeadlineMs = -Infinity; // a qualifying free-fall arms impact detection until this time
  }

  /**
   * Feed one accelerometer sample (m/s^2, INCLUDING gravity).
   * @param {number} ax @param {number} ay @param {number} az
   * @param {number} tMs platform-monotonic milliseconds
   * @returns {{triggered:boolean, kind:'shake'|'fall'|null, magnitude:number}}
   */
  update(ax, ay, az, tMs) {
    const cfg = this.cfg;
    const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);
    const deviation = Math.abs(magnitude - cfg.gravity);

    // Keep only the recent window (shake counting needs shake.windowMs at most).
    this._history.push({ tMs, dev: deviation });
    const keepAfter = tMs - cfg.historyMs;
    while (this._history.length && this._history[0].tMs < keepAfter) this._history.shift();

    // --- Free-fall bookkeeping (runs even inside the debounce window so the
    // state stays truthful; only the TRIGGER is debounced). ---
    if (magnitude < cfg.fall.freefallBelow) {
      if (this._freefallStartMs === null) this._freefallStartMs = tMs;
      // While still weightless past the minimum duration, keep the impact
      // window armed (the impact sample itself ends the free-fall stretch).
      if (tMs - this._freefallStartMs >= cfg.fall.freefallMinMs) {
        this._impactDeadlineMs = tMs + cfg.fall.impactWithinMs;
      }
    } else if (this._freefallStartMs !== null) {
      if (tMs - this._freefallStartMs >= cfg.fall.freefallMinMs) {
        this._impactDeadlineMs = tMs + cfg.fall.impactWithinMs;
      }
      this._freefallStartMs = null;
    }

    // --- Debounce: one alert per violent episode. ---
    if (tMs - this._lastTriggerMs < cfg.retriggerMs) {
      return { triggered: false, kind: null, magnitude };
    }

    // --- FALL: impact spike inside the armed window after sustained free-fall.
    // Checked before shake so a completed fall is reported as 'fall'. ---
    if (magnitude > cfg.fall.impactAbove && tMs <= this._impactDeadlineMs) {
      return this._fire('fall', tMs, magnitude);
    }

    // --- SHAKE: enough strongly-deviating samples inside the short window. ---
    if (deviation > cfg.shake.deviationThreshold) {
      const windowStart = tMs - cfg.shake.windowMs;
      let n = 0;
      for (let i = this._history.length - 1; i >= 0; i--) {
        const s = this._history[i];
        if (s.tMs < windowStart) break;
        if (s.dev > cfg.shake.deviationThreshold) n++;
      }
      if (n >= cfg.shake.minCount) return this._fire('shake', tMs, magnitude);
    }

    return { triggered: false, kind: null, magnitude };
  }

  _fire(kind, tMs, magnitude) {
    this._lastTriggerMs = tMs;
    this._freefallStartMs = null;
    this._impactDeadlineMs = -Infinity;
    this._history.length = 0; // a trigger consumes its evidence — start clean
    return { triggered: true, kind, magnitude };
  }
}
