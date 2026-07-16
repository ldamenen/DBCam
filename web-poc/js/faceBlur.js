// faceBlur.js
// §2.2 Face Detect + Blur — the render step. Draws the raw frame to the visible
// canvas and obscures every detected face region BEFORE it is shown or recorded.
//
// FAIL-SAFE BLUR (§2.2, §4): the guarantee is "uncertainty => over-blur, never
// leak". We enforce it three ways:
//   1. Every detected face box is padded outward before blurring.
//   2. If the most recent face result is low-confidence, we widen the blur.
//   3. If detection is stale (no fresh result within stallOverblurMs) OR the
//      detector has never produced a result this session, we blur the WHOLE frame.

import { CONFIG } from './config.js';

export class FaceBlur {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: false });
    this._lastConfidentAtMs = 0;
    this._everDetected = false;
  }

  resize(w, h) {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /**
   * Render one frame.
   * @param {HTMLVideoElement} video   raw source
   * @param {{boxes:Array,maxScore:number}} faceResult latest face detection
   * @param {number} nowMs
   * @returns {{overBlurred:boolean, blurredCount:number}}
   */
  render(video, faceResult, nowMs) {
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const b = CONFIG.blur;

    // 1) Draw the raw frame as the base image.
    ctx.filter = 'none';
    ctx.drawImage(video, 0, 0, w, h);

    const boxes = (faceResult && faceResult.boxes) || [];
    const maxScore = (faceResult && faceResult.maxScore) || 0;
    const confident = boxes.length > 0 && maxScore >= CONFIG.detection.faceMinConfidence;

    if (confident) {
      this._lastConfidentAtMs = nowMs;
      this._everDetected = true;
    }

    // 2) Decide whether to fail-safe over-blur the whole frame.
    const stale = nowMs - this._lastConfidentAtMs > b.stallOverblurMs;
    // Over-blur if: detector never produced anything yet, OR it has gone stale.
    const overBlur = !this._everDetected || stale;

    if (overBlur) {
      ctx.filter = `blur(${b.fullFrameFallbackBlurPx}px)`;
      ctx.drawImage(video, 0, 0, w, h);
      ctx.filter = 'none';
      return { overBlurred: true, blurredCount: boxes.length };
    }

    // 3) Normal path: blur each padded face region by clipping and redrawing.
    let count = 0;
    for (const box of boxes) {
      const padX = box.w * b.facePaddingPct;
      const padY = box.h * b.facePaddingPct;
      const x = Math.max(0, box.x - padX);
      const y = Math.max(0, box.y - padY);
      const rw = Math.min(w - x, box.w + padX * 2);
      const rh = Math.min(h - y, box.h + padY * 2);
      if (rw <= 0 || rh <= 0) continue;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, rw, rh);
      ctx.clip();
      // Low-confidence single boxes get an extra-wide blur (defence in depth).
      const radius = box.score < CONFIG.detection.faceMinConfidence
        ? b.blurRadiusPx * 1.6
        : b.blurRadiusPx;
      ctx.filter = `blur(${radius}px)`;
      // Redraw the full frame; the clip restricts the blurred paint to this region.
      ctx.drawImage(video, 0, 0, w, h);
      ctx.restore();
      count++;
    }
    ctx.filter = 'none';
    return { overBlurred: false, blurredCount: count };
  }

  reset() {
    this._lastConfidentAtMs = 0;
    this._everDetected = false;
  }
}
