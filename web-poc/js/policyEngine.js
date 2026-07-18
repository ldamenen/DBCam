// Shim — the Jurisdiction Policy Engine v2 lives in the shared Core (ARCHITECTURE §3).
export {
  PolicyEngine,
  FAILSAFE_PROFILE,
  profileDiff,
  compareStrictness,
  PROFILE_POLICY_FIELDS,
  STALE_FIX_MS,
  LOW_CONFIDENCE_ACCURACY_M,
  OVERRIDE_TTL_MS,
} from '../../core/src/policy.js';
export { resolveCandidates, DEFAULT_MARGIN_DEG } from '../../core/src/geo.js';
