// core/index.js — the DBCam shared Core (ARCHITECTURE.md).
// One import surface for every client. Pure logic only: no DOM, no I/O, no UI.
// Web imports these as ES modules; iOS/Android embed a bundle of this package.

export { CONFIG } from './config.js';
export {
  PolicyEngine,
  MOST_RESTRICTIVE_PROFILE,
  POLICY_RULESET,
  listRegions,
  resolveRegion,
  strictnessRank,
  applyOverride,
} from './policy.js';
export { AnimalDeterrent } from './threat.js';
export { IncidentDetector } from './incident.js';
export { AuditLog } from './audit.js';
export { buildSegments, EvidenceLedger } from './evidence.js';
export { DeterrentPolicy } from './deterrent.js';
export { CAPABILITY_DEFAULTS, buildManifest, summarize } from './capabilities.js';
