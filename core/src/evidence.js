// core/evidence.js  (shared Core — ARCHITECTURE §3)
// §2.2 Evidence Sealer — the DECISION half of evidence handling.
//
// The Core owns: segment math (pre-roll reach-back, window clamping), seal state,
// and the authorization rules (unseal before view; export only after unseal; both
// audit-logged). Platforms own the bytes: blobs/files, players, download/share.
//
// Time convention: incident times are platform-monotonic ms (performance.now() on
// web); segment windows are SECONDS into the raw recording (recorder start = 0).

import { CONFIG } from './config.js';

/**
 * Build sealed segments from incident windows. Pure function — fixture-tested.
 * @param {Array<{reason:string, reasons?:string[], startMs:number, endMs:number|null}>} incidents
 * @param {number} recorderStartMs platform-monotonic ms when the raw recorder started
 * @param {number} stopMs platform-monotonic ms at session stop (fallback end)
 * @param {number} [prerollSeconds=CONFIG.incident.prerollSeconds]
 */
export function buildSegments(incidents, recorderStartMs, stopMs, prerollSeconds = CONFIG.incident.prerollSeconds) {
  return incidents.map((inc, i) => {
    const rawStart = Math.max(0, (inc.startMs - recorderStartMs) / 1000 - prerollSeconds);
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
}

/**
 * Seal-state ledger: tracks segments and enforces the §6 rules. The audit log is
 * injected; media handles stay with the platform.
 */
export class EvidenceLedger {
  /** @param {{auditLog: import('./audit.js').AuditLog}} deps */
  constructor({ auditLog } = {}) {
    this.auditLog = auditLog;
    this.rawMode = 'raw-sealed';
    this.rawAvailable = false;
    /** @type {ReturnType<typeof buildSegments>} */
    this.segments = [];
  }

  setRawMode(mode) { this.rawMode = mode; }
  setRawAvailable(available) { this.rawAvailable = !!available; }

  hasRaw() {
    return this.rawMode === 'raw-sealed' && this.rawAvailable;
  }

  buildSegments(incidents, recorderStartMs, stopMs) {
    this.segments = buildSegments(incidents, recorderStartMs, stopMs);
    return this.segments;
  }

  /**
   * Authorize + unseal a segment: logged, returns the playable window (platform
   * clamps its player to it). Null when policy retained no raw.
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
    return { startSec: segment.startSec, endSec: segment.endSec };
  }

  /**
   * Export rule (§6): only an UNSEALED segment may be exported, and every export
   * is audit-logged. Returns a filename base; the platform attaches bytes + ext.
   */
  async exportRaw(segment, nowMs, note) {
    if (!this.hasRaw() || !segment.unsealed) return null;
    if (this.auditLog) {
      await this.auditLog.append(
        'raw-export',
        { segment: segment.index, reason: segment.reason, ...(note ? { note } : {}) },
        nowMs,
      );
    }
    return { filenameBase: `dbcam-raw-incident-${segment.index}` };
  }
}

function round1(n) { return Math.round(n * 10) / 10; }
