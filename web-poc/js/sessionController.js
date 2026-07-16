// sessionController.js
// §2.2 Session Controller — owns the session lifecycle: start -> keep-awake ->
// run -> stop. In the browser "disable auto-lock" is the Screen Wake Lock API,
// which is best-effort and can be released by the OS (§11.2), so we re-acquire it
// on visibility changes.
//
// It also tracks interruption GAP MARKERS (§2.2, §4): if the tab is backgrounded
// or the camera is lost, we record a gap so the record's integrity is auditable.

export class SessionController {
  constructor({ auditLog } = {}) {
    this.auditLog = auditLog;
    this.active = false;
    this.startedAtMs = 0;
    this._wakeLock = null;
    /** @type {Array<{type:string, fromMs:number, toMs:number|null}>} */
    this.gaps = [];
    this._onVisibility = this._handleVisibility.bind(this);
  }

  async start(nowMs) {
    this.active = true;
    this.startedAtMs = nowMs;
    this.gaps = [];
    await this._acquireWakeLock();
    document.addEventListener('visibilitychange', this._onVisibility);
    if (this.auditLog) this.auditLog.append('session-start', {}, nowMs);
  }

  async _acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this._wakeLock = await navigator.wakeLock.request('screen');
        this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
      }
    } catch (_e) {
      this._wakeLock = null; // denied or unsupported; PoC continues without it
    }
  }

  _handleVisibility() {
    if (!this.active) return;
    if (document.visibilityState === 'hidden') {
      // Interruption: mark an open gap (§4). Browsers throttle hidden tabs, so the
      // capture/recording effectively pauses.
      this.gaps.push({ type: 'backgrounded', fromMs: performance.now(), toMs: null });
      if (this.auditLog) this.auditLog.append('gap-open', { type: 'backgrounded' }, performance.now());
    } else {
      // Returned to foreground: close the last open gap and re-acquire wake lock.
      const open = [...this.gaps].reverse().find((g) => g.toMs === null);
      if (open) open.toMs = performance.now();
      if (this.auditLog) this.auditLog.append('gap-close', {}, performance.now());
      this._acquireWakeLock();
    }
  }

  /** Called by the pipeline if the camera track ends unexpectedly. */
  markCameraLost(nowMs) {
    this.gaps.push({ type: 'camera-lost', fromMs: nowMs, toMs: null });
    if (this.auditLog) this.auditLog.append('gap-open', { type: 'camera-lost' }, nowMs);
  }

  async stop(nowMs) {
    this.active = false;
    document.removeEventListener('visibilitychange', this._onVisibility);
    for (const g of this.gaps) if (g.toMs === null) g.toMs = nowMs;
    if (this._wakeLock) {
      try { await this._wakeLock.release(); } catch (_e) {}
      this._wakeLock = null;
    }
    if (this.auditLog) this.auditLog.append('session-stop', { gaps: this.gaps.length }, nowMs);
  }

  hasWakeLock() {
    return !!this._wakeLock;
  }
}
