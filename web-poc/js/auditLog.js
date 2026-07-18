// auditLog.js — WEB ADAPTER for the Core audit chain (ARCHITECTURE §4, §9).
// The chain rules and canonical serialization live in core/audit.js; this file
// only injects the platform hash primitive (WebCrypto SHA-256). iOS injects
// CryptoKit; Android injects its Keystore-backed digest; tests inject node:crypto.

import { AuditLog as CoreAuditLog } from '../../core/src/audit.js';

async function webCryptoSha256(str) {
  const data = new TextEncoder().encode(str);
  const buf = await window.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class AuditLog extends CoreAuditLog {
  constructor() {
    const hasSubtle = typeof window !== 'undefined' && window.crypto && window.crypto.subtle;
    super(hasSubtle ? { hashFn: webCryptoSha256 } : {});
  }
}
