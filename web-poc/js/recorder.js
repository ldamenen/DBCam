// recorder.js
// Records the BLURRED canvas stream (§11.3 step 4). We capture the canvas — the
// blurred render — never the raw <video>, so the exported file is privacy-safe by
// construction. Audio is only mixed in when the policy profile permits it.
//
// On stop we hand back a Blob + object URL for inline playback and download.

import { CONFIG } from './config.js';

export class Recorder {
  /** @param {HTMLCanvasElement} canvas the blurred preview canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.recorder = null;
    this.chunks = [];
    this.mimeType = '';
    this.stream = null;
  }

  _pickMime() {
    if (!window.MediaRecorder) return '';
    for (const m of CONFIG.recorder.mimeCandidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  /**
   * @param {MediaStreamTrack|null} audioTrack policy-gated audio, or null
   */
  start(audioTrack) {
    if (!window.MediaRecorder) throw new Error('MediaRecorder not supported in this browser.');

    // captureStream on the canvas yields the blurred frames at draw time.
    const canvasStream = this.canvas.captureStream(CONFIG.capture.frameRate.ideal || 30);
    this.stream = canvasStream;
    if (audioTrack) canvasStream.addTrack(audioTrack);

    this.mimeType = this._pickMime();
    this.chunks = [];
    const opts = this.mimeType ? { mimeType: this.mimeType } : undefined;
    this.recorder = new MediaRecorder(canvasStream, opts);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(CONFIG.recorder.timesliceMs);
  }

  isRecording() {
    return this.recorder && this.recorder.state === 'recording';
  }

  /** @returns {Promise<{blob:Blob, url:string, mimeType:string}|null>} */
  stop() {
    return new Promise((resolve) => {
      if (!this.recorder) return resolve(null);
      const rec = this.recorder;
      rec.onstop = () => {
        const type = this.mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type });
        const url = URL.createObjectURL(blob);
        // The canvas-derived tracks are cloned; stop them to release resources.
        if (this.stream) for (const t of this.stream.getTracks()) t.stop();
        this.recorder = null;
        this.stream = null;
        resolve({ blob, url, mimeType: type });
      };
      if (rec.state !== 'inactive') rec.stop();
      else resolve(null);
    });
  }
}
