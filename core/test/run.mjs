// run.mjs — the Core conformance runner, node edition (ARCHITECTURE §6).
// Every client gets one of these against the SAME fixtures: web/node (this file),
// iOS via XCTest + JavaScriptCore, Android via an instrumented test. Identical
// fixtures + identical results = the three apps provably share one brain.
// Run: node core/test/run.mjs

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

import { AnimalDeterrent } from '../src/threat.js';
import { AuditLog } from '../src/audit.js';
import { buildSegments, EvidenceLedger } from '../src/evidence.js';
import { PolicyEngine, MOST_RESTRICTIVE_PROFILE } from '../src/policy.js';
import { DeterrentPolicy } from '../src/deterrent.js';
import { buildManifest } from '../src/capabilities.js';
import { CONFIG } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(here, '..', 'fixtures', name), 'utf8'));

let failures = 0;
const check = (name, cond, info = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${info}`); }
};

// ---- Threat scenarios ----
{
  const { meta, scenarios } = fixture('threat-scenarios.json');
  console.log('threat-scenarios:');
  for (const sc of scenarios) {
    const d = new AnimalDeterrent();
    let last = null;
    for (const f of sc.frames) {
      last = d.update(f.animals, meta.frameW, meta.frameH, f.tMs, f.audioLevel || 0);
    }
    check(sc.name, last.hostile === sc.expect.hostile,
      `(hostile=${last.hostile} score=${last.threatScore.toFixed(2)})`);
    if (sc.expect.reasonsInclude) {
      for (const r of sc.expect.reasonsInclude) {
        check(`${sc.name} reason "${r}"`, last.reasons.includes(r), `(reasons=${last.reasons})`);
      }
    }
  }
}

// ---- Audit chain determinism ----
{
  const { events, expectedChain } = fixture('audit-chain.json');
  console.log('audit-chain:');
  const sha256 = async (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  const log = new AuditLog({ hashFn: sha256 });
  const hashes = [];
  for (const e of events) hashes.push((await log.append(e.type, e.detail, e.tMs)).hash);
  check('chain matches golden hashes', JSON.stringify(hashes) === JSON.stringify(expectedChain));
  check('entries linked', log.entries.every((e, i) => i === 0 ? e.prevHash === '0' : e.prevHash === log.entries[i - 1].hash));
}

// ---- Evidence segments ----
{
  const { meta, cases } = fixture('evidence-segments.json');
  console.log('evidence-segments:');
  for (const c of cases) {
    const segs = buildSegments(c.incidents, c.recorderStartMs, c.stopMs, meta.prerollSeconds);
    const ok = segs.length === c.expect.length && segs.every((s, i) =>
      s.index === c.expect[i].index &&
      Math.abs(s.startSec - c.expect[i].startSec) < 1e-9 &&
      Math.abs(s.endSec - c.expect[i].endSec) < 1e-9);
    check(c.name, ok, JSON.stringify(segs.map((s) => [s.startSec, s.endSec])));
  }
}

// ---- Evidence rules (§6) ----
{
  console.log('evidence-rules:');
  const ledger = new EvidenceLedger({});
  ledger.setRawMode('raw-sealed');
  ledger.setRawAvailable(true);
  const [seg] = ledger.buildSegments([{ reason: 'manual', startMs: 10000, endMs: 16000 }], 0, 30000);
  check('export refused while sealed', (await ledger.exportRaw(seg, 1)) === null);
  check('unseal returns window', (await ledger.unseal(seg, 2)) !== null);
  check('export allowed after unseal', (await ledger.exportRaw(seg, 3)) !== null);
  const blocked = new EvidenceLedger({});
  blocked.setRawMode('blur-at-capture');
  blocked.setRawAvailable(true);
  const [seg2] = blocked.buildSegments([{ reason: 'manual', startMs: 10000, endMs: 16000 }], 0, 30000);
  check('blur-at-capture retains no raw', (await blocked.unseal(seg2, 4)) === null);
}

// ---- Policy fail-safe + deterrent cooldown + manifest ----
{
  console.log('misc:');
  const failSafe = new PolicyEngine({ failSafe: true });
  check('fail-safe = most restrictive', failSafe.getProfile() === MOST_RESTRICTIVE_PROFILE);
  const dp = new DeterrentPolicy();
  check('deterrent initially allowed', dp.canPlay(1000));
  dp.markStarted(1000); dp.markEnded();
  check('deterrent blocked in cooldown', !dp.canPlay(1000 + CONFIG.deterrent.cooldownMs - 1));
  check('deterrent allowed after cooldown', dp.canPlay(1000 + CONFIG.deterrent.cooldownMs));
  const m = buildManifest({ voiceTrigger: { supported: true, selfContained: false, reason: 'vendor servers' } });
  check('manifest merges report', m.voiceTrigger.supported === true && m.voiceTrigger.selfContained === false);
  check('manifest defaults conservative', m.secureSealing.supported === false);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
