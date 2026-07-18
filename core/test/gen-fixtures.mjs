// gen-fixtures.mjs — regenerates the golden fixtures (ARCHITECTURE §6).
// Run: node core/test/gen-fixtures.mjs   (writes core/fixtures/*.json)
// Fixtures are platform-agnostic JSON consumed by every client's conformance
// runner. Regenerate ONLY when Core behavior intentionally changes.

import { writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'fixtures');

const W = 1280, H = 720;
const frames = (n, step, fn) => Array.from({ length: n }, (_, i) => fn(i * step));
const centeredBox = (s) => ({ x: 640 - s / 2, y: 360 - s / 2, w: s, h: s, score: 0.9, label: 'dog' });

// ---- Threat scenarios (includes the field-tested calm-dog case) ----
const threatScenarios = {
  meta: { frameW: W, frameH: H, description: 'Golden threat-scoring scenarios. hostile = expected final hostile state after the full sequence.' },
  scenarios: [
    {
      name: 'static-corner-dog',
      expect: { hostile: false },
      frames: frames(17, 100, (t) => ({ tMs: t, audioLevel: 0, animals: [{ x: 20, y: 20, w: 120, h: 120, score: 0.9, label: 'dog' }] })),
    },
    {
      name: 'calm-walk-up',            // the real-world false positive we fixed:
      expect: { hostile: false },      // a passive dog walking toward the wearer
      frames: frames(17, 100, (t) => ({ tMs: t, audioLevel: 0, animals: [centeredBox(300 + t * 0.0625)] })),
    },
    {
      name: 'silent-charge',           // fast centered lunge, no sound -> must fire
      expect: { hostile: true },
      frames: frames(17, 100, (t) => ({ tMs: t, audioLevel: 0, animals: [centeredBox(200 + t * 0.225)] })),
    },
    {
      name: 'close-quiet-dog',         // calm dog at your feet -> must NOT fire
      expect: { hostile: false },
      frames: frames(17, 100, (t) => ({ tMs: t, audioLevel: 0, animals: [centeredBox(500)] })),
    },
    {
      name: 'close-dog-barking',       // close + loud low-frequency sound -> fires
      expect: { hostile: true, reasonsInclude: ['barking/loud'] },
      frames: frames(17, 100, (t) => ({ tMs: t, audioLevel: 0.9, animals: [centeredBox(500)] })),
    },
    {
      name: 'loud-sound-no-animal',    // audio alone must never fire
      expect: { hostile: false },
      frames: frames(17, 100, (t) => ({ tMs: t, audioLevel: 0.95, animals: [] })),
    },
  ],
};

// ---- Audit chain determinism (SHA-256, canonical serialization) ----
const auditEvents = [
  { type: 'session-start', detail: {}, tMs: 1000 },
  { type: 'incident-open', detail: { reason: 'manual', detail: {} }, tMs: 5000 },
  { type: 'incident-close', detail: { reason: 'manual' }, tMs: 11000 },
  { type: 'raw-unseal', detail: { segment: 1, reason: 'manual', window: [0, 11] }, tMs: 20000 },
  { type: 'raw-export', detail: { segment: 1, reason: 'manual' }, tMs: 25000 },
];
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
let prev = '0';
const expectedChain = auditEvents.map((e, i) => {
  const seq = i + 1;
  const payload = JSON.stringify({ seq, tMs: e.tMs, type: e.type, detail: e.detail, prevHash: prev });
  const hash = sha256(payload);
  prev = hash;
  return hash;
});
const auditChain = {
  meta: { hash: 'SHA-256', description: 'Same events must produce byte-identical chains on every platform.' },
  events: auditEvents,
  expectedChain,
};

