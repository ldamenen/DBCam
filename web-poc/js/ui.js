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
      // Settings — location & privacy rules (§6)
      policyLocation: document.getElementById('policyLocation'),
      policyProfileName: document.getElementById('policyProfileName'),
      policySource: document.getElementById('policySource'),
      policyConfidence: document.getElementById('policyConfidence'),
      policyStatusNote: document.getElementById('policyStatusNote'),
      refreshLocationBtn: document.getElementById('refreshLocationBtn'),
      policyBlockedCard: document.getElementById('policyBlockedCard'),
      policyBlockedProfile: document.getElementById('policyBlockedProfile'),
      rulesList: document.getElementById('rulesList'),
      rulesNotes: document.getElementById('rulesNotes'),
      rulesVersionNote: document.getElementById('rulesVersionNote'),
      locModeAuto: document.getElementById('locModeAuto'),
      locModeManual: document.getElementById('locModeManual'),
      jurisdictionSelect: document.getElementById('jurisdictionSelect'),
      overrideEnable: document.getElementById('overrideEnable'),
      overrideProfileSelect: document.getElementById('overrideProfileSelect'),
      overrideMsg: document.getElementById('overrideMsg'),
      overrideBanner: document.getElementById('overrideBanner'),
      overrideBannerText: document.getElementById('overrideBannerText'),
      overrideOffBtn: document.getElementById('overrideOffBtn'),
      overrideChip: document.getElementById('overrideChip'),
      rulesetInfo: document.getElementById('rulesetInfo'),
      checkUpdatesBtn: document.getElementById('checkUpdatesBtn'),
      rulesetMsg: document.getElementById('rulesetMsg'),
      noticeStrip: document.getElementById('noticeStrip'),
      noticeStripText: document.getElementById('noticeStripText'),
      noticeStripClose: document.getElementById('noticeStripClose'),
      overrideModal: document.getElementById('overrideModal'),
      ovmContext: document.getElementById('ovmContext'),
      ovmChanges: document.getElementById('ovmChanges'),
      ovmAck: document.getElementById('ovmAck'),
      ovmCancel: document.getElementById('ovmCancel'),
      ovmConfirm: document.getElementById('ovmConfirm'),
      publishNote: document.getElementById('publishNote'),
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
      motionEnable: document.getElementById('motionEnable'),
      motionStatus: document.getElementById('motionStatus'),
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
    this._recordingAllowed = true;
    this._running = false;
    this._modalHandlers = null;
    this.el.rawPlayerClose.addEventListener('click', () => this.closeRawPlayer());
    this.el.noticeStripClose.addEventListener('click', () => this.showNotice(null));
    // Modal wiring: checkbox enables the confirm button; buttons call the
    // handlers installed by openOverrideModal.
    this.el.ovmAck.addEventListener('change', () => {
      this.el.ovmConfirm.disabled = !this.el.ovmAck.checked;
    });
    this.el.ovmCancel.addEventListener('click', () => {
      const h = this._modalHandlers;
      this.closeOverrideModal();
      if (h && h.onCancel) h.onCancel();
    });
    this.el.ovmConfirm.addEventListener('click', () => {
      if (!this.el.ovmAck.checked) return;
      const h = this._modalHandlers;
      this.closeOverrideModal();
      if (h && h.onConfirm) h.onConfirm();
    });
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

  // ===== Settings — location & privacy rules (§6) =====
  // Everything here renders PURELY from the resolved profile / engine output;
  // no per-jurisdiction strings live in the web client.

  /** Status card lines. All args are prepared display strings from main.js. */
  renderPolicyStatus({ locationLabel, profileName, sourceLabel, confidenceLabel, note }) {
    this.el.policyLocation.textContent = locationLabel;
    this.el.policyProfileName.textContent = profileName;
    this.el.policySource.textContent = sourceLabel;
    this.el.policyConfidence.textContent = confidenceLabel;
    this.el.policyStatusNote.hidden = !note;
    this.el.policyStatusNote.textContent = note || '';
  }

  onRefreshLocation(fn) { this.el.refreshLocationBtn.addEventListener('click', fn); }

  /** Red blocking card (recordingAllowed = false). Pass null to hide. */
  showBlockedCard(profileName) {
    this.el.policyBlockedCard.hidden = profileName == null;
    this.el.policyBlockedProfile.textContent = profileName || '';
  }

  /** Plain-language "what the rules here mean" list — rendered purely from
   *  profile fields, so a new jurisdiction needs zero UI changes. */
  renderRulesList(profile) {
    const rows = [
      ['Recording', profile.recordingAllowed ? 'Allowed' : 'Not allowed', !profile.recordingAllowed],
      ['Original video', profile.rawRetention === 'sealed' ? 'Kept locked' : 'Not kept', profile.rawRetention !== 'sealed'],
      ['Microphone', profile.audioCapture ? 'On' : 'Off', !profile.audioCapture],
      ['Sound-based alerts', profile.audioTriggerAllowed ? 'Available' : 'Unavailable', !profile.audioTriggerAllowed],
      ['Blur', profile.blurMode === 'facesAndBodies' ? 'Faces and bodies' : 'Faces', false],
      ['Auto-delete', `After ${profile.retentionDays} day${profile.retentionDays === 1 ? '' : 's'}`, false],
      ['Sharing and saving', profile.publishingAllowed ? 'Allowed' : 'Turned off', !profile.publishingAllowed],
    ];
    const list = this.el.rulesList;
    list.innerHTML = '';
    for (const [key, val, off] of rows) {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="rule-key">${escapeHtml(key)}</span>` +
        `<span class="rule-val${off ? ' off' : ''}">${escapeHtml(val)}</span>`;
      list.appendChild(li);
    }
  }

  /** "Why these rules?" disclosure: profile notes + ruleset provenance line. */
  renderWhyRules(profile, rulesetLine) {
    this.el.rulesNotes.textContent = profile.notes || '';
    this.el.rulesVersionNote.textContent = rulesetLine;
  }

  // --- Location detection mode ---
  onLocationModeChange(fn) {
    const emit = () => fn(this.el.locModeAuto.checked ? 'auto' : 'manual');
    this.el.locModeAuto.addEventListener('change', emit);
    this.el.locModeManual.addEventListener('change', emit);
  }
  setLocationMode(mode) {
    this.el.locModeAuto.checked = mode === 'auto';
    this.el.locModeManual.checked = mode === 'manual';
    this.el.jurisdictionSelect.hidden = mode !== 'manual';
  }
  /** Fill the manual jurisdiction <select> from engine.listJurisdictions(). */
  populateJurisdictions(jurisdictions, selectedCode) {
    const sel = this.el.jurisdictionSelect;
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'Choose where you are…';
    ph.disabled = true;
    sel.appendChild(ph);
    for (const j of jurisdictions) {
      const opt = document.createElement('option');
      opt.value = j.code;
      opt.textContent = j.displayName;
      sel.appendChild(opt);
    }
    sel.value = selectedCode || '';
    if (!sel.value) ph.selected = true;
  }
  onJurisdictionChange(fn) {
    this.el.jurisdictionSelect.addEventListener('change', () => fn(this.el.jurisdictionSelect.value));
  }

  // --- Override controls ---
  onOverrideToggle(fn) {
    this.el.overrideEnable.addEventListener('change', () => fn(this.el.overrideEnable.checked));
  }
  setOverrideChecked(checked) { this.el.overrideEnable.checked = checked; }
  /** @param {Array<{id:string, label:string}>} options prepared by main.js */
  populateOverrideProfiles(options, selectedId) {
    const sel = this.el.overrideProfileSelect;
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'Choose the rules to use…';
    ph.disabled = true;
    sel.appendChild(ph);
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = selectedId || '';
    if (!sel.value) ph.selected = true;
  }
  showOverridePicker(show) { this.el.overrideProfileSelect.hidden = !show; }
  onOverrideProfilePick(fn) {
    this.el.overrideProfileSelect.addEventListener('change', () => {
      if (this.el.overrideProfileSelect.value) fn(this.el.overrideProfileSelect.value);
    });
  }
  resetOverridePick() { this.el.overrideProfileSelect.value = ''; }
  setOverrideMessage(text) {
    this.el.overrideMsg.hidden = !text;
    this.el.overrideMsg.textContent = text || '';
  }
  /** Amber banner in Settings. Pass null to hide. */
  showOverrideBanner(text) {
    this.el.overrideBanner.hidden = text == null;
    this.el.overrideBannerText.textContent = text || '';
  }
  onOverrideOff(fn) { this.el.overrideOffBtn.addEventListener('click', fn); }
  /** Amber chip on the recording stage. */
  showOverrideChip(show) { this.el.overrideChip.hidden = !show; }

  /**
   * The loosening confirmation modal (§ override). A real HTML dialog: the
   * confirm button stays disabled until the responsibility checkbox is ticked.
   * @param {{contextLines:string[], sentences:string[], onConfirm:()=>void, onCancel:()=>void}} opts
   */
  openOverrideModal({ contextLines, sentences, onConfirm, onCancel }) {
    this.el.ovmContext.innerHTML = contextLines.map((l) => escapeHtml(l)).join('<br>');
    const ul = this.el.ovmChanges;
    ul.innerHTML = '';
    for (const s of sentences) {
      const li = document.createElement('li');
      li.textContent = s;
      ul.appendChild(li);
    }
    this.el.ovmAck.checked = false;
    this.el.ovmConfirm.disabled = true;
    this._modalHandlers = { onConfirm, onCancel };
    this.el.overrideModal.hidden = false;
  }
  closeOverrideModal() {
    this._modalHandlers = null;
    this.el.overrideModal.hidden = true;
  }

  // --- Ruleset row ---
  setRulesetInfo(text) { this.el.rulesetInfo.textContent = text; }
  onCheckUpdates(fn) { this.el.checkUpdatesBtn.addEventListener('click', fn); }
  setRulesetMessage(text) {
    this.el.rulesetMsg.hidden = !text;
    this.el.rulesetMsg.textContent = text || '';
  }

  /** Dismissible notice strip over the stage (profile.noticeText). */
  showNotice(text) {
    this.el.noticeStrip.hidden = text == null;
    this.el.noticeStripText.textContent = text || '';
  }

  /** Gate the REC indicator + privacy badge (requiresVisibleIndicator). */
  setVisibleIndicator(required) {
    document.body.classList.toggle('no-indicator', !required);
  }

  /** App-wide start gate: recordingAllowed=false keeps Start disabled. */
  setRecordingAllowed(allowed) {
    this._recordingAllowed = allowed;
    this.el.startBtn.disabled = this._running || !this._recordingAllowed;
  }

  setRunning(running) {
    this._running = running;
    this.el.startBtn.disabled = running || !this._recordingAllowed;
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

  // --- Movement (shake/fall) trigger controls ---
  onMotionChange(fn) {
    this.el.motionEnable.addEventListener('change', () => fn(this.getMotionConfig()));
  }
  getMotionConfig() {
    return { enabled: this.el.motionEnable.checked };
  }
  setMotionConfig({ enabled }) {
    if (typeof enabled === 'boolean') this.el.motionEnable.checked = enabled;
  }
  setMotionStatus(text) {
    // Map technical states to friendly words (plain language for the chip).
    const friendly = {
      unsupported: 'not available on this device',
      denied: 'no permission',
      'starting…': 'starting…',
      on: 'on',
      ready: 'ready',
      off: 'off',
    };
    this.el.motionStatus.textContent = friendly[text] || text;
  }

  /** Live detector readout: face count + whether the fail-safe over-blur is active. */
  setDetectorStatus({ ok, faces, overBlurred }) {
    let txt;
    if (overBlurred) txt = ok ? `detector: ok · over-blur (no face)` : 'detector: STALLED · over-blur';
    else txt = `detector: ok · faces ${faces}`;
    this.el.detPill.textContent = txt;
    this.el.detPill.style.color = overBlurred && !ok ? 'var(--danger)' : '';
  }

  /** Compact banner + pills for the ACTIVE policy profile (new engine shape). */
  showProfile(profile) {
    const days = profile.retentionDays;
    const rawTxt = profile.rawRetention === 'sealed' ? 'kept locked' : 'not kept';
    this.el.profileBanner.textContent =
      `Rules: ${profile.displayName} · Original video: ${rawTxt} · Sound: ${profile.audioCapture ? 'on' : 'off'} · Auto-deletes after ${days} day${days === 1 ? '' : 's'}`;
    this.el.rawPill.textContent = `Original video: ${rawTxt}`;
    this.el.audioPill.textContent = `Sound: ${profile.audioCapture ? 'on' : 'off'}`;
  }

  setWake(on) { this.el.wakePill.textContent = `stay-awake: ${on ? 'on' : 'off'}`; }
  setDeterrent(text) { this.el.deterrentPill.textContent = text; }
  setSoundLevel(level) {
    const pct = Math.round(level * 100);
    this.el.soundPill.textContent = `sound: ${pct}%`;
    this.el.soundPill.style.color = level > 0.45 ? 'var(--danger)' : '';
  }
  /** Sound-based alerts unavailable under the active privacy rules. */
  setSoundDisabledByPolicy() {
    this.el.soundPill.textContent = 'sound: off (privacy rules)';
    this.el.soundPill.style.color = '';
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

  /**
   * @param {boolean} [publishingAllowed] false hides the "Save privacy video"
   *   download and shows the plain-language note instead (§7 publishing gate).
   */
  showPlayback(url, mimeType, publishingAllowed = true) {
    if (!url) return;
    this.el.reviewHeader.hidden = false;
    this.el.playback.hidden = false;
    this.el.playbackVideo.src = url;
    this.el.downloadLink.hidden = !publishingAllowed;
    this.el.publishNote.hidden = !!publishingAllowed;
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

  /** In place of the export button when publishingAllowed=false. */
  addExportBlockedNote(rowEl) {
    if (rowEl.querySelector('.export-note')) return;
    const note = document.createElement('span');
    note.className = 'export-note seg-reason';
    note.textContent = "Saving and sharing are turned off by this location's privacy rules.";
    rowEl.appendChild(note);
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
      const overrideTag = item.policy && item.policy.isOverride
        ? '<span class="tag-badge locked override-tag" title="Recorded under a user override of the location-based rules">Override</span>'
        : '';
      info.innerHTML =
        `<span class="seg-idx">${escapeHtml(when)}</span>` +
        `<span class="seg-window">${fmt(item.durationMs / 1000)}</span>` +
        `<span class="seg-reason">${n} alert${n === 1 ? '' : 's'}</span>` +
        overrideTag;
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

/**
 * Plain-words sentence for ONE changed policy field ({field, from, to} from
 * Core profileDiff). Covers every PROFILE_POLICY_FIELDS entry in BOTH
 * directions — the Core computes the facts, this renders the words.
 * @param {{field:string, from:*, to:*}} change
 * @returns {string}
 */
export function describePolicyChange({ field, from, to }) {
  switch (field) {
    case 'recordingAllowed':
      return to
        ? 'Recording will become available.'
        : 'Recording will no longer be available.';
    case 'rawRetention':
      return to === 'sealed'
        ? 'The original (unblurred) video will now be kept, locked, on this device.'
        : 'The original (unblurred) video will no longer be kept.';
    case 'audioCapture':
      return to
        ? 'The microphone will be turned on — sound will be recorded.'
        : 'The microphone will be turned off — no sound will be recorded.';
    case 'audioTriggerAllowed':
      return to
        ? 'Sound-based alerts will become available.'
        : 'Sound-based alerts will be turned off.';
    case 'blurMode':
      return to === 'facesAndBodies'
        ? 'Faces and whole bodies will be hidden in the video.'
        : 'Only faces will be hidden — bodies will be visible.';
    case 'retentionDays':
      return `Recordings will now be deleted after ${to} day${to === 1 ? '' : 's'} instead of ${from}.`;
    case 'requiresVisibleIndicator':
      return to
        ? 'The visible recording indicator will always be shown.'
        : 'The visible recording indicator will no longer be required.';
    case 'noticeText':
      return to
        ? 'A recording notice will be shown while you record.'
        : 'The recording notice will no longer be shown.';
    case 'publishingAllowed':
      return to
        ? 'Saving and sharing recordings will be allowed.'
        : 'Saving and sharing recordings will be turned off.';
    default:
      return `${field}: ${String(from)} → ${String(to)}`;
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
