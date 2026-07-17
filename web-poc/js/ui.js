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
      detPill: document.getElementById('detPill'),
      version: document.getElementById('version'),
      sessionState: document.getElementById('sessionState'),
      recTimer: document.getElementById('recTimer'),
      reviewHeader: document.getElementById('reviewHeader'),
      voiceEnable: document.getElementById('voiceEnable'),
      voiceWord: document.getElementById('voiceWord'),
      voiceStatus: document.getElementById('voiceStatus'),
      playback: document.getElementById('playback'),
      playbackVideo: document.getElementById('playbackVideo'),
      downloadLink: document.getElementById('downloadLink'),
      evidence: document.getElementById('evidence'),
      segmentList: document.getElementById('segmentList'),
      prerollLabel: document.getElementById('prerollLabel'),
      rawPlayerWrap: document.getElementById('rawPlayerWrap'),
      rawPlayerLabel: document.getElementById('rawPlayerLabel'),
      rawPlayerClose: document.getElementById('rawPlayerClose'),
      rawVideo: document.getElementById('rawVideo'),
      auditSection: document.getElementById('auditSection'),
      auditList: document.getElementById('auditList'),
    };
    this.overlayCtx = this.el.overlay.getContext('2d');
    this._fpsSamples = [];
    this._rawClampHandler = null;
    this.el.rawPlayerClose.addEventListener('click', () => this.closeRawPlayer());
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
    document.body.classList.toggle('running', running);
    if (running) document.body.classList.add('started');
  }

  setStatus(text) { this.el.status.textContent = text; }

  setVersion(v) { if (this.el.version) this.el.version.textContent = v; }

  /** Header state chip: 'idle' | 'recording' | 'review'. */
  setSessionState(state) {
    const label = { idle: 'Idle', recording: 'Recording', review: 'Review' }[state] || state;
    this.el.sessionState.textContent = label;
    this.el.sessionState.className = `state-chip ${state}`;
  }

  setRecTimer(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    this.el.recTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // --- Voice trigger controls ---
  onVoiceChange(fn) {
    const emit = () => fn(this.getVoiceConfig());
    this.el.voiceEnable.addEventListener('change', emit);
    this.el.voiceWord.addEventListener('change', emit);
  }
  getVoiceConfig() {
    return { enabled: this.el.voiceEnable.checked, word: this.el.voiceWord.value.trim() };
  }
  setVoiceConfig({ enabled, word }) {
    if (typeof enabled === 'boolean') this.el.voiceEnable.checked = enabled;
    if (typeof word === 'string' && word) this.el.voiceWord.value = word;
  }
  setVoiceStatus(text) { this.el.voiceStatus.textContent = `voice: ${text}`; }
  flashVoiceHeard() {
    this.el.voiceStatus.classList.add('hit');
    setTimeout(() => this.el.voiceStatus.classList.remove('hit'), 1200);
  }

  /** Live detector readout: face count + whether the fail-safe over-blur is active. */
  setDetectorStatus({ ok, faces, overBlurred }) {
    let txt;
    if (overBlurred) txt = ok ? `detector: ok · over-blur (no face)` : 'detector: STALLED · over-blur';
    else txt = `detector: ok · faces ${faces}`;
    this.el.detPill.textContent = txt;
    this.el.detPill.style.color = overBlurred && !ok ? 'var(--danger)' : '';
  }

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
  drawOverlay({ faces = [], animals = [], overBlurred = false, threat = null }) {
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

    // Animals. The primary subject shows a threat meter; red when hostile.
    for (const a of animals) {
      const isSubject = threat && threat.animal === a;
      const hostile = isSubject && threat.hostile;
      ctx.strokeStyle = hostile ? 'rgba(255,60,60,0.98)' : 'rgba(255,170,40,0.9)';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = hostile ? Math.max(3, w / 260) : Math.max(2, w / 400);
      ctx.strokeRect(a.x, a.y, a.w, a.h);
      let label = `${a.label} ${(a.score * 100).toFixed(0)}%`;
      if (isSubject) {
        const pct = Math.round(threat.threatScore * 100);
        label = hostile
          ? `⚠ THREAT ${pct}% · ${threat.reasons.join(', ') || 'hostile'}`
          : `${a.label} · threat ${pct}%`;
      }
      ctx.fillText(label, a.x + 3, a.y + 3);
    }

    if (overBlurred) {
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillText('FAIL-SAFE: full-frame over-blur', 8, 8);
    }
  }

  showPlayback(url, mimeType) {
    if (!url) return;
    this.el.reviewHeader.hidden = false;
    this.el.playback.hidden = false;
    this.el.playbackVideo.src = url;
    this.el.downloadLink.href = url;
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    this.el.downloadLink.download = `dbcam-blurred-session.${ext}`;
  }

  /**
   * Render the sealed-evidence review list.
   * @param {Array} segments from EvidenceStore.buildSegments
   * @param {Object} opts
   * @param {boolean} opts.hasRaw whether raw was retained (policy = raw-sealed)
   * @param {number} opts.prerollSeconds
   * @param {(segment:Object, rowEl:HTMLElement)=>void} opts.onUnseal
   */
  renderEvidence(segments, { hasRaw, prerollSeconds, onUnseal }) {
    this.el.reviewHeader.hidden = false;
    this.el.evidence.hidden = false;
    this.el.prerollLabel.textContent = String(prerollSeconds);
    const list = this.el.segmentList;
    list.innerHTML = '';

    if (!segments.length) {
      const li = document.createElement('li');
      li.className = 'segment empty';
      li.textContent = 'No incidents were flagged this session — nothing to seal.';
      list.appendChild(li);
      return;
    }

    for (const seg of segments) {
      const li = document.createElement('li');
      li.className = 'segment';
      const info = document.createElement('div');
      info.className = 'segment-info';
      info.innerHTML =
        `<span class="seg-idx">Incident ${seg.index}</span>` +
        `<span class="seg-reason">${seg.reasons.join(', ')}</span>` +
        `<span class="seg-window">${fmt(seg.startSec)}–${fmt(seg.endSec)}</span>`;
      li.appendChild(info);

      const btn = document.createElement('button');
      btn.className = 'btn small';
      if (!hasRaw) {
        btn.textContent = 'No raw retained';
        btn.disabled = true;
        btn.title = 'Policy profile = blur-at-capture: raw was not recorded.';
      } else {
        btn.textContent = '🔒 Authorize & unseal';
        btn.addEventListener('click', () => onUnseal(seg, li));
      }
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  markSegmentUnsealed(rowEl) {
    rowEl.classList.add('unsealed');
    const btn = rowEl.querySelector('button');
    if (btn) { btn.textContent = '🔓 Unsealed'; btn.disabled = true; }
  }

  /** Play the raw recording clamped to [startSec, endSec]. */
  playRawWindow(url, startSec, endSec, label) {
    this.el.rawPlayerWrap.hidden = false;
    this.el.rawPlayerLabel.textContent = label || 'Unsealed segment';
    const v = this.el.rawVideo;
    if (this._rawClampHandler) v.removeEventListener('timeupdate', this._rawClampHandler);

    const seekAndPlay = () => {
      try { v.currentTime = startSec; } catch (_e) {}
      v.play().catch(() => {});
    };
    if (v.src !== url) {
      v.src = url;
      v.addEventListener('loadedmetadata', seekAndPlay, { once: true });
    } else {
      seekAndPlay();
    }
    // Clamp playback to the incident window so the rest of the raw stays sealed.
    this._rawClampHandler = () => {
      if (v.currentTime >= endSec) { v.pause(); }
      if (v.currentTime < startSec - 0.1) { v.currentTime = startSec; }
    };
    v.addEventListener('timeupdate', this._rawClampHandler);
    this.el.rawPlayerWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  closeRawPlayer() {
    const v = this.el.rawVideo;
    v.pause();
    if (this._rawClampHandler) { v.removeEventListener('timeupdate', this._rawClampHandler); this._rawClampHandler = null; }
    this.el.rawPlayerWrap.hidden = true;
  }

  renderAuditLog(entries) {
    if (!entries || !entries.length) return;
    this.el.auditSection.hidden = false;
    const ol = this.el.auditList;
    ol.innerHTML = '';
    for (const e of entries) {
      const li = document.createElement('li');
      li.className = 'audit-entry';
      const hashShort = (e.hash || '').slice(0, 10);
      li.innerHTML =
        `<span class="a-seq">#${e.seq}</span>` +
        `<span class="a-type">${e.type}</span>` +
        `<span class="a-detail">${escapeHtml(JSON.stringify(e.detail))}</span>` +
        `<span class="a-hash" title="chained hash">${hashShort}…</span>`;
      ol.appendChild(li);
    }
  }

  clearOverlay() {
    this.overlayCtx.clearRect(0, 0, this.el.overlay.width, this.el.overlay.height);
  }
}

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
