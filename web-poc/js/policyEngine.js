// policyEngine.js
// §7 Jurisdiction Policy Engine — INJECTABLE STUB for the web PoC.
//
// This is deliberately structured to be the "single source of truth the capture
// layer reads" (§7.2). In the PoC it returns a static, hand-picked profile and
// does NOT enforce jurisdiction law. In the native apps this module resolves the
// jurisdiction (GPS/manual) and maps it to a counsel-maintained, versioned rule
// table shipped as data. Everything downstream already consumes a `profile`
// object, so Phase 7 only has to fill in resolution — no rewrite.
//
// SAFETY DEFAULT (§7.3): when location is unknown/uncertain we fail-safe to the
// MOST RESTRICTIVE profile. The stub exposes that constant so the wiring is real.

/**
 * @typedef {Object} PolicyProfile
 * @property {string} jurisdiction        Human label, e.g. "Unknown (fail-safe)".
 * @property {'raw-sealed'|'blur-at-capture'} rawMode
 *           raw-sealed: raw exists but encrypted (native). blur-at-capture: no raw kept.
 * @property {boolean} audioEnabled       Whether audio may be captured (wiretap laws vary).
 * @property {number}  retentionSeconds   Auto-purge window for non-incident footage.
 * @property {string}  consentText        Notice/indicator text to display.
 * @property {number}  version            Ruleset version (data-driven in native).
 */

/** Most-restrictive fail-safe profile (§7.3). */
export const MOST_RESTRICTIVE_PROFILE = Object.freeze({
  jurisdiction: 'Unknown — fail-safe (most restrictive)',
  rawMode: 'blur-at-capture', // never retain raw when we cannot confirm it is legal
  audioEnabled: false,
  retentionSeconds: 24 * 60 * 60, // shortest window
  consentText: 'Privacy mode: faces blurred, no raw retained, audio off (location unconfirmed).',
  version: 0,
});

/** A demo "permissive-ish" profile used only to show the profile is injectable. */
const DEMO_DEFAULT_PROFILE = Object.freeze({
  jurisdiction: 'PoC Demo (not legally resolved)',
  rawMode: 'raw-sealed',
  audioEnabled: true,
  retentionSeconds: 7 * 24 * 60 * 60,
  consentText:
    'Recording in progress — faces blurred by default. (Demo profile: jurisdiction NOT legally resolved.)',
  version: 0,
});

export class PolicyEngine {
  /**
   * @param {Object} [opts]
   * @param {PolicyProfile} [opts.profile] Inject a specific profile (tests/native).
   * @param {boolean} [opts.failSafe] Force the most-restrictive profile.
   */
  constructor(opts = {}) {
    this._forced = opts.profile || null;
    this._failSafe = !!opts.failSafe;
    this._active = this._failSafe
      ? MOST_RESTRICTIVE_PROFILE
      : this._forced || DEMO_DEFAULT_PROFILE;
    this._listeners = new Set();
  }

  /**
   * Resolve the profile for a session. In native: GPS/manual -> rule table, with
   * re-check on boundary crossings. Here it is synchronous and static, but the
   * async shape is preserved so callers already `await` it.
   * @returns {Promise<PolicyProfile>}
   */
  async resolveForSession() {
    return this._active;
  }

  /** Current active profile. */
  getProfile() {
    return this._active;
  }

  /**
   * Swap the active profile. Native enforces "manual override may only make rules
   * STRICTER" (§7.3); the PoC just notifies listeners so the UI can reflect it.
   */
  setProfile(profile) {
    this._active = profile;
    for (const fn of this._listeners) fn(this._active);
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}
