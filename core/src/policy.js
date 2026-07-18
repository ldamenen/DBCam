// core/policy.js  (shared Core — ARCHITECTURE §3)
// §7 Jurisdiction Policy Engine v2 — full resolution pipeline:
//   admin pin > user override > GPS > manual selection > fail-safe default.
//
// The jurisdiction ruleset ships as bundled, versioned DATA
// (core/data/ruleset.json — v0.2.0-DRAFT-UNVERIFIED, pending counsel review)
// and is INJECTED into this engine; the Core reads no files itself. A
// hardcoded FAILSAFE profile (equivalent to RESTRICTED_DEFAULT) governs until
// a valid ruleset is loaded — the bundled-fallback safety floor.
//
// ⚠️ The ruleset content is DRAFT legal research, not legal advice. It must be
// reviewed by counsel before any real deployment.
//
// Purity rules (ARCHITECTURE §2): no I/O, no Date.now, no timers. Every
// time-dependent API takes caller-supplied time: `nowMs` (monotonic ms, used
// for expiry/staleness math) and/or `nowIso` (ISO string, used only for
// record-keeping fields such as ResolvedPolicy.resolvedAt).
//
// FAIL-SAFE (non-negotiable): unknown / stale (>10 min) / low-confidence /
// permission-denied / unmatched locations resolve to the ruleset's
// defaultProfileId. Low confidence (accuracy >1000 m or stale fix) applies the
// STRICTER of (resolved profile, default profile) by restrictivenessRank —
// lower rank = MORE restrictive, 0 = most restrictive.

import { resolveCandidates, DEFAULT_MARGIN_DEG } from './geo.js';

/**
 * @typedef {Object} PolicyProfile
 * @property {string} id
 * @property {string} displayName
 * @property {boolean} recordingAllowed
 * @property {'sealed'|'blurAtCapture'} rawRetention  sealed: raw kept but sealed. blurAtCapture: no raw kept.
 * @property {boolean} audioCapture
 * @property {boolean} audioTriggerAllowed
 * @property {'faces'|'facesAndBodies'} blurMode
 * @property {number} retentionDays
 * @property {boolean} requiresVisibleIndicator
 * @property {string|null} noticeText
 * @property {boolean} publishingAllowed
 * @property {number} restrictivenessRank  0 = MOST restrictive; lower = stricter.
 * @property {boolean} overridable
 * @property {string} notes
 */

/**
 * @typedef {Object} ResolvedPolicy
 * @property {PolicyProfile} profile
 * @property {'gps'|'manualSelection'|'userOverride'|'adminConfig'|'default'} source
 * @property {string|null} jurisdictionCode
 * @property {'high'|'low'|'unknown'} confidence
 * @property {string|null} resolvedAt        Caller-supplied ISO string (core never calls Date).
 * @property {string} rulesetVersion
 * @property {boolean} isOverride
 * @property {string|null} overrideAcknowledgedAt
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Fix older than this (delivery age + elapsed monotonic time) → confidence 'low'. */
export const STALE_FIX_MS = 10 * MIN;
/** GPS accuracy worse than this → confidence 'low'. */
export const LOW_CONFIDENCE_ACCURACY_M = 1000;
/** User overrides self-expire after this long. */
export const OVERRIDE_TTL_MS = 24 * HOUR;

/**
 * Built-in hardcoded fail-safe profile — equivalent to the ruleset's
 * RESTRICTED_DEFAULT. Governs before any ruleset loads (and again if a ruleset
 * is rejected before any valid one was installed). The safety floor can never
 * depend on data files having loaded.
 * @type {PolicyProfile}
 */
export const FAILSAFE_PROFILE = Object.freeze({
  id: 'FAILSAFE',
  displayName: 'Fail-safe (built-in)',
  recordingAllowed: true,
  rawRetention: 'blurAtCapture',
  audioCapture: false,
  audioTriggerAllowed: false,
  blurMode: 'faces',
  retentionDays: 30,
  requiresVisibleIndicator: true,
  noticeText: null,
  publishingAllowed: false,
  restrictivenessRank: 10,
  overridable: true,
  notes:
    'Built-in hardcoded fail-safe, equivalent to RESTRICTED_DEFAULT. Governs whenever no valid ruleset is loaded. Never loosen this automatically.',
});

const FAILSAFE_RULESET = Object.freeze({
  version: '0.0.0-FAILSAFE',
  updatedAt: null,
  authoredBy: 'built-in',
  defaultProfileId: 'FAILSAFE',
  profiles: Object.freeze([FAILSAFE_PROFILE]),
  rules: Object.freeze([]),
});

