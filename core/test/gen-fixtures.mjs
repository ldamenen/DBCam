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

// ---- Motion scenarios (IMU shake/fall trigger, §2.2) ----
// Synthetic accelerometer streams at ~50Hz (20ms steps), m/s^2 INCLUDING
// gravity. `expect.kind` is the kind of the FIRST trigger during the replay.
const G = 9.81;
const r3 = (v) => Math.round(v * 1000) / 1000;
const motionSamples = (n, startMs, fn) => Array.from({ length: n }, (_, i) => {
  const tMs = startMs + i * 20;
  const [ax, ay, az] = fn(tMs, i);
  return { tMs, ax: r3(ax), ay: r3(ay), az: r3(az) };
});
const motionScenarios = {
  meta: { rateHz: 50, description: 'Golden IMU scenarios: accelerometer samples (incl. gravity, m/s^2) -> expected shake/fall trigger.' },
  scenarios: [
    {
      name: 'calm-walking',            // normal gait: ~±3 m/s^2 around 1g -> silent
      expect: { triggered: false },
      samples: motionSamples(150, 0, (t) => [1.2 * Math.sin(t / 90), 0, G + 3 * Math.sin((2 * Math.PI * t) / 500)]),
    },
    {
      name: 'violent-shake',           // ±25 m/s^2 jolts sustained -> 'shake'
      expect: { triggered: true, kind: 'shake' },
      samples: motionSamples(30, 0, (_t, i) => [(i % 2 ? 25 : -25), 0, G]),
    },
    {
      name: 'drop-with-impact',        // 300ms weightless then a 30 m/s^2 landing -> 'fall'
      expect: { triggered: true, kind: 'fall' },
      samples: [
        ...motionSamples(25, 0, () => [0, 0, G]),        // carried normally
        ...motionSamples(16, 500, () => [0.2, 0.1, 0.3]),// free-fall: near-zero magnitude
        ...motionSamples(1, 820, () => [0, 0, 30]),      // impact spike (fall completes HERE)
        ...motionSamples(10, 840, () => [0, 0, G]),      // at rest after landing
      ],
    },
    {
      name: 'brief-jostle',            // one 20ms spike (pothole/bump) -> silent
      expect: { triggered: false },
      samples: motionSamples(50, 0, (t) => [0, 0, t === 500 ? 35 : G]),
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
writeFileSync(path.join(fixturesDir, 'motion-scenarios.json'), JSON.stringify(motionScenarios, null, 2));
writeFileSync(path.join(fixturesDir, 'audit-chain.json'), JSON.stringify(auditChain, null, 2));
writeFileSync(path.join(fixturesDir, 'evidence-segments.json'), JSON.stringify(evidenceSegments, null, 2));
writeFileSync(path.join(fixturesDir, 'policy-regions.json'), JSON.stringify(policyRegions, null, 2));
console.log('fixtures written');
