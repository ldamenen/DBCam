// core/deterrent.js  (shared Core — ARCHITECTURE §3)
// Deterrent POLICY — when the alarm may fire and the cooldown bookkeeping
// (§2.2 honest-limits: never blast repeatedly). The sound itself (tone synthesis,
// speaker routing) is a platform port.

import { CONFIG } from './config.js';

export class DeterrentPolicy {
  constructor() {
    this._lastPlayedAtMs = -Infinity;
    this._playing = false;
  }

  canPlay(nowMs) {
    return !this._playing && nowMs - this._lastPlayedAtMs >= CONFIG.deterrent.cooldownMs;
  }

  cooldownRemainingMs(nowMs) {
    return Math.max(0, CONFIG.deterrent.cooldownMs - (nowMs - this._lastPlayedAtMs));
  }

  /** Record that a blast started now (platform then plays the actual sound). */
  markStarted(nowMs) {
    this._playing = true;
    this._lastPlayedAtMs = nowMs;
  }

  markEnded() {
    this._playing = false;
  }
}