/** Policy-fact fields compared by profileDiff (identity/metadata fields —
 *  id, displayName, restrictivenessRank, overridable, notes — are excluded). */
export const PROFILE_POLICY_FIELDS = Object.freeze([
  'recordingAllowed',
  'rawRetention',
  'audioCapture',
  'audioTriggerAllowed',
  'blurMode',
  'retentionDays',
  'requiresVisibleIndicator',
  'noticeText',
  'publishingAllowed',
]);

/**
 * Structured field-by-field change list between two profiles: only changed
 * policy fields, each as {field, from, to}. The Core computes the facts; the
 * UI renders the words (override confirmation modal).
 * @param {PolicyProfile} a  from-profile
 * @param {PolicyProfile} b  to-profile
 * @returns {{field:string, from:*, to:*}[]}
 */
export function profileDiff(a, b) {
  return PROFILE_POLICY_FIELDS.filter((f) => a[f] !== b[f]).map((f) =>
    Object.freeze({ field: f, from: a[f], to: b[f] })
  );
}

/**
 * Compare two profiles by restrictiveness. Negative → a is STRICTER than b
 * (lower restrictivenessRank = more restrictive; 0 = most restrictive).
 * Usable as a sort comparator (strictest first).
 * @param {PolicyProfile} a
 * @param {PolicyProfile} b
 * @returns {number}
 */
export function compareStrictness(a, b) {
  return a.restrictivenessRank - b.restrictivenessRank;
}

const stricterOf = (a, b) => (compareStrictness(b, a) < 0 ? b : a);

/** @returns {string[]} validation errors ([] = valid). */
function validateRuleset(rs) {
  const errors = [];
  if (!rs || typeof rs !== 'object') return ['ruleset is not an object'];
  if (typeof rs.version !== 'string' || !rs.version) errors.push('version must be a non-empty string');
  if (!Array.isArray(rs.profiles) || rs.profiles.length === 0) {
    errors.push('profiles must be a non-empty array');
    return errors;
  }
  const ids = new Set();
  for (const p of rs.profiles) {
    if (!p || typeof p.id !== 'string' || !p.id) { errors.push('profile with missing id'); continue; }
    if (ids.has(p.id)) errors.push(`duplicate profile id ${p.id}`);
    ids.add(p.id);
    if (typeof p.recordingAllowed !== 'boolean') errors.push(`${p.id}: recordingAllowed must be boolean`);
    if (p.rawRetention !== 'sealed' && p.rawRetention !== 'blurAtCapture')
      errors.push(`${p.id}: rawRetention must be 'sealed'|'blurAtCapture'`);
    if (typeof p.audioCapture !== 'boolean') errors.push(`${p.id}: audioCapture must be boolean`);
    if (p.blurMode !== 'faces' && p.blurMode !== 'facesAndBodies')
      errors.push(`${p.id}: blurMode must be 'faces'|'facesAndBodies'`);
    if (typeof p.retentionDays !== 'number') errors.push(`${p.id}: retentionDays must be a number`);
    if (typeof p.restrictivenessRank !== 'number') errors.push(`${p.id}: restrictivenessRank must be a number`);
    if (typeof p.overridable !== 'boolean') errors.push(`${p.id}: overridable must be boolean`);
  }
  if (typeof rs.defaultProfileId !== 'string' || !ids.has(rs.defaultProfileId))
    errors.push(`defaultProfileId ${rs.defaultProfileId} does not reference a profile`);
  const rules = rs.rules ?? [];
  if (!Array.isArray(rules)) errors.push('rules must be an array');
  else {
    for (const r of rules) {
      if (!r || typeof r.jurisdictionCode !== 'string' || !r.jurisdictionCode)
        errors.push('rule with missing jurisdictionCode');
      else if (!ids.has(r.profileId))
        errors.push(`rule ${r.jurisdictionCode} references unknown profile ${r.profileId}`);
    }
  }
  return errors;
}

/**
 * Jurisdiction Policy Engine v2. Pure state machine — inject ruleset + geo
 * bounds, feed it inputs, ask it for the resolved policy. All times are
 * caller-supplied. Events (unmatched jurisdictions, override expiry /
 * invalidation, ruleset rejection) queue internally; drain them with
 * takeEvents() for audit logging.
 */
