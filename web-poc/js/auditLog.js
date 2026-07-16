// auditLog.js
// §2.2 Audit Log — append-only record of sessions and incidents.
//
// The native app makes this a hash-chained, tamper-evident log and records every
// raw-segment unseal/view/export with identity + timestamp (§6). This PoC keeps
// the append-only shape and a simple running hash so the seam is real, but it is
// in-memory only and is NOT a security guarantee (§11.2).

export class AuditLog {
  constructor() {
    /** @type {Array<{seq:number, tMs:number, type:string, detail:Object, prevHash:string, hash:string}>} */
    this.entries = [];
    this._seq = 0;
    this._lastHash = '0';
  }

  async _hash(str) {
    // Best-effort chaining hash. Web Crypto is async; callers may ignore ordering.
    if (window.crypto && window.crypto.subtle) {
      const data = new TextEncoder().encode(str);
      const buf = await window.crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback non-crypto hash (PoC only).
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  async append(type, detail, tMs) {
    const seq = ++this._seq;
    const prevHash = this._lastHash;
    const payload = JSON.stringify({ seq, tMs, type, detail, prevHash });
    const hash = await this._hash(payload);
    this._lastHash = hash;
    const entry = { seq, tMs, type, detail, prevHash, hash };
    this.entries.push(entry);
    return entry;
  }

  toJSON() {
    return this.entries;
  }
}
