// faceBlur.js
// §2.2 Face Detect + Blur — the render step. Draws the raw frame to the visible
// canvas and obscures every detected face region BEFORE it is shown or recorded.
//
// Obscuring method: PIXELATION (mosaic) via a downscale->upscale, NOT canvas
// `ctx.filter = blur(...)`. iOS Safari does not support CanvasRenderingContext2D
// .filter, so a gaussian-filter approach silently no-ops there and leaks the face.
// Mosaic works in every browser (Chrome, Firefox, Safari, iOS Safari).
//
// FAIL-SAFE (§2.2, §4): the guarantee is "uncertainty => over-blur, never leak":
//   1. Every detected face box is padded outward before pixelating.
//   2. Low-confidence faces get a stronger (coarser) mosaic.
//   3. If detection is stale (no fresh result within stallOverblurMs) OR the
//      detector has never produced a result this session, the WHOLE frame is
//      pixelated.

import { CONFIG } from './config.js';

export class FaceBlur {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: false });
    // Reusable offscreen buffer for the downscale step of the mosaic.
    this.tmp = document.createElement('canvas');
    this.tmpCtx = this.tmp.getContext('2d');
    this._lastHealthyAtMs = 0;   // last time the detector returned successfully
    this._everHealthy = false;   // detector has produced at least one successful call
  }

  resize(w, h) {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /**
   * Pixelate a rectangular region of the MAIN canvas in place. Samples the region
   * that has already been drawn (the raw frame), shrinks it to a few blocks, and
   * redraws it enlarged with smoothing off -> a hard mosaic. Sampling from the
   * canvas (not the video) avoids any video-vs-canvas coordinate mismatch.
   */
  _pixelateRegion(x, y, w, h, blocks) {
    if (w <= 0 || h <= 0) return;
    const sw = Math.max(1, Math.round(w / (Math.max(w, h) / blocks)));
    const sh = Math.max(1, Math.round(h / (Math.max(w, h) / blocks)));
    if (this.tmp.width !== sw) this.tmp.width = sw;
    if (this.tmp.height !== sh) this.tmp.height = sh;

    // Downscale the region into the tiny buffer (smoothing on = averages pixels).
    this.tmpCtx.imageSmoothingEnabled = true;
    this.tmpCtx.clearRect(0, 0, sw, sh);
    this.tmpCtx.drawImage(this.canvas, x, y, w, h, 0, 0, sw, sh);

    // Upscale back over the same region with smoothing OFF = blocky mosaic.
    const prev = this.ctx.imageSmoothingEnabled;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.tmp, 0, 0, sw, sh, x, y, w, h);
    this.ctx.imageSmoothingEnabled = prev;
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
    ctx.drawImage(video, 0, 0, w, h);

    const boxes = (faceResult && faceResult.boxes) || [];
    // Detector "health" = the call succeeded (found faces OR a clean zero). Only a
    // stalled/errored detector triggers whole-frame over-blur; a healthy "no face
    // in view" blurs nothing (there is no face to leak).
    const detectorOk = !!(faceResult && faceResult.ok);
    if (detectorOk) {
      this._lastHealthyAtMs = nowMs;
      this._everHealthy = true;
    }

    // 2) Fail-safe: pixelate the whole frame only when the detector is unhealthy —
    //    never ran successfully yet, or hasn't responded within the stall window.
    const stalled = nowMs - this._lastHealthyAtMs > b.stallOverblurMs;
    const overBlur = !this._everHealthy || stalled;

    if (overBlur) {
      this._pixelateRegion(0, 0, w, h, b.mosaicBlocksFullFrame);
      return { overBlurred: true, blurredCount: boxes.length };
    }

    // 3) Normal path: pixelate each padded face region (nothing if no faces).
    let count = 0;
    for (const box of boxes) {
      const padX = box.w * b.facePaddingPct;
      const padY = box.h * b.facePaddingPct;
      const x = Math.max(0, Math.floor(box.x - padX));
      const y = Math.max(0, Math.floor(box.y - padY));
      const rw = Math.min(w - x, Math.ceil(box.w + padX * 2));
      const rh = Math.min(h - y, Math.ceil(box.h + padY * 2));
      const blocks = box.score < CONFIG.detection.faceMinConfidence
        ? b.mosaicBlocksLowConf
        : b.mosaicBlocksFace;
      this._pixelateRegion(x, y, rw, rh, blocks);
      count++;
    }
    return { overBlurred: false, blurredCount: count };
  }

  reset() {
    this._lastHealthyAtMs = 0;
    this._everHealthy = false;
  }
}