export class PolicyEngine {
  /**
   * @param {Object} [opts]
   * @param {Object} [opts.ruleset]    JurisdictionRuleset to load (invalid → failsafe stays).
   * @param {Object} [opts.geoBounds]  geo-bounds table for GPS candidate lookup.
   * @param {number} [opts.marginDeg]  Border margin for geo lookup (default ~0.05° ≈ 5 km).
   */
  constructor(opts = {}) {
    this._ruleset = FAILSAFE_RULESET;
    this._profilesById = new Map([[FAILSAFE_PROFILE.id, FAILSAFE_PROFILE]]);
    this._rulesByCode = new Map();
    this._geoBounds = opts.geoBounds ?? null;
    this._marginDeg = opts.marginDeg ?? DEFAULT_MARGIN_DEG;
    this._mode = 'auto';
    this._fix = null; // {lat, lon, accuracyM, fixAtMs, jurisdictionCode, profileId, candidates}
    this._manual = null; // {code, profileId|null}
    this._adminProfileId = null;
    this._override = null; // {profileId, acknowledgedAt, activatedAtMs, expiresAtMs, jurisdictionCodeAtActivation}
    this._session = null; // {policy: ResolvedPolicy}
    this._events = [];
    if (opts.ruleset) this.loadRuleset(opts.ruleset);
  }

  // ---- ruleset ----

  /**
   * Install a JurisdictionRuleset after validation. Invalid rulesets are
   * REJECTED: the previously loaded ruleset (or the built-in failsafe) stays
   * in force, a 'ruleset-rejected' event is queued, and the errors are
   * returned.
   * @returns {{ok:true}|{ok:false, errors:string[]}}
   */
  loadRuleset(ruleset) {
    const errors = validateRuleset(ruleset);
    if (errors.length > 0) {
      this._events.push({ type: 'ruleset-rejected', errors });
      return { ok: false, errors };
    }
    const profiles = ruleset.profiles.map((p) => Object.freeze({ ...p }));
    this._ruleset = Object.freeze({
      ...ruleset,
      profiles: Object.freeze(profiles),
      rules: Object.freeze((ruleset.rules ?? []).map((r) => Object.freeze({ ...r }))),
    });
    this._profilesById = new Map(profiles.map((p) => [p.id, p]));
    this._rulesByCode = new Map(this._ruleset.rules.map((r) => [r.jurisdictionCode, r]));
    // Re-anchor state that referenced the old ruleset's profiles.
    if (this._override && !this._profilesById.has(this._override.profileId)) {
      this._events.push({ type: 'override-invalidated-ruleset-change', profileId: this._override.profileId });
      this._override = null;
    }
    if (this._adminProfileId && !this._profilesById.has(this._adminProfileId)) {
      this._events.push({ type: 'admin-pin-cleared-ruleset-change', profileId: this._adminProfileId });
      this._adminProfileId = null;
    }
    if (this._fix) this._resolveFixCandidates(this._fix); // re-map candidates onto new rules
    if (this._manual) this.setManualJurisdiction(this._manual.code);
    return { ok: true };
  }

  /** Inject/replace the geo bounding-box table. */
  setGeoBounds(geoBounds) {
    this._geoBounds = geoBounds ?? null;
  }

  /** {version, updatedAt, authoredBy, defaultProfileId} of the loaded ruleset. */
  getRulesetInfo() {
    const { version, updatedAt, authoredBy, defaultProfileId } = this._ruleset;
    return { version, updatedAt: updatedAt ?? null, authoredBy: authoredBy ?? null, defaultProfileId };
  }

  /** Jurisdiction list for the manual picker: [{code, displayName, profileId}]. */
  listJurisdictions() {
    return this._ruleset.rules.map((r) => ({
      code: r.jurisdictionCode,
      displayName: r.displayName ?? r.jurisdictionCode,
      profileId: r.profileId,
    }));
  }

  /** All profiles in the loaded ruleset (for the override picker). */
  listProfiles() {
    return [...this._ruleset.profiles];
  }

  /** Look up one profile by id (null if absent). */
  getProfileById(profileId) {
    return this._profilesById.get(profileId) ?? null;
  }

  // ---- events ----

  /**
   * Drain the queued events for audit logging. Types:
   *  {type:'unmatched-jurisdiction', code}
   *  {type:'no-jurisdiction-candidates', lat, lon}
   *  {type:'override-expired', profileId, atMs}
   *  {type:'override-invalidated-jurisdiction-change', profileId, fromCode, toCode}
   *  {type:'override-invalidated-ruleset-change', profileId}
   *  {type:'admin-pin-cleared-ruleset-change', profileId}
   *  {type:'ruleset-rejected', errors}
   * @returns {Object[]}
   */
  takeEvents() {
    const events = this._events;
    this._events = [];
    return events;
  }

