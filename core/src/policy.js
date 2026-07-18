// core/policy.js  (shared Core — ARCHITECTURE §3)
// §7 Jurisdiction Policy Engine — data-driven region table + strictness rules.
//
// This module is the "single source of truth the capture layer reads" (§7.2).
// Jurisdiction rules live HERE as versioned data (POLICY_RULESET); adapters and
// UI carry no rules of their own. Downstream code consumes a `profile` object.
//
// ⚠️ DEMO VALUES ONLY — the region table below is illustrative and MUST be
// reviewed by counsel before any real deployment. It is not legal advice and
// does not enforce real law.
//
// RESOLUTION IN THIS RELEASE: there is NO automatic (GPS) resolution yet —
// offline reverse-geocoding needs bundled boundary data, which is native-phase
// work. The engine resolves purely from the user's manual region selection,
// with 'unknown' (the most-restrictive fail-safe, §7.3) as the default.
// `applyOverride` already implements the §7.3 rule "manual selection may only
// make rules stricter than an auto-resolved profile, never looser" so the
// auto path can plug in later without changing any caller.

/**
 * @typedef {Object} PolicyProfile
 * @property {string} regionId            Region table id, e.g. 'us-il'.
 * @property {string} jurisdiction        Plain-language label, e.g. "Europe (EU)".
 * @property {'raw-sealed'|'blur-at-capture'} rawMode
 *           raw-sealed: raw exists but sealed. blur-at-capture: no raw kept.
 * @property {boolean} audioEnabled       Whether audio may be captured (wiretap laws vary).
 * @property {number}  retentionSeconds   Auto-purge window for non-incident footage.
 * @property {string}  consentText        Notice/indicator text to display.
 * @property {number}  version            POLICY_RULESET version this profile came from.
 */

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

const RULESET_VERSION = 1;

const profile = (p) => Object.freeze({ version: RULESET_VERSION, ...p });

/**
 * Versioned region table (§7). ⚠️ DEMO VALUES ONLY — must be reviewed by
 * counsel before real deployment. Shipped as bundled data (ARCHITECTURE §0);
 * updated by shipping a new release, never fetched.
 */
export const POLICY_RULESET = Object.freeze({
  version: RULESET_VERSION,
  regions: Object.freeze([
    Object.freeze({
      id: 'unknown',
      label: 'Not sure — strictest privacy',
      profile: profile({
        regionId: 'unknown',
        jurisdiction: 'Not sure — strictest privacy',
        rawMode: 'blur-at-capture', // never retain raw when we cannot confirm it is legal
        audioEnabled: false,
        retentionSeconds: 1 * DAY, // shortest window
        consentText:
          'Privacy mode: faces blurred, the original video is not kept, sound is off (location not confirmed).',
      }),
    }),
    Object.freeze({
      id: 'us-general',
      label: 'United States — general',
      profile: profile({
        regionId: 'us-general',
        jurisdiction: 'United States — general',
        rawMode: 'raw-sealed',
        audioEnabled: true,
        retentionSeconds: 7 * DAY,
        consentText: 'Recording in progress — faces are hidden; the original video is kept locked.',
      }),
    }),
    Object.freeze({
      id: 'us-il',
      label: 'United States — Illinois',
      profile: profile({
        regionId: 'us-il',
        jurisdiction: 'United States — Illinois',
        rawMode: 'blur-at-capture', // BIPA-style biometric caution: keep no raw faces
        audioEnabled: true,
        retentionSeconds: 1 * DAY,
        consentText:
          'Recording in progress — faces are hidden and the original video is not kept (Illinois biometric caution).',
      }),
    }),
    Object.freeze({
      id: 'eu',
      label: 'Europe (EU)',
      profile: profile({
        regionId: 'eu',
        jurisdiction: 'Europe (EU)',
        rawMode: 'raw-sealed',
        audioEnabled: false, // consent caution: audio recording consent rules vary
        retentionSeconds: 3 * DAY,
        consentText:
          'Recording in progress — faces are hidden, sound is off (consent caution); the original video is kept locked.',
      }),
    }),
    Object.freeze({
      id: 'demo',
      label: 'Demo mode — keep original video',
      profile: profile({
        regionId: 'demo',
        jurisdiction: 'Demo mode — keep original video',
        rawMode: 'raw-sealed',
        audioEnabled: true,
        retentionSeconds: 7 * DAY,
        consentText:
          'Demo profile — faces are hidden and the original video is kept locked. (Demo only: no real jurisdiction was resolved.)',
      }),
    }),
  ]),
});

