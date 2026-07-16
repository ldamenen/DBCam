// captureLayer.js
// §2.2 Capture Layer — the SINGLE source of truth. We open the camera exactly
// once (§4 "never open the camera twice"). Everything downstream (blur render,
// detection, recording, and — in native — the encrypted raw ring buffer)
// consumes from this one stream.

import { CONFIG } from './config.js';

export class CaptureLayer {
  constructor() {
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {HTMLVideoElement|null} */
    this.video = null;
    this.width = 0;
    this.height = 0;
    this.hasAudio = false;
  }

  /**
   * Start capture. `audioAllowed` comes from the policy profile (§7) — audio is
   * NOT requested unless the active jurisdiction profile permits it.
   * @param {boolean} audioAllowed
   */
  async start(audioAllowed) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia is not available. Serve over https:// or localhost.');
    }

    const wantAudio = audioAllowed && CONFIG.capture.audio;
    const constraints = {
      video: {
        width: CONFIG.capture.width,
        height: CONFIG.capture.height,
        frameRate: CONFIG.capture.frameRate,
        facingMode: CONFIG.capture.facingMode,
      },
      audio: wantAudio,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Rear camera may not exist (desktop/laptop) — retry without facingMode.
      constraints.video = {
        width: CONFIG.capture.width,
        height: CONFIG.capture.height,
        frameRate: CONFIG.capture.frameRate,
      };
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    }

    this.hasAudio = this.stream.getAudioTracks().length > 0;

    // Hidden <video> is our raw frame source. The user NEVER sees this element;
    // the visible preview is the blurred <canvas> (§4 "raw stays sealed while
    // preview stays blurred").
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true; // avoid audio feedback in the preview path
    this.video.srcObject = this.stream;
    await this.video.play();

    const track = this.stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    this.width = settings.width || this.video.videoWidth || 1280;
    this.height = settings.height || this.video.videoHeight || 720;

    return {
      width: this.width,
      height: this.height,
      hasAudio: this.hasAudio,
      frameRate: settings.frameRate || null,
    };
  }

  /** The audio track, if any — handed to the recorder when the policy allows it. */
  getAudioTrack() {
    return this.stream ? this.stream.getAudioTracks()[0] || null : null;
  }

  stop() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
    this.width = this.height = 0;
    this.hasAudio = false;
  }
}