// ---- Evidence segment math ----
const evidenceSegments = {
  meta: { prerollSeconds: 6, description: 'Incident windows (ms, monotonic) -> raw-recording segments (s).' },
  cases: [
    {
      name: 'basic-with-preroll',
      recorderStartMs: 1000, stopMs: 61000,
      incidents: [{ reason: 'manual', startMs: 21000, endMs: 27000 }],
      expect: [{ index: 1, startSec: 14, endSec: 26 }],
    },
    {
      name: 'preroll-clamped-at-zero',
      recorderStartMs: 1000, stopMs: 31000,
      incidents: [{ reason: 'voice', startMs: 3000, endMs: 9000 }],
      expect: [{ index: 1, startSec: 0, endSec: 8 }],
    },
    {
      name: 'open-incident-ends-at-stop',
      recorderStartMs: 0, stopMs: 30000,
      incidents: [{ reason: 'hostile-animal', startMs: 20000, endMs: null }],
      expect: [{ index: 1, startSec: 14, endSec: 30 }],
    },
  ],
};

// ---- Jurisdiction policy (§7) ----
// Expected values are written out BY HAND here (not read from the table), so an
// accidental edit to POLICY_RULESET fails conformance. Demo values only — the
// table must be reviewed by counsel before real deployment.
const DAY = 86400;
const policyRegions = {
  meta: {
    rulesetVersion: 1,
    description:
      'Region id -> expected capture profile, plus §7.3 override cases (manual may only make rules stricter).',
  },
  regions: [
    { regionId: 'unknown', expect: { rawMode: 'blur-at-capture', audioEnabled: false, retentionSeconds: 1 * DAY } },
    { regionId: 'us-general', expect: { rawMode: 'raw-sealed', audioEnabled: true, retentionSeconds: 7 * DAY } },
    { regionId: 'us-il', expect: { rawMode: 'blur-at-capture', audioEnabled: true, retentionSeconds: 1 * DAY } },
    { regionId: 'eu', expect: { rawMode: 'raw-sealed', audioEnabled: false, retentionSeconds: 3 * DAY } },
    { regionId: 'demo', expect: { rawMode: 'raw-sealed', audioEnabled: true, retentionSeconds: 7 * DAY } },
  ],
  // Ranks strictly descend left-to-right (strictnessRank ordering sanity).
  strictnessOrder: ['unknown', 'us-il', 'eu', 'us-general'],
  overrideCases: [
    {
      name: 'manual-looser-raw-stricter-retention',
      auto: { rawMode: 'blur-at-capture', audioEnabled: true, retentionSeconds: 1 * DAY },
      manual: { rawMode: 'raw-sealed', audioEnabled: true, retentionSeconds: 3600 },
      expect: { rawMode: 'blur-at-capture', audioEnabled: true, retentionSeconds: 3600 },
    },
    {
      name: 'manual-turns-audio-on-gets-clamped',
      auto: { rawMode: 'raw-sealed', audioEnabled: false, retentionSeconds: 3 * DAY },
      manual: { rawMode: 'raw-sealed', audioEnabled: true, retentionSeconds: 7 * DAY },
      expect: { rawMode: 'raw-sealed', audioEnabled: false, retentionSeconds: 3 * DAY },
    },
    {
      name: 'manual-strictly-stricter-wins-everywhere',
      auto: { rawMode: 'raw-sealed', audioEnabled: true, retentionSeconds: 7 * DAY },
      manual: { rawMode: 'blur-at-capture', audioEnabled: false, retentionSeconds: 1 * DAY },
      expect: { rawMode: 'blur-at-capture', audioEnabled: false, retentionSeconds: 1 * DAY },
    },
  ],
};

writeFileSync(path.join(fixturesDir, 'threat-scenarios.json'), JSON.stringify(threatScenarios, null, 2));
writeFileSync(path.join(fixturesDir, 'audit-chain.json'), JSON.stringify(auditChain, null, 2));
writeFileSync(path.join(fixturesDir, 'evidence-segments.json'), JSON.stringify(evidenceSegments, null, 2));
writeFileSync(path.join(fixturesDir, 'policy-regions.json'), JSON.stringify(policyRegions, null, 2));
console.log('fixtures written');
