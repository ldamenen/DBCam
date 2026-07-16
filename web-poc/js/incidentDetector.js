// incidentDetector.js
// §2.2 Incident Detector — fuses fast trigger signals into "incident" state.
//
// In the PoC we wire the two triggers that make sense in a browser:
//   - Manual "Event" button  (the NON-NEGOTIABLE hard override, §2.2)
//   - Animal approach         (early trigger: seal the buildup BEFORE contact)
// Audio-loudness and IMU triggers (§2.2) are native-phase work; the trigger()
// entry point is generic so they slot in as additional sources without a rewrite.
//
// When an incident fires, native code seals the pre-roll ring buffer + live raw as
// an encrypted evidence segment (§2.2 Evidence Sealer). Here we only mark/log the
// incident and drive the UI banner (§11.2 sealing is stubbed).

import { CONFIG } from './config.js';

export class IncidentDetector {
  /**
   * @param {Object} deps
   * @param {import('./auditLog.js').AuditLog} deps.auditLog
   * @param {(incident:Object)=>void} [deps.onIncident] fired on each new/renewed trigger
   */
  constructor({ auditLog, onIncident } = {}) {
    this.auditLog = auditLog;
    this.onIncident = onIncident || (() => {});
    this._active = false;
    this._activeUntilMs = 0;
    /** @type {Array<{reason:string, tMs:number}>} */
    this.incidents = [];
  }

  /**
   * Record a trigger. `reason` e.g. 'manual', 'animal-approach', 'audio', 'imu'.
   *
   * A trigger fired while an incident is already active only EXTENDS the active
   * window (native: keeps the evidence segment sealing until the condition clears
   * + cooldown, §2.2). It does not count as a new incident, so a continuously
   * approaching animal is one incident, not one-per-frame.
   */
  trigger(reason, nowMs, detail = {}) {
    this._activeUntilMs = Math.max(this._activeUntilMs, nowMs + CONFIG.incident.holdMs);

    if (this._active) {
      // Ongoing incident: extend only. Record the extending reason on the segment.
      const current = this.incidents[this.incidents.length - 1];
      if (current && !current.reasons.includes(reason)) current.reasons.push(reason);
      return current;
    }

    this._active = true;
    const incident = { reason, reasons: [reason], tMs: nowMs, detail, sealed: false };
    this.incidents.push(incident);
    if (this.auditLog) this.auditLog.append('incident', { reason, detail }, nowMs);
    this.onIncident({ ...incident, renewed: false });
    return incident;
  }

  /** Call each frame to expire the active window. Returns current active state. */
  tick(nowMs) {
    if (this._active && nowMs >= this._activeUntilMs) {
      this._active = false;
    }
    return this._active;
  }

  isActive() {
    return this._active;
  }

  count() {
    return this.incidents.length;
  }

  reset() {
    this._active = false;
    this._activeUntilMs = 0;
    this.incidents.length = 0;
  }
}
