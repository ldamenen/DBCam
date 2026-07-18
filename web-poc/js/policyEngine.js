// Shim — the Jurisdiction Policy Engine lives in the shared Core (ARCHITECTURE §3).
export {
  PolicyEngine,
  MOST_RESTRICTIVE_PROFILE,
  POLICY_RULESET,
  listRegions,
  resolveRegion,
  strictnessRank,
  applyOverride,
} from '../../core/src/policy.js';
