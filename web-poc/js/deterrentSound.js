// deterrentSound.js
// Web Audio deterrent "alarm" (§2.2 Animal Deterrent Detector).
//
// Honest limits encoded in the UX (§2.2): phone speakers aren't loud, effect
// varies by animal, and there is detect+play latency — so this is
// "may help avoid, definitely helps document", never a safety guarantee.
// We include a cooldown so it can't blast repeatedly.

import { CONFIG } from './config.js';

export class DeterrentSound {
  constructor() {
    this.ctx = null;
    this._lastPlayedAtMs = -Infinity;
    this._playing = false;
  }

  /** Must be created/resumed from a user gesture (Start button) to satisfy autoplay policy. */
  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  canPlay(nowMs) {
    return !this._playing && nowMs - this._lastPlayedAtMs >= CONFIG.deterrent.cooldownMs;
  }

  cooldownRemainingMs(nowMs) {
    return Math.max(0, CONFIG.deterrent.cooldownMs - (nowMs - this._lastPlayedAtMs));
  }

  /**
   * Fire a two-tone alarm burst. Returns true if it actually played.
   * @param {number} nowMs
   */
  play(nowMs) {
    if (!this.canPlay(nowMs)) return false;
    const ctx = this.ensureContext();
    const d = CONFIG.deterrent;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    gain.gain.value = d.gain;
    osc.connect(gain).connect(ctx.destination);

    const start = ctx.currentTime;
    const end = start + d.blastDurationMs / 1000;

    // Alternate between two tones to make it more "alarm"-like and attention-grabbing.
    let t = start;
    let useA = true;
    while (t < end) {
      osc.frequency.setValueAtTime(useA ? d.toneAHz : d.toneBHz, t);
      t += d.toneSwapMs / 1000;
      useA = !useA;
    }
    // Quick fade out to avoid a click.
    gain.gain.setValueAtTime(d.gain, end - 0.03);
    gain.gain.linearRampToValueAtTime(0, end);

    this._playing = true;
    osc.start(start);
    osc.stop(end);
    osc.onended = () => { this._playing = false; };

    this._lastPlayedAtMs = nowMs;
    return true;
  }

  close() {
    try { this.ctx && this.ctx.close(); } catch (_e) {}
    this.ctx = null;
  }
}
