// ui.js
// §2.2 Review/Download UI + on-screen transparency. Owns all DOM: the blurred
// preview canvas, the debug overlay canvas (detection boxes + labels), the FPS
// counter, status pills, the active jurisdiction profile banner (§7.2 "show the
// user which profile is active"), the incident banner, and playback/download.

// Plain-language labels for trigger reasons (non-technical users).
const REASON_LABELS = {
  manual: 'button pressed',
  voice: 'safety word',
  'hostile-animal': 'animal alert',
  'animal-approach': 'animal alert',
  audio: 'loud sound',
  imu: 'sudden movement',
};
const reasonText = (reasons) => (reasons || []).map((r) => REASON_LABELS[r] || r).join(', ');

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
      soundPill: document.getElementById('soundPill'),
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
      recordings: document.getElementById('recordings'),
      recordingsList: document.getElementById('recordingsList'),
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
  setVoiceStatus(text) {
    // Map technical states to friendly words; pass listening/heard strings through.
    const friendly = {
      unsupported: 'not available in this browser',
      denied: 'microphone blocked',
      'no-mic': 'no microphone found',
      error: 'not working',
      'starting…': 'starting…',
      ready: 'ready',
      off: 'off',
    };
    this.el.voiceStatus.textContent = friendly[text] || text;
  }
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
    const days = Math.max(1, Math.round(profile.retentionSeconds / 86400));
    const rawTxt = profile.rawMode === 'raw-sealed' ? 'kept locked' : 'not kept';
    this.el.profileBanner.textContent =
      `Region: ${profile.jurisdiction} · Original video: ${rawTxt} · Sound: ${profile.audioEnabled ? 'on' : 'off'} · Auto-deletes after ${days} day${days === 1 ? '' : 's'}`;
    this.el.rawPill.textContent = `Original video: ${rawTxt}`;
    this.el.audioPill.textContent = `Sound: ${profile.audioEnabled ? 'on' : 'off'}`;
  }

  setWake(on) { this.el.wakePill.textContent = `stay-awake: ${on ? 'on' : 'off'}`; }
  setDeterrent(text) { this.el.deterrentPill.textContent = text; }
  setSoundLevel(level) {
    const pct = Math.round(level * 100);
    this.el.soundPill.textContent = `sound: ${pct}%`;
    this.el.soundPill.style.color = level > 0.45 ? 'var(--danger)' : '';
  }
  setIncidentCount(n) { this.el.incidentCount.textContent = `Alerts: ${n}`; }

  sizeCanvases(w, h) {
    this.el.preview.width = w;
    this.el.preview.height = h;
    this.el.overlay.width = w;
    this.el.overlay.height = h;
  }

  showIncident(active, reason) {
    this.el.incidentBanner.classList.toggle('active', active);
    if (active) {
      this.el.incidentBanner.textContent = `● Alert (${reasonText([reason])}) — original video is being kept`;
    } else {
      this.el.incidentBanner.textContent = '';
    }
  }

  /** Plain-language reasons string for a segment (used by main.js labels too). */
  formatReasons(reasons) { return reasonText(reasons); }

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
    this.el.downloadLink.download = `dbcam-privacy-video.${ext}`;
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
      li.textContent = 'No alerts this time.';
      list.appendChild(li);
      return;
    }

    for (const seg of segments) {
      const li = document.createElement('li');
      li.className = 'segment';
      const info = document.createElement('div');
      info.className = 'segment-info';
      info.innerHTML =
        `<span class="seg-idx">Alert ${seg.index}</span>` +
        `<span class="seg-reason">${reasonText(seg.reasons)}</span>` +
        `<span class="seg-window">${fmt(seg.startSec)}–${fmt(seg.endSec)}</span>`;
      li.appendChild(info);

      const btn = document.createElement('button');
      btn.className = 'btn small';
      if (!hasRaw) {
        btn.textContent = 'Original not kept';
        btn.disabled = true;
        btn.title = 'Your privacy settings for this region do not keep the original video.';
      } else {
        btn.textContent = '🔒 Unlock to view';
        btn.addEventListener('click', () => onUnseal(seg, li));
      }
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  markSegmentUnsealed(rowEl) {
    rowEl.classList.add('unsealed');
    const btn = rowEl.querySelector('button');
    if (btn) { btn.textContent = '🔓 Unlocked'; btn.disabled = true; }
  }

  /** Add a "Save original" button to an unlocked alert row (logged download, §6). */
  addExportButton(rowEl, onClick) {
    if (rowEl.querySelector('.btn.export')) return;
    const btn = document.createElement('button');
    btn.className = 'btn small export';
    btn.textContent = '⬇ Save original';
    btn.title = 'Saves the original video file to your device. This is noted in the activity log.';
    btn.addEventListener('click', onClick);
    rowEl.appendChild(btn);
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

  /**
   * Render the "My recordings" list of sessions saved on this device.
   * Hidden entirely when there is nothing saved.
   * @param {Array} items summaries from storageStore.listSessions
   * @param {{onWatch:(item:Object)=>void, onDelete:(item:Object)=>void}} handlers
   */
  renderRecordings(items, { onWatch, onDelete }) {
    const section = this.el.recordings;
    const list = this.el.recordingsList;
    list.innerHTML = '';
    if (!items || !items.length) { section.hidden = true; return; }
    section.hidden = false;

    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'segment recording';

      const info = document.createElement('div');
      info.className = 'segment-info';
      const when = new Date(item.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      const n = item.alertsCount || 0;
      info.innerHTML =
        `<span class="seg-idx">${escapeHtml(when)}</span>` +
        `<span class="seg-window">${fmt(item.durationMs / 1000)}</span>` +
        `<span class="seg-reason">${n} alert${n === 1 ? '' : 's'}</span>`;
      li.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'rec-actions';
      const watchBtn = document.createElement('button');
      watchBtn.className = 'btn small watch';
      watchBtn.textContent = 'Watch';
      watchBtn.addEventListener('click', () => onWatch(item));
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn small ghost delete';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => onDelete(item));
      actions.appendChild(watchBtn);
      actions.appendChild(deleteBtn);
      li.appendChild(actions);
      list.appendChild(li);
    }
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
