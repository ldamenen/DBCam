// storageStore.js — WEB ADAPTER for on-device recording persistence (IndexedDB).
// Owns only the platform bytes: saving/loading finished sessions so they survive
// a page reload. It carries NO rules — what gets stored (blurred default, sealed
// raw, audit snapshot) and for how long (the active policy profile's retention)
// is decided by the Core; this file just reads and writes records.
//
// PRIVACY RULE (enforced here mechanically, decided by the Core evidence rules):
// unlock state is NEVER persisted — segments are always stored `unsealed: false`,
// so every saved recording starts locked again when watched later.
//
// NOT production security (§11.2): browser storage is not hardware-encrypted
// (manifest: secureSealing unsupported on web). Native clients use encrypted
// files + Keystore/Secure Enclave behind the same record shape.

const DB_NAME = 'dbcam';
const DB_VERSION = 1;
const STORE = 'sessions';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

/** Run `fn(objectStore)` in a transaction; resolves with fn's request result. */
async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      const req = fn(tx.objectStore(STORE));
      let result;
      if (req && 'onsuccess' in req) {
        req.onsuccess = () => { result = req.result; };
        req.onerror = () => reject(req.error);
      }
      tx.oncomplete = () => resolve(result);
    });
  } finally {
    db.close();
  }
}

/** Walk every record with a cursor; `visit(cursor)` runs per record. */
async function eachRecord(mode, direction, visit) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      const cursorReq = tx.objectStore(STORE).openCursor(null, direction);
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return resolve();
        visit(cursor);
        cursor.continue();
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Save (or update, when `record.id` is set) a finished session record.
 * Segments are always normalized to `unsealed: false` before writing — unlock
 * state must not persist across loads.
 * @returns {Promise<number>} the record id
 */
export async function saveSession(record) {
  const toStore = {
    ...record,
    segments: (record.segments || []).map((s) => ({ ...s, unsealed: false })),
  };
  return withStore('readwrite', (store) => store.put(toStore));
}

/**
 * List saved sessions, newest first, WITHOUT the video blobs (summary
 * projection only — cheap enough to render a list from).
 * @returns {Promise<Array<{id:number, createdAt:number, durationMs:number,
 *   alertsCount:number, version:string, profile:Object, hasRaw:boolean}>>}
 */
export async function listSessions() {
  const summaries = [];
  await eachRecord('readonly', 'prev', (cursor) => {
    const r = cursor.value;
    summaries.push({
      id: r.id,
      createdAt: r.createdAt,
      durationMs: r.durationMs,
      alertsCount: r.alertsCount,
      version: r.version,
      profile: r.profile,
      hasRaw: !!r.raw,
    });
  });
  // Cursor 'prev' walks ids descending (insertion order); sort by time to be safe.
  summaries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return summaries;
}

/** Load one full session record (with blobs), or undefined if missing. */
export async function getSession(id) {
  return withStore('readonly', (store) => store.get(id));
}

/** Delete one saved session. */
export async function deleteSession(id) {
  return withStore('readwrite', (store) => store.delete(id));
}

/**
 * Purge sessions older than `ms` (from the active policy profile's retention —
 * the caller passes `retentionSeconds * 1000`; no numbers live here).
 * @returns {Promise<number>} how many records were removed
 */
export async function purgeOlderThan(ms) {
  const cutoff = Date.now() - ms;
  let removed = 0;
  await eachRecord('readwrite', 'next', (cursor) => {
    if ((cursor.value.createdAt || 0) < cutoff) {
      cursor.delete();
      removed++;
    }
  });
  return removed;
}
