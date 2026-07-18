// core/index.js — the DBCam shared Core (ARCHITECTURE.md).
// One import surface for every client. Pure logic only: no DOM, no I/O, no UI.
// Web imports these as ES modules; iOS/Android embed a bundle of this package.

export { CONFIG } from './config.js';
export {
  PolicyEngine,
  FAILSAFE_PROFILE,
  profileDiff,
  compareStrictness,
  PROFILE_POLICY_FIELDS,
  STALE_FIX_MS,
  LOW_CONFIDENCE_ACCURACY_M,
  OVERRIDE_TTL_MS,
} from './policy.js';
export { resolveCandidates, DEFAULT_MARGIN_DEG } from './geo.js';
export { AnimalDeterrent } from './threat.js';
export { IncidentDetector } from './incident.js';
export { MotionDetector } from './motion.js';
export { AuditLog } from './audit.js';
export { buildSegments, EvidenceLedger } from './evidence.js';
export { DeterrentPolicy } from './deterrent.js';
export { CAPABILITY_DEFAULTS, buildManifest, summarize } from './capabilities.js';
