// evidenceStore.js
// §2.2 Evidence Sealer + Encrypted Store (simplified for the web PoC).
//
// Holds the two recordings produced this session:
//   - blurred: the privacy-safe default (freely reviewable).
//   - raw:     the unblurred camera recording ("raw exists but is sealed", §1).
//
// From the incident windows it builds SEALED SEGMENTS: each is a [startSec, endSec]
// range into the raw recording, reaching back `prerollSeconds` before the trigger so
// the buildup is captured. A segment stays sealed until it is explicitly UNSEALED,
// which (in native) requires split-key authorization and is written to the audit log
// (§6). Here the authorization is simulated (a confirm), but every unseal is still
// logged, and playback is clamped to the segment window so the rest of the raw stays
// effectively sealed.
//
// NOT production security (§11.2): the raw blob is not encrypted at rest and the
// "authorization" is a UI gate, not a cryptographic one.

import { CONFIG } from './config.js';

export class EvidenceStore {
  /** @param {{auditLog: import('./auditLog.js').AuditLog}} deps */
  constructor({ auditLog } = {}) {
    this.auditLog = auditLog;
    this.blurred = null; // {blob,url,mimeType}
    this.raw = null;     // {blob,url,mimeType} | null when policy = blur-at-capture
    this.rawMode = 'raw-sealed';
    /** @type {Array<{index:number, reason:string, reasons:string[], startSec:number, endSec:number, unsealed:boolean}>} */
    this.segments = [];
  }

  setBlurred(result) { this.blurred = result; }
  setRaw(result) { this.raw = result; }
  setRawMode(mode) { this.rawMode = mode; }

  /**
   * Build sealed segments from incident windows.
   * @param {Array} incidents from IncidentDetector (startMs/endMs in perf-now ms)
   * @param {number} recorderStartMs perf-now ms when the raw recorder started (t=0)
   * @param {number} stopMs perf-now ms at session stop (fallback end)
   */
  buildSegments(incidents, recorderStartMs, stopMs) {
    const preroll = CONFIG.incident.prerollSeconds;
    this.segments = incidents.map((inc, i) => {
      const rawStart = Math.max(0, (inc.startMs - recorderStartMs) / 1000 - preroll);
      const rawEnd = ((inc.endMs || stopMs) - recorderStartMs) / 1000;
      return {
        index: i + 1,
        reason: inc.reason,
        reasons: inc.reasons || [inc.reason],
        startSec: rawStart,
        endSec: Math.max(rawEnd, rawStart + 0.3),
        unsealed: false,
      };
    });
    return this.segments;
  }

  hasRaw() {
    return this.rawMode === 'raw-sealed' && !!this.raw;
  }

  /**
   * Authorize + unseal a segment. Simulates the approver/split-key step, logs it to
   * the audit trail, and returns the playable window.
   * @returns {Promise<{startSec:number, endSec:number, url:string}|null>}
   */
  async unseal(segment, nowMs) {
    if (!this.hasRaw()) return null;
    segment.unsealed = true;
    if (this.auditLog) {
      await this.auditLog.append(
        'raw-unseal',
        { segment: segment.index, reason: segment.reason, window: [round1(segment.startSec), round1(segment.endSec)] },
        nowMs,
      );
    }
    return { startSec: segment.startSec, endSec: segment.endSec, url: this.raw.url };
  }
}

function round1(n) { return Math.round(n * 10) / 10; }