  // ---- inputs ----

  /** @param {'auto'|'manual'} mode  auto = GPS resolution; manual = user-picked jurisdiction. */
  setLocationMode(mode) {
    if (mode !== 'auto' && mode !== 'manual') throw new Error(`invalid location mode: ${mode}`);
    this._mode = mode;
  }

  /**
   * Feed a GPS fix (auto mode). Maps geo candidates to rules (subdivision
   * first, then bare country), keeps the STRICTEST candidate profile, and
   * queues 'unmatched-jurisdiction' / 'no-jurisdiction-candidates' events.
   * A fix landing on a DIFFERENT jurisdiction than an active override's
   * activation jurisdiction invalidates the override.
   * @param {Object} fix {lat, lon, accuracyM, ageMs, nowMs} — ageMs is the
   *   fix's age at delivery; nowMs is the caller's monotonic clock.
   * @returns {{jurisdictionCode:string|null, profileId:string|null, candidates:string[]}}
   */
  updateLocation({ lat, lon, accuracyM = null, ageMs = 0, nowMs }) {
    const fix = {
      lat,
      lon,
      accuracyM,
      fixAtMs: (nowMs ?? 0) - (ageMs ?? 0),
      candidates: [],
      jurisdictionCode: null,
      profileId: null,
    };
    this._resolveFixCandidates(fix);
    this._fix = fix;
    if (
      this._override &&
      fix.jurisdictionCode !== null &&
      fix.jurisdictionCode !== this._override.jurisdictionCodeAtActivation
    ) {
      this._events.push({
        type: 'override-invalidated-jurisdiction-change',
        profileId: this._override.profileId,
        fromCode: this._override.jurisdictionCodeAtActivation,
        toCode: fix.jurisdictionCode,
      });
      this._override = null;
    }
    return { jurisdictionCode: fix.jurisdictionCode, profileId: fix.profileId, candidates: fix.candidates };
  }

  _resolveFixCandidates(fix) {
    const candidates = resolveCandidates(fix.lat, fix.lon, this._geoBounds ?? [], this._marginDeg);
    fix.candidates = candidates;
    if (candidates.length === 0) {
      this._events.push({ type: 'no-jurisdiction-candidates', lat: fix.lat, lon: fix.lon });
      fix.jurisdictionCode = null;
      fix.profileId = null;
      return;
    }
    // A subdivision candidate is a REFINEMENT of its own country's bare code —
    // drop the bare country candidate so e.g. Brisbane resolves via AU-QLD,
    // not stricter-of(AU-QLD, AU). Genuinely distinct candidates (border
    // zones, overlapping subdivisions) still compete by strictness below.
    const refinedCountries = new Set(
      candidates.filter((c) => c.includes('-')).map((c) => c.split('-')[0])
    );
    const considered = candidates.filter((c) => c.includes('-') || !refinedCountries.has(c));
    let best = null; // {code, profile}
    for (const code of considered) {
      const rule = this._rulesByCode.get(code) ?? this._rulesByCode.get(code.split('-')[0]);
      if (!rule) {
        this._events.push({ type: 'unmatched-jurisdiction', code });
        continue;
      }
      const profile = this._profilesById.get(rule.profileId);
      if (!best || compareStrictness(profile, best.profile) < 0) best = { code, profile };
    }
    fix.jurisdictionCode = best ? best.code : null;
    fix.profileId = best ? best.profile.id : null;
  }

  /**
   * Manual jurisdiction selection. Unknown codes fail safe to the default
   * profile and queue an 'unmatched-jurisdiction' event. Pass null to clear.
   */
  setManualJurisdiction(code) {
    if (code == null) {
      this._manual = null;
      return null;
    }
    const rule =
      this._rulesByCode.get(code) ??
      (code.includes('-') ? this._rulesByCode.get(code.split('-')[0]) : undefined);
    if (!rule) {
      this._events.push({ type: 'unmatched-jurisdiction', code });
      this._manual = { code, profileId: null };
      return null;
    }
    this._manual = { code, profileId: rule.profileId };
    return this._profilesById.get(rule.profileId);
  }

