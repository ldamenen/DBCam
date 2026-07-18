// core/audit.js  (shared Core — ARCHITECTURE §3, §9)
// §2.2 Audit Log — append-only, hash-chained record of sessions and incidents.
//
// The Core defines the ENTRY VOCABULARY, the canonical serialization, and the
// chaining rule, so evidence semantics can never drift between platforms. The
// hash primitive itself is INJECTED (ARCHITECTURE §2 crypto note): WebCrypto on
// web, CryptoKit on iOS, Keystore-backed on Android, node:crypto in tests.
// Golden fixtures assert identical chains across all platforms.
//
// hashFn: async (utf8String) => lowercase hex digest string.

export class AuditLog {
  /** @param {{hashFn?: (s:string)=>Promise<string>}} [deps] */
  constructor(deps = {}) {
    /** @type {Array<{seq:number, tMs:number, type:string, detail:Object, prevHash:string, hash:string}>} */
    this.entries = [];
    this._seq = 0;
    this._lastHash = '0';
    this._hashFn = deps.hashFn || fallbackHash;
  }

  /** Canonical serialization — MUST stay byte-identical across platforms. */
  static canonical(seq, tMs, type, detail, prevHash) {
    return JSON.stringify({ seq, tMs, type, detail, prevHash });
  }

  async append(type, detail, tMs) {
    const seq = ++this._seq;
    const prevHash = this._lastHash;
    const payload = AuditLog.canonical(seq, tMs, type, detail, prevHash);
    const hash = await this._hashFn(payload);
    this._lastHash = hash;
    const entry = { seq, tMs, type, detail, prevHash, hash };
    this.entries.push(entry);
    return entry;
  }

  toJSON() {
    return this.entries;
  }
}

/** Non-crypto fallback so the Core stays runnable with no injection (PoC/stubs only). */
async function fallbackHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
