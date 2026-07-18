// evidenceStore.js — WEB ADAPTER around the Core EvidenceLedger (ARCHITECTURE §4).
// The Core owns segment math, seal state, and the §6 rules (unseal-to-view,
// export-only-after-unseal, everything audit-logged). This adapter owns the
// platform bytes: recording blobs, object URLs, filenames.
//
// NOT production security (§11.2): the raw blob is not encrypted at rest and the
// "authorization" is a UI gate, not a cryptographic one (manifest: secureSealing
// unsupported on web).

import { EvidenceLedger } from '../../core/src/evidence.js';

export class EvidenceStore {
  /** @param {{auditLog: import('./auditLog.js').AuditLog}} deps */
  constructor({ auditLog } = {}) {
    this.ledger = new EvidenceLedger({ auditLog });
    this.blurred = null; // {blob,url,mimeType}
    this.raw = null;     // {blob,url,mimeType} | null when policy = blur-at-capture
  }

  setBlurred(result) { this.blurred = result; }
  setRaw(result) {
    this.raw = result;
    this.ledger.setRawAvailable(!!result);
  }
  setRawMode(mode) { this.ledger.setRawMode(mode); }

  get segments() { return this.ledger.segments; }
  buildSegments(incidents, recorderStartMs, stopMs) {
    return this.ledger.buildSegments(incidents, recorderStartMs, stopMs);
  }
  hasRaw() { return this.ledger.hasRaw(); }

  /** Unseal via the Core (logged), then attach the platform playback URL. */
  async unseal(segment, nowMs) {
    const win = await this.ledger.unseal(segment, nowMs);
    if (!win) return null;
    return { ...win, url: this.raw.url };
  }

  /** Export via the Core rules (logged), then attach platform bytes + extension. */
  async exportRaw(segment, nowMs) {
    const exp = await this.ledger.exportRaw(segment, nowMs, 'full raw file (browser cannot trim)');
    if (!exp) return null;
    const ext = this.raw.mimeType.includes('mp4') ? 'mp4' : 'webm';
    return { url: this.raw.url, filename: `${exp.filenameBase}.${ext}` };
  }
}
