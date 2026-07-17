// audioMonitor.js
// Mic-based "aggressive sound" detector — a loudness + low-frequency-spike proxy
// for barking/growling, feeding the animal threat score (animalDeterrent.js).
//
// Honest limit (surfaced in the UI): this is NOT a sound classifier. It detects
// loud, sudden, low-frequency-heavy noise — which barks/growls are — but can't tell
// a bark from a slammed door. Combined with a visible animal it's a strong hostility
// cue. Native would use an on-device classifier (iOS SoundAnalysis / YAMNet).
//
// It taps the existing mic track via a Web Audio AnalyserNode (not connected to the
// output, so there's no feedback) and focuses on the ~90–1200 Hz band. It also
// suppresses itself briefly after the deterrent fires so our own high-pitched alarm
// (2.2–3.1 kHz, above the band) doesn't self-trigger.

import { CONFIG } from './config.js';

export class AudioMonitor {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.timeBuf = null;
    this.freqBuf = null;
    this.active = false;
    this._baseline = 0;      // adaptive ambient loudness floor
    this._level = 0;         // smoothed output level 0..1
    this._suppressUntilMs = -Infinity;
    this._lowBinRange = [1, 1];
  }

  /** @param {MediaStreamTrack|null} audioTrack the mic track, or null to stay idle */
  start(audioTrack) {
    if (!audioTrack) return false;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.source = this.ctx.createMediaStreamSource(new MediaStream([audioTrack]));
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = CONFIG.audio.fftSize;
      this.analyser.smoothingTimeConstant = 0.5;
      this.source.connect(this.analyser); // NOT connected to destination -> no feedback
      this.timeBuf = new Uint8Array(this.analyser.fftSize);
      this.freqBuf = new Uint8Array(this.analyser.frequencyBinCount);

      const binHz = this.ctx.sampleRate / this.analyser.fftSize;
      const [lo, hi] = CONFIG.audio.lowBandHz;
      this._lowBinRange = [Math.max(1, Math.floor(lo / binHz)), Math.min(this.freqBuf.length - 1, Math.ceil(hi / binHz))];
      this.active = true;
      this._baseline = 0;
      this._level = 0;
      return true;
    } catch (_e) {
      this.active = false;
      return false;
    }
  }

  /** Call when the deterrent blasts, so we ignore the self-noise briefly. */
  notifyDeterrent(nowMs) {
    this._suppressUntilMs = nowMs + CONFIG.audio.suppressAfterDeterrentMs;
  }

  /**
   * Current aggressive-sound level in [0,1]. Loud + low-frequency + above the
   * adaptive ambient baseline. Returns 0 when idle or suppressed.
   */
  getLevel(nowMs) {
    if (!this.active || !this.analyser) return 0;
    if (nowMs < this._suppressUntilMs) return this._level *= 0.5, this._level;

    const a = CONFIG.audio;
    // RMS loudness from time domain.
    this.analyser.getByteTimeDomainData(this.timeBuf);
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const v = (this.timeBuf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.timeBuf.length);

    // Adapt the ambient baseline slowly.
    this._baseline = this._baseline + a.baselineEma * (rms - this._baseline);

    // Low-band energy ratio from frequency domain.
    this.analyser.getByteFrequencyData(this.freqBuf);
    let low = 0, total = 0;
    for (let i = 1; i < this.freqBuf.length; i++) {
      const e = this.freqBuf[i];
      total += e;
      if (i >= this._lowBinRange[0] && i <= this._lowBinRange[1]) low += e;
    }
    const lowRatio = total > 0 ? low / total : 0;

    // Spike above baseline, gated by an absolute floor, weighted by low-band content.
    let raw = 0;
    if (rms > a.minLoud && rms > this._baseline * a.spikeMult) {
      const spike = clamp01((rms - a.minLoud) * 3);
      raw = spike * clamp01(lowRatio / 0.5);
    }
    // Fast smoothing to avoid flicker while staying responsive.
    this._level = this._level + a.levelEma * (raw - this._level);
    return clamp01(this._level);
  }

  stop() {
    this.active = false;
    try { this.source && this.source.disconnect(); } catch (_e) {}
    try { this.ctx && this.ctx.close(); } catch (_e) {}
    this.ctx = this.analyser = this.source = null;
    this._level = 0;
  }
}

function clamp01(n) { return Math.min(1, Math.max(0, n)); }