  /**
   * Admin (organisation) pin: forces a profile regardless of location and of
   * any user override. Pass null to unpin.
   * @returns {{ok:boolean, error?:string}}
   */
  setAdminPin(profileId) {
    if (profileId == null) {
      this._adminProfileId = null;
      return { ok: true };
    }
    if (!this._profilesById.has(profileId)) return { ok: false, error: `unknown profile ${profileId}` };
    this._adminProfileId = profileId;
    return { ok: true };
  }

  // ---- resolution ----

  /**
   * Location-derived resolution, precedence gps > manualSelection > default,
   * ignoring admin pin and user override. This is the "auto profile" that
   * overrides are compared against.
   */
  _baseResolution(nowMs) {
    const def = this._profilesById.get(this._ruleset.defaultProfileId);
    if (this._mode === 'auto' && this._fix) {
      const fixAgeMs = nowMs != null ? nowMs - this._fix.fixAtMs : 0;
      const stale = fixAgeMs > STALE_FIX_MS;
      const inaccurate = this._fix.accuracyM != null && this._fix.accuracyM > LOW_CONFIDENCE_ACCURACY_M;
      const confidence = stale || inaccurate ? 'low' : 'high';
      if (this._fix.profileId != null) {
        let profile = this._profilesById.get(this._fix.profileId);
        // Low confidence → stricter of (resolved, default). FAIL-SAFE.
        if (confidence === 'low') profile = stricterOf(profile, def);
        return { profile, source: 'gps', jurisdictionCode: this._fix.jurisdictionCode, confidence };
      }
      // Fix exists but matched nothing → fail-safe default.
      return { profile: def, source: 'default', jurisdictionCode: null, confidence };
    }
    if (this._manual) {
      if (this._manual.profileId != null) {
        return {
          profile: this._profilesById.get(this._manual.profileId),
          source: 'manualSelection',
          jurisdictionCode: this._manual.code,
          confidence: 'high',
        };
      }
      return { profile: def, source: 'default', jurisdictionCode: null, confidence: 'unknown' };
    }
    // No location ever (incl. permission denied) → fail-safe default.
    return { profile: def, source: 'default', jurisdictionCode: null, confidence: 'unknown' };
  }

  _overrideActive(nowMs) {
    return !!this._override && nowMs != null && nowMs < this._override.expiresAtMs;
  }

  /**
   * The governing policy right now. Precedence:
   * adminConfig > userOverride > gps > manualSelection > default.
   * @param {Object} times {nowMs, nowIso} — nowMs drives staleness/expiry
   *   math; nowIso is copied into resolvedAt (core never calls Date).
   * @returns {ResolvedPolicy}
   */
  getResolved({ nowMs, nowIso } = {}) {
    const base = this._baseResolution(nowMs);
    let out;
    if (this._adminProfileId != null) {
      out = {
        profile: this._profilesById.get(this._adminProfileId),
        source: 'adminConfig',
        jurisdictionCode: base.jurisdictionCode,
        confidence: base.confidence,
        isOverride: false,
        overrideAcknowledgedAt: null,
      };
    } else if (this._overrideActive(nowMs)) {
      out = {
        profile: this._profilesById.get(this._override.profileId),
        source: 'userOverride',
        jurisdictionCode: this._override.jurisdictionCodeAtActivation,
        confidence: base.confidence,
        isOverride: true,
        overrideAcknowledgedAt: this._override.acknowledgedAt,
      };
    } else {
      out = { ...base, isOverride: false, overrideAcknowledgedAt: null };
    }
    return Object.freeze({
      ...out,
      resolvedAt: nowIso ?? null,
      rulesetVersion: this._ruleset.version,
    });
  }

  // ---- override lifecycle (§5) ----

  /**
   * Classify a prospective override against the auto-resolved profile.
   * tier 'tighten'  — target rank <= auto rank: applies immediately on
   *                   confirmOverride, no acknowledgment needed.
   * tier 'loosen'   — target is looser and auto profile is overridable:
   *                   confirmOverride requires ackIso.
   * tier 'blocked'  — auto profile has overridable:false and target is looser
   *                   (or target profile unknown). Admin config only.
   * diff is the structured changed-field list (profileDiff) for the modal.
   * @returns {{tier:'tighten'|'loosen'|'blocked', autoProfile:PolicyProfile,
   *            targetProfile:PolicyProfile|null, diff:Object[], reason?:string}}
   */
  requestOverride(profileId, { nowMs } = {}) {
    const auto = this._baseResolution(nowMs);
    const target = this._profilesById.get(profileId) ?? null;
    if (!target) {
      return { tier: 'blocked', reason: 'unknown-profile', autoProfile: auto.profile, targetProfile: null, diff: [] };
    }
    let tier;
    if (compareStrictness(target, auto.profile) <= 0) tier = 'tighten';
    else if (!auto.profile.overridable) tier = 'blocked';
    else tier = 'loosen';
    const result = { tier, autoProfile: auto.profile, targetProfile: target, diff: profileDiff(auto.profile, target) };
    if (tier === 'blocked') result.reason = 'auto-profile-not-overridable';
    return result;
  }

