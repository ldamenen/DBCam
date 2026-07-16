// ui.js
// §2.2 Review/Download UI + on-screen transparency. Owns all DOM: the blurred
// preview canvas, the debug overlay canvas (detection boxes + labels), the FPS
// counter, status pills, the active jurisdiction profile banner (§7.2 "show the
// user which profile is active"), the incident banner, and playback/download.

export class UI {
  constructor() {
    this.el = {
      startBtn: document.getElementById('startBtn'),
      stopBtn: document.getElementById('stopBtn'),
      eventBtn: document.getElementById('eventBtn'),
      sensitivity: document.getElementById('sensitivity'),
      sensitivityVal: document.getElementById('sensitivityVal'),
      preview: document.getElementById('preview'),      // blurred canvas
      overlay: document.getElementById('overlay'),      // debug boxes canvas
      fps: document.getElementById('fps'),
      status: document.getElementById('status'),
      profileBanner: document.getElementById('profileBanner'),
      incidentBanner: document.getElementById('incidentBanner'),
      wakePill: document.getElementById('wakePill'),
      audioPill: document.getElementById('audioPill'),
      rawPill: document.getElementById('rawPill'),
      deterrentPill: document.getElementById('deterrentPill'),
      incidentCount: document.getElementById('incidentCount'),
      playback: document.getElementById('playback'),
      playbackVideo: document.getElementById('playbackVideo'),
      downloadLink: document.getElementById('downloadLink'),
    };
    this.overlayCtx = this.el.overlay.getContext('2d');
    this._fpsSamples = [];
  }

  onStart(fn) { this.el.startBtn.addEventListener('click', fn); }
  onStop(fn) { this.el.stopBtn.addEventListener('click', fn); }
  onEvent(fn) { this.el.eventBtn.addEventListener('click', fn); }
  onSensitivity(fn) {
    this.el.sensitivity.addEventListener('input', () => {
      const v = Number(this.el.sensitivity.value) / 100;
      this.el.sensitivityVal.textContent = `${this.el.sensitivity.value}%`;
      fn(v);
    });
  }

  setRunning(running) {
    this.el.startBtn.disabled = running;
    this.el.stopBtn.disabled = !running;
    this.el.eventBtn.disabled = !running;
  }

  setStatus(text) { this.el.status.textContent = text; }

  showProfile(profile) {
    this.el.profileBanner.textContent =
      `Jurisdiction: ${profile.jurisdiction} · raw: ${profile.rawMode} · audio: ${profile.audioEnabled ? 'on' : 'off'} · retention: ${Math.round(profile.retentionSeconds / 3600)}h`;
    this.el.rawPill.textContent = `raw: ${profile.rawMode}`;
    this.el.audioPill.textContent = `audio: ${profile.audioEnabled ? 'on' : 'off'}`;
  }

  setWake(on) { this.el.wakePill.textContent = `wake-lock: ${on ? 'held' : 'none'}`; }
  setDeterrent(text) { this.el.deterrentPill.textContent = text; }
  setIncidentCount(n) { this.el.incidentCount.textContent = `incidents: ${n}`; }

  sizeCanvases(w, h) {
    this.el.preview.width = w;
    this.el.preview.height = h;
    this.el.overlay.width = w;
    this.el.overlay.height = h;
  }

  showIncident(active, reason) {
    this.el.incidentBanner.classList.toggle('active', active);
    if (active) {
      this.el.incidentBanner.textContent = `● INCIDENT (${reason}) — pre-roll would be sealed (native)`;
    } else {
      this.el.incidentBanner.textContent = '';
    }
  }

  updateFps(dtMs) {
    this._fpsSamples.push(dtMs);
    if (this._fpsSamples.length > 30) this._fpsSamples.shift();
    const avg = this._fpsSamples.reduce((a, b) => a + b, 0) / this._fpsSamples.length;
    const fps = avg > 0 ? 1000 / avg : 0;
    this.el.fps.textContent = `${fps.toFixed(0)} fps`;
  }

  /** Draw debug detection boxes on the overlay (does not affect the recording). */
  drawOverlay({ faces = [], animals = [], overBlurred = false, approach = null }) {
    const ctx = this.overlayCtx;
    const w = this.el.overlay.width;
    const h = this.el.overlay.height;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = Math.max(2, w / 400);
    ctx.font = `${Math.max(12, w / 60)}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';

    // Faces (green) — boxes only; the face pixels underneath are already blurred.
    ctx.strokeStyle = 'rgba(80,220,120,0.9)';
    ctx.fillStyle = 'rgba(80,220,120,0.9)';
    for (const f of faces) {
      ctx.strokeRect(f.x, f.y, f.w, f.h);
      ctx.fillText(`face ${(f.score * 100).toFixed(0)}%`, f.x + 3, f.y + 3);
    }

    // Animals (orange, red if approaching).
    for (const a of animals) {
      const isThreat = approach && approach.animal === a && approach.approaching;
      ctx.strokeStyle = isThreat ? 'rgba(255,60,60,0.95)' : 'rgba(255,170,40,0.9)';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.strokeRect(a.x, a.y, a.w, a.h);
      ctx.fillText(`${a.label} ${(a.score * 100).toFixed(0)}%`, a.x + 3, a.y + 3);
    }

    if (overBlurred) {
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillText('FAIL-SAFE: full-frame over-blur', 8, 8);
    }
  }

  showPlayback(url, mimeType) {
    if (!url) return;
    this.el.playback.hidden = false;
    this.el.playbackVideo.src = url;
    this.el.downloadLink.href = url;
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    this.el.downloadLink.download = `dbcam-blurred-session.${ext}`;
  }

  clearOverlay() {
    this.overlayCtx.clearRect(0, 0, this.el.overlay.width, this.el.overlay.height);
  }
}
