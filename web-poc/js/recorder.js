// recorder.js
// Records a MediaStream to a playable Blob. Two instances are used per session:
//
//   1. BLURRED default recording — records the blurred canvas (canvas.captureStream).
//      Freely reviewable/exportable (the privacy-safe default, §2.2 Encrypted Store).
//   2. RAW evidence recording — records the camera track DIRECTLY (unblurred). This
//      is the "raw exists but is sealed" stream (§1). Recording the camera track
//      itself (not a second canvas) is cheap and gives pre-roll for free: an incident
//      just seeks back into this continuously-recorded raw.
//
// On iOS Safari, WebM is unsupported, so _pickMime falls through to video/mp4 which
// Safari can both record and play back/seek.

import { CONFIG } from './config.js';

export class Recorder {
  /**
   * @param {{canvas?: HTMLCanvasElement, stream?: MediaStream}} source
   *   Provide a canvas (recorded via captureStream) OR a ready MediaStream.
   */
  constructor(source) {
    this.source = source;
    this.recorder = null;
    this.chunks = [];
    this.mimeType = '';
    this._stream = null;
  }

  static isSupported() {
    return typeof window !== 'undefined' && !!window.MediaRecorder;
  }

  _pickMime() {
    if (!window.MediaRecorder) return '';
    for (const m of CONFIG.recorder.mimeCandidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  /**
   * @param {MediaStreamTrack|null} audioTrack policy-gated audio to mix in, or null
   */
  start(audioTrack) {
    if (!window.MediaRecorder) throw new Error('MediaRecorder not supported in this browser.');

    // Build a fresh stream so adding audio never mutates the caller's stream/canvas.
    let videoTracks;
    if (this.source.canvas) {
      const cs = this.source.canvas.captureStream(CONFIG.capture.frameRate.ideal || 30);
      videoTracks = cs.getVideoTracks();
    } else {
      videoTracks = this.source.stream.getVideoTracks();
    }
    const stream = new MediaStream(videoTracks);
    if (audioTrack) stream.addTrack(audioTrack);
    this._stream = stream;

    this.mimeType = this._pickMime();
    this.chunks = [];
    const opts = this.mimeType ? { mimeType: this.mimeType } : undefined;
    this.recorder = new MediaRecorder(stream, opts);
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
        // Only stop tracks we created for a canvas capture; do NOT stop the shared
        // camera/audio tracks here — the capture layer owns their lifecycle.
        if (this.source.canvas && this._stream) {
          for (const t of this._stream.getVideoTracks()) t.stop();
        }
        this.recorder = null;
        this._stream = null;
        resolve({ blob, url, mimeType: type });
      };
      if (rec.state !== 'inactive') rec.stop();
      else resolve(null);
    });
  }
}