const REGION_BY_ID = new Map(POLICY_RULESET.regions.map((r) => [r.id, r]));

/** Most-restrictive fail-safe profile (§7.3) — the 'unknown' region's profile. */
export const MOST_RESTRICTIVE_PROFILE = REGION_BY_ID.get('unknown').profile;

/** Region list for pickers: [{id, label}] (no rules leak into the UI). */
export function listRegions() {
  return POLICY_RULESET.regions.map((r) => ({ id: r.id, label: r.label }));
}

/** Resolve a region id to its profile; unrecognized ids fail-safe to 'unknown'. */
export function resolveRegion(regionId) {
  const region = REGION_BY_ID.get(regionId) || REGION_BY_ID.get('unknown');
  return region.profile;
}

/**
 * Total strictness rank for ordering profiles: higher = stricter. Field
 * priorities: rawMode dominates, then audio, then retention (shorter is
 * stricter). Pure function; fixture-tested.
 * @param {PolicyProfile} p
 * @returns {number}
 */
export function strictnessRank(p) {
  const raw = p.rawMode === 'blur-at-capture' ? 1 : 0; // no raw kept = stricter
  const audio = p.audioEnabled ? 0 : 1; // audio off = stricter
  const retention = 1 / Math.max(1, p.retentionSeconds); // shorter window = stricter
  return raw * 4 + audio * 2 + retention;
}

/**
 * §7.3: a manual selection may only make rules STRICTER than an auto-resolved
 * profile, never looser. Returns the field-wise strictest combination of the
 * two profiles (labels/consent come from the manual pick — that is what the
 * user chose to be governed by; any loosened field is clamped back).
 * No auto resolution exists in this release yet; this is fixture-tested and
 * ready for when it arrives.
 * @param {PolicyProfile} autoProfile   Profile resolved automatically (e.g. GPS).
 * @param {PolicyProfile} manualProfile Profile the user picked by hand.
 * @returns {PolicyProfile}
 */
export function applyOverride(autoProfile, manualProfile) {
  return Object.freeze({
    ...manualProfile,
    rawMode:
      autoProfile.rawMode === 'blur-at-capture' || manualProfile.rawMode === 'blur-at-capture'
        ? 'blur-at-capture'
        : 'raw-sealed',
    audioEnabled: autoProfile.audioEnabled && manualProfile.audioEnabled,
    retentionSeconds: Math.min(autoProfile.retentionSeconds, manualProfile.retentionSeconds),
  });
}

export class PolicyEngine {
  /**
   * @param {Object} [opts]
   * @param {PolicyProfile} [opts.profile] Inject a specific profile (tests/native).
   * @param {boolean} [opts.failSafe] Force the most-restrictive profile.
   * @param {string} [opts.regionId] Initial region (defaults to 'unknown' fail-safe).
   */
  constructor(opts = {}) {
    this._failSafe = !!opts.failSafe;
    this._active = this._failSafe
      ? MOST_RESTRICTIVE_PROFILE
      : opts.profile || resolveRegion(opts.regionId || 'unknown');
    this._listeners = new Set();
  }

  /**
   * Select the active region by id (manual selection — the only resolution
   * path in this release; see header note). Unknown ids fail-safe to
   * 'unknown'. Notifies onChange listeners.
   * @param {string} regionId
   * @returns {PolicyProfile} the newly active profile
   */
  setRegion(regionId) {
    this._active = this._failSafe ? MOST_RESTRICTIVE_PROFILE : resolveRegion(regionId);
    for (const fn of this._listeners) fn(this._active);
    return this._active;
  }

  /**
   * Resolve the profile for a session. In native: auto (GPS) resolution +
   * applyOverride against the manual pick, with re-check on boundary
   * crossings. Here it is synchronous and static, but the async shape is
   * preserved so callers already `await` it.
   * @returns {Promise<PolicyProfile>}
   */
  async resolveForSession() {
    return this._active;
  }

  /** Current active profile. */
  getProfile() {
    return this._active;
  }

  /** Swap the active profile directly (tests/native injection). */
  setProfile(profile) {
    this._active = profile;
    for (const fn of this._listeners) fn(this._active);
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}

// Also reachable off the class for embedders that only import PolicyEngine.
PolicyEngine.listRegions = listRegions;
