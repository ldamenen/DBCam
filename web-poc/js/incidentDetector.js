// incidentDetector.js
// §2.2 Incident Detector — fuses fast trigger signals into "incident" state.
//
// In the PoC we wire the two triggers that make sense in a browser:
//   - Manual "Event" button  (the NON-NEGOTIABLE hard override, §2.2)
//   - Animal approach         (early trigger: seal the buildup BEFORE contact)
// Audio-loudness and IMU triggers (§2.2) are native-phase work; the trigger()
// entry point is generic so they slot in as additional sources without a rewrite.
//
// Each incident records a start/end window (in wall-clock performance.now() ms).
// The Evidence Sealer (evidenceStore.js) turns that window into a sealed raw
// segment, reaching back `prerollSeconds` before the trigger so the buildup is
// captured, and ending when the active window expires (clear + hold).

import { CONFIG } from './config.js';

export class IncidentDetector {
  /**
   * @param {Object} deps
   * @param {import('./auditLog.js').AuditLog} deps.auditLog
   * @param {(incident:Object)=>void} [deps.onIncident] fired when a NEW incident opens
   */
  constructor({ auditLog, onIncident } = {}) {
    this.auditLog = auditLog;
    this.onIncident = onIncident || (() => {});
    this._active = false;
    this._activeUntilMs = 0;
    this._current = null;
    /** @type {Array<{reason:string, reasons:string[], startMs:number, endMs:number|null, detail:Object}>} */
    this.incidents = [];
  }

  /**
   * Record a trigger. `reason` e.g. 'manual', 'animal-approach', 'audio', 'imu'.
   *
   * A trigger fired while an incident is already active only EXTENDS the active
   * window (native: keeps the evidence segment sealing until the condition clears
   * + cooldown, §2.2). It does not open a new incident, so a continuously
   * approaching animal is one incident, not one-per-frame.
   */
  trigger(reason, nowMs, detail = {}) {
    this._activeUntilMs = Math.max(this._activeUntilMs, nowMs + CONFIG.incident.holdMs);

    if (this._active) {
      if (this._current && !this._current.reasons.includes(reason)) {
        this._current.reasons.push(reason);
      }
      return this._current;
    }

    this._active = true;
    const incident = { reason, reasons: [reason], startMs: nowMs, endMs: null, detail };
    this._current = incident;
    this.incidents.push(incident);
    if (this.auditLog) this.auditLog.append('incident-open', { reason, detail }, nowMs);
    this.onIncident({ ...incident, renewed: false });
    return incident;
  }

  /** Call each frame to expire the active window. Returns current active state. */
  tick(nowMs) {
    if (this._active && nowMs >= this._activeUntilMs) {
      this._active = false;
      if (this._current) {
        this._current.endMs = this._activeUntilMs;
        if (this.auditLog) this.auditLog.append('incident-close', { reason: this._current.reason }, this._activeUntilMs);
        this._current = null;
      }
    }
    return this._active;
  }

  /** Close any still-open incident at session stop. */
  finalize(nowMs) {
    if (this._current && this._current.endMs === null) {
      this._current.endMs = nowMs;
      if (this.auditLog) this.auditLog.append('incident-close', { reason: this._current.reason, atStop: true }, nowMs);
    }
    this._active = false;
    this._current = null;
  }

  isActive() { return this._active; }
  count() { return this.incidents.length; }

  reset() {
    this._active = false;
    this._activeUntilMs = 0;
    this._current = null;
    this.incidents.length = 0;
  }
}