  /**
   * Activate an override. Loosening requires ackIso (the user's explicit
   * acknowledgment timestamp); tightening applies without it. Blocked tiers
   * never activate. Override expires 24 h after activation (tick()).
   * @param {string} profileId
   * @param {Object} args {nowMs, ackIso}
   * @returns {{ok:true, tier:string, override:Object}|{ok:false, tier:string, reason:string}}
   */
  confirmOverride(profileId, { nowMs, ackIso } = {}) {
    const req = this.requestOverride(profileId, { nowMs });
    if (req.tier === 'blocked') return { ok: false, tier: req.tier, reason: req.reason ?? 'blocked' };
    if (req.tier === 'loosen' && !ackIso) return { ok: false, tier: req.tier, reason: 'acknowledgment-required' };
    const base = this._baseResolution(nowMs);
    this._override = {
      profileId,
      acknowledgedAt: ackIso ?? null,
      activatedAtMs: nowMs,
      expiresAtMs: nowMs + OVERRIDE_TTL_MS,
      jurisdictionCodeAtActivation: base.jurisdictionCode,
    };
    return { ok: true, tier: req.tier, override: { ...this._override } };
  }

  /** Manually disable the active override (no event — user-initiated). */
  clearOverride() {
    this._override = null;
  }

  /**
   * Advance time: expires the override at activatedAtMs + 24 h. Returns the
   * events generated by THIS tick (they are also queued for takeEvents() —
   * consume via one mechanism, not both).
   * @returns {Object[]}
   */
  tick({ nowMs } = {}) {
    const emitted = [];
    if (this._override && nowMs != null && nowMs >= this._override.expiresAtMs) {
      const ev = { type: 'override-expired', profileId: this._override.profileId, atMs: nowMs };
      this._override = null;
      this._events.push(ev);
      emitted.push(ev);
    }
    return emitted;
  }

  /** @returns {{active:boolean, profileId:string|null, remainingMs:number, acknowledgedAt:string|null}} */
  getOverrideStatus({ nowMs } = {}) {
    if (!this._overrideActive(nowMs)) {
      return { active: false, profileId: null, remainingMs: 0, acknowledgedAt: null };
    }
    return {
      active: true,
      profileId: this._override.profileId,
      remainingMs: this._override.expiresAtMs - nowMs,
      acknowledgedAt: this._override.acknowledgedAt,
    };
  }

  // ---- session semantics (§4.5) ----

  /** Snapshot the ResolvedPolicy that governs the recording session. */
  beginSession({ nowMs, nowIso } = {}) {
    const policy = this.getResolved({ nowMs, nowIso });
    this._session = { policy };
    return policy;
  }

  /**
   * Compare the current resolution to the session snapshot.
   * Stricter (lower rank) applies IMMEDIATELY: action 'tighten' (snapshot is
   * advanced), or 'stop' when recordingAllowed flips false. Looser NEVER
   * applies mid-session: action 'none' with pendingLooserPolicy set so the UI
   * can note it takes effect next session.
   * @returns {{action:'none'|'tighten'|'stop', newPolicy?:ResolvedPolicy, pendingLooserPolicy?:ResolvedPolicy}}
   */
  evaluateSessionPolicy({ nowMs, nowIso } = {}) {
    if (!this._session) return { action: 'none' };
    const current = this.getResolved({ nowMs, nowIso });
    const snapshot = this._session.policy;
    if (current.profile.id === snapshot.profile.id) return { action: 'none' };
    if (compareStrictness(current.profile, snapshot.profile) < 0) {
      this._session = { policy: current };
      if (!current.profile.recordingAllowed) return { action: 'stop', newPolicy: current };
      return { action: 'tighten', newPolicy: current };
    }
    return { action: 'none', pendingLooserPolicy: current };
  }

  /** End the recording session (clears the snapshot). */
  endSession() {
    this._session = null;
  }
}
