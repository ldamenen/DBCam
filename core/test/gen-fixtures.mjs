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

// ---- Jurisdiction policy v2 (§7): engine-level scenarios ----
// Expected values are written out BY HAND here (not read from the ruleset), so
// an accidental edit to core/data/ruleset.json or geo-bounds.json fails
// conformance. The ruleset is DRAFT (v0.2.0-DRAFT-UNVERIFIED) legal content —
// pending counsel review before any real deployment.
const policyScenarios = {
  meta: {
    rulesetVersion: '0.2.0-DRAFT-UNVERIFIED',
    defaultProfileId: 'RESTRICTED_DEFAULT',
    description:
      'GPS coordinates / manual jurisdiction codes -> expected resolution through the PolicyEngine (ruleset + geo bounds injected from core/data/*.json). Multiple geo candidates are expected; the engine takes the strictest.',
  },
  // Real coordinates fed through updateLocation (fresh, accurate fix).
  geoCases: [
    { name: 'paris', lat: 48.8566, lon: 2.3522, expect: { jurisdictionCode: 'FR', profileId: 'FR_BLOCKED' } },
    { name: 'barcelona', lat: 41.3874, lon: 2.1686, expect: { jurisdictionCode: 'ES', profileId: 'ES_STRICT' } },
    { name: 'singapore', lat: 1.3521, lon: 103.8198, expect: { jurisdictionCode: 'SG', profileId: 'SG_PERSONAL' } },
    { name: 'hong-kong', lat: 22.3193, lon: 114.1694, expect: { jurisdictionCode: 'HK', profileId: 'HK_PERSONAL' } },
    { name: 'mexico-city', lat: 19.4326, lon: -99.1332, expect: { jurisdictionCode: 'MX', profileId: 'MX_PERSONAL' } },
    { name: 'brisbane', lat: -27.4698, lon: 153.0251, expect: { jurisdictionCode: 'AU-QLD', profileId: 'AU_ONE_PARTY' } },
    {
      name: 'melbourne', lat: -37.8136, lon: 144.9631,
      expect: { jurisdictionCode: 'AU-VIC', profileId: 'AU_ALL_PARTY', candidatesInclude: ['AU-VIC', 'AU'] },
    },
    { name: 'sydney', lat: -33.8688, lon: 151.2093, expect: { jurisdictionCode: 'AU-NSW', profileId: 'AU_ALL_PARTY' } },
    {
      name: 'tokyo', lat: 35.6762, lon: 139.6503, // unmatched -> fail-safe default + auditable event
      expect: { jurisdictionCode: null, profileId: 'RESTRICTED_DEFAULT', noCandidates: true },
    },
    {
      name: 'es-fr-border', lat: 42.42, lon: 2.85, // near-border: both sides match, stricter (FR) wins
      expect: { jurisdictionCode: 'FR', profileId: 'FR_BLOCKED', candidatesInclude: ['FR', 'ES'] },
    },
  ],
  // setManualJurisdiction(code) -> expected governing profile facts.
  manualCases: [
    { code: 'FR', expect: { profileId: 'FR_BLOCKED', recordingAllowed: false, audioCapture: false } },
    { code: 'ES', expect: { profileId: 'ES_STRICT', rawRetention: 'blurAtCapture', audioCapture: false } },
    { code: 'SG', expect: { profileId: 'SG_PERSONAL', rawRetention: 'sealed', audioCapture: true } },
    { code: 'HK', expect: { profileId: 'HK_PERSONAL', rawRetention: 'sealed', audioCapture: true } },
    { code: 'MX', expect: { profileId: 'MX_PERSONAL', rawRetention: 'sealed', audioCapture: true } },
    { code: 'AU', expect: { profileId: 'AU_ALL_PARTY', audioCapture: false } }, // bare AU must NOT assume one-party
    { code: 'AU-QLD', expect: { profileId: 'AU_ONE_PARTY', audioCapture: true } },
    { code: 'AU-NT', expect: { profileId: 'AU_ONE_PARTY', audioCapture: true } },
    { code: 'AU-VIC', expect: { profileId: 'AU_ALL_PARTY', audioCapture: false } },
    { code: 'AU-NSW', expect: { profileId: 'AU_ALL_PARTY', audioCapture: false } },
    { code: 'AU-SA', expect: { profileId: 'AU_ALL_PARTY', audioCapture: false } },
    { code: 'AU-WA', expect: { profileId: 'AU_ALL_PARTY', audioCapture: false } },
    { code: 'AU-TAS', expect: { profileId: 'AU_ALL_PARTY', audioCapture: false } },
    { code: 'AU-ACT', expect: { profileId: 'AU_ALL_PARTY', audioCapture: false } },
    { code: 'JP', expect: { profileId: 'RESTRICTED_DEFAULT', unmatchedEvent: true } }, // no rule -> default + event
  ],
  // Six researched countries must resolve to six DISTINCT profiles.
  distinctCountryCodes: ['FR', 'ES', 'SG', 'HK', 'MX', 'AU'],
};

writeFileSync(path.join(fixturesDir, 'threat-scenarios.json'), JSON.stringify(threatScenarios, null, 2));
writeFileSync(path.join(fixturesDir, 'motion-scenarios.json'), JSON.stringify(motionScenarios, null, 2));
writeFileSync(path.join(fixturesDir, 'audit-chain.json'), JSON.stringify(auditChain, null, 2));
writeFileSync(path.join(fixturesDir, 'evidence-segments.json'), JSON.stringify(evidenceSegments, null, 2));
writeFileSync(path.join(fixturesDir, 'policy-scenarios.json'), JSON.stringify(policyScenarios, null, 2));
console.log('fixtures written');
