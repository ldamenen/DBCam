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
import { MotionDetector } from '../src/motion.js';
import { AuditLog } from '../src/audit.js';
import { buildSegments, EvidenceLedger } from '../src/evidence.js';
import { PolicyEngine, FAILSAFE_PROFILE, profileDiff, compareStrictness } from '../src/policy.js';
import { resolveCandidates } from '../src/geo.js';
import { DeterrentPolicy } from '../src/deterrent.js';
import { buildManifest } from '../src/capabilities.js';
import { CONFIG } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(here, '..', 'fixtures', name), 'utf8'));
// Bundled data files are injected here (node edition) — the Core itself never
// reads files (ARCHITECTURE §2); each platform's embedder does the injection.
const data = (name) => JSON.parse(readFileSync(path.join(here, '..', 'data', name), 'utf8'));

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

// ---- Motion scenarios (IMU shake/fall trigger) ----
{
  const { scenarios } = fixture('motion-scenarios.json');
  console.log('motion-scenarios:');
  for (const sc of scenarios) {
    const d = new MotionDetector();
    let first = null;
    let triggers = 0;
    for (const s of sc.samples) {
      const r = d.update(s.ax, s.ay, s.az, s.tMs);
      if (r.triggered) { triggers++; if (!first) first = r; }
    }
    const ok = !!first === sc.expect.triggered &&
      (!sc.expect.kind || (first && first.kind === sc.expect.kind));
    check(sc.name, ok, `(kind=${first ? first.kind : 'none'} triggers=${triggers})`);
    if (sc.expect.triggered) {
      check(`${sc.name} debounced to one trigger`, triggers === 1, `(triggers=${triggers})`);
    }
  }
  // Continuous violence inside retriggerMs stays ONE alert; reset() re-arms.
  const shake = scenarios.find((s) => s.name === 'violent-shake');
  const d = new MotionDetector();
  let triggers = 0;
  for (let rep = 0; rep < 3; rep++) {
    for (const s of shake.samples) {
      if (d.update(s.ax, s.ay, s.az, s.tMs + rep * 700).triggered) triggers++;
    }
  }
  check('retrigger suppressed within retriggerMs', triggers === 1, `(triggers=${triggers})`);
  d.reset();
  let after = 0;
  for (const s of shake.samples) {
    if (d.update(s.ax, s.ay, s.az, s.tMs).triggered) after++;
  }
  check('reset() re-arms the detector', after === 1, `(triggers=${after})`);
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

// ---- Jurisdiction policy v2 (§7): engine-level resolution ----
{
  const RULESET = data('ruleset.json');
  const GEO = data('geo-bounds.json');
  const { meta, geoCases, manualCases, distinctCountryCodes } = fixture('policy-scenarios.json');
  const HOUR_MS = 3600 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const newEngine = () => new PolicyEngine({ ruleset: RULESET, geoBounds: GEO });
  const geoCase = (name) => geoCases.find((c) => c.name === name);
  const atLoc = (engine, name, nowMs, extra = {}) => {
    const c = geoCase(name);
    return engine.updateLocation({ lat: c.lat, lon: c.lon, accuracyM: 20, ageMs: 0, nowMs, ...extra });
  };

  console.log('policy-ruleset:');
  {
    const e = newEngine();
    check('ruleset version matches fixture', e.getRulesetInfo().version === meta.rulesetVersion,
      `(ruleset=${e.getRulesetInfo().version})`);
    check('default profile id', e.getRulesetInfo().defaultProfileId === meta.defaultProfileId);
    check('every profile blocks publishing', e.listProfiles().every((p) => p.publishingAllowed === false));
    check('listJurisdictions covers all rules',
      e.listJurisdictions().length === RULESET.rules.length &&
      e.listJurisdictions().every((j) => j.code && j.displayName && j.profileId));

    // Built-in safety floor: FAILSAFE governs before any ruleset loads.
    const bare = new PolicyEngine();
    const rBare = bare.getResolved({ nowMs: 0 });
    check('built-in FAILSAFE governs before ruleset load',
      rBare.profile === FAILSAFE_PROFILE && rBare.source === 'default', `(profile=${rBare.profile.id})`);

    // Invalid ruleset is rejected; the previous one stays in force.
    const e2 = newEngine();
    const rej = e2.loadRuleset({ ...RULESET, defaultProfileId: 'NOPE' });
    check('ruleset with missing defaultProfileId rejected', rej.ok === false && rej.errors.length > 0,
      `(errors=${rej.errors})`);
    check('previous ruleset stays in force', e2.getRulesetInfo().version === meta.rulesetVersion);
    check('rejection queued for audit', e2.takeEvents().some((ev) => ev.type === 'ruleset-rejected'));
    const bare2 = new PolicyEngine({ ruleset: { bogus: true } });
    check('invalid ruleset at construction -> failsafe governs',
      bare2.getResolved({ nowMs: 0 }).profile.id === 'FAILSAFE');
  }

  console.log('policy-geo:');
  {
    for (const c of geoCases) {
      const e = newEngine();
      const out = atLoc(e, c.name, 1000);
      const r = e.getResolved({ nowMs: 1000, nowIso: '2026-07-18T00:00:00Z' });
      check(`geo ${c.name} -> ${c.expect.profileId}`,
        r.profile.id === c.expect.profileId && r.jurisdictionCode === (c.expect.jurisdictionCode ?? null),
        `(code=${r.jurisdictionCode} profile=${r.profile.id} source=${r.source})`);
      if (c.expect.candidatesInclude) {
        check(`geo ${c.name} candidates include ${c.expect.candidatesInclude.join('+')}`,
          c.expect.candidatesInclude.every((code) => out.candidates.includes(code)),
          `(candidates=${out.candidates})`);
      }
      if (c.expect.noCandidates) {
        check(`geo ${c.name} emits no-candidate event for audit`,
          e.takeEvents().some((ev) => ev.type === 'no-jurisdiction-candidates'));
        check(`geo ${c.name} fails safe via default`, r.source === 'default' && r.jurisdictionCode === null);
      }
    }
    // Fresh accurate fix resolves with high confidence + carries record-keeping fields.
    const e = newEngine();
    atLoc(e, 'singapore', 1000);
    const r = e.getResolved({ nowMs: 1000, nowIso: '2026-07-18T00:00:00Z' });
    check('gps resolution: source/confidence/resolvedAt/rulesetVersion',
      r.source === 'gps' && r.confidence === 'high' &&
      r.resolvedAt === '2026-07-18T00:00:00Z' && r.rulesetVersion === meta.rulesetVersion &&
      r.isOverride === false);
    // Pure geo helper: all candidates, subdivision codes first.
    const melb = geoCase('melbourne');
    const cands = resolveCandidates(melb.lat, melb.lon, GEO);
    check('resolveCandidates: subdivision first, country included',
      cands[0] === 'AU-VIC' && cands.includes('AU'), `(${cands})`);
    // Six researched countries -> six DISTINCT profiles.
    const ed = newEngine();
    ed.setLocationMode('manual');
    const ids = distinctCountryCodes.map((code) => {
      ed.setManualJurisdiction(code);
      return ed.getResolved({ nowMs: 0 }).profile.id;
    });
    check('six countries -> six distinct profiles', new Set(ids).size === distinctCountryCodes.length,
      `(${ids})`);
  }

  console.log('policy-manual:');
  for (const c of manualCases) {
    const e = newEngine();
    e.setLocationMode('manual');
    e.setManualJurisdiction(c.code);
    const r = e.getResolved({ nowMs: 0 });
    let ok = r.profile.id === c.expect.profileId;
    for (const f of ['recordingAllowed', 'audioCapture', 'rawRetention']) {
      if (f in c.expect) ok = ok && r.profile[f] === c.expect[f];
    }
    check(`manual ${c.code} -> ${c.expect.profileId}`, ok,
      `(profile=${r.profile.id} audio=${r.profile.audioCapture} raw=${r.profile.rawRetention})`);
    if (c.expect.unmatchedEvent) {
      check(`manual ${c.code} queues unmatched-jurisdiction event`,
        e.takeEvents().some((ev) => ev.type === 'unmatched-jurisdiction' && ev.code === c.code));
      check(`manual ${c.code} fails safe via default`, r.source === 'default');
    } else {
      check(`manual ${c.code} source manualSelection`, r.source === 'manualSelection' && r.jurisdictionCode === c.code);
    }
  }

  console.log('policy-failsafe:');
  {
    // Permission denied / no location ever -> default, confidence unknown.
    const e = newEngine();
    const r = e.getResolved({ nowMs: 0 });
    check('no location ever -> default profile',
      r.profile.id === meta.defaultProfileId && r.source === 'default' && r.confidence === 'unknown');
    // Stale fix (>10 min) -> low confidence -> stricter-of = default.
    const e2 = newEngine();
    atLoc(e2, 'singapore', 0);
    check('fresh SG fix -> SG_PERSONAL', e2.getResolved({ nowMs: 1000 }).profile.id === 'SG_PERSONAL');
    const stale = e2.getResolved({ nowMs: 11 * 60 * 1000 });
    check('stale fix (>10min) -> default (stricter-of)',
      stale.profile.id === meta.defaultProfileId && stale.confidence === 'low',
      `(profile=${stale.profile.id} confidence=${stale.confidence})`);
    // Fix already old at delivery (ageMs) counts toward staleness.
    const e3 = newEngine();
    atLoc(e3, 'singapore', 11 * 60 * 1000, { ageMs: 11 * 60 * 1000 });
    check('fix aged >10min at delivery -> default',
      e3.getResolved({ nowMs: 11 * 60 * 1000 }).profile.id === meta.defaultProfileId);
    // Accuracy 5 km -> low confidence -> stricter-of = default.
    const e4 = newEngine();
    atLoc(e4, 'singapore', 0, { accuracyM: 5000 });
    const low = e4.getResolved({ nowMs: 0 });
    check('accuracy 5km in SG -> stricter-of = default',
      low.profile.id === meta.defaultProfileId && low.confidence === 'low');
    // Stricter-of must never LOOSEN: low confidence in FR stays blocked.
    const e5 = newEngine();
    atLoc(e5, 'paris', 0, { accuracyM: 5000 });
    check('low confidence in FR stays FR_BLOCKED (stricter-of)',
      e5.getResolved({ nowMs: 0 }).profile.id === 'FR_BLOCKED');
  }

  console.log('policy-override:');
  {
    // FR (overridable:false): every looser target is blocked.
    const fr = newEngine();
    atLoc(fr, 'paris', 0);
    const frAuto = fr.getResolved({ nowMs: 0 }).profile;
    const looserTiers = fr.listProfiles()
      .filter((p) => compareStrictness(p, frAuto) > 0)
      .map((p) => fr.requestOverride(p.id, { nowMs: 0 }).tier);
    check('FR: every looser override tier=blocked',
      looserTiers.length > 0 && looserTiers.every((t) => t === 'blocked'), `(${looserTiers})`);
    check('FR: confirm of blocked override refused',
      fr.confirmOverride('SG_PERSONAL', { nowMs: 0, ackIso: 'ack' }).ok === false);
    check('unknown target profile -> blocked',
      fr.requestOverride('NOPE', { nowMs: 0 }).tier === 'blocked');

    // Tighten: SG auto -> RESTRICTED_DEFAULT target, applies without ack.
    const e = newEngine();
    atLoc(e, 'singapore', 0);
    const req = e.requestOverride('RESTRICTED_DEFAULT', { nowMs: 0 });
    check('tighten tier + auto/target profiles',
      req.tier === 'tighten' && req.autoProfile.id === 'SG_PERSONAL' && req.targetProfile.id === 'RESTRICTED_DEFAULT');
    check('tighten diff is structured from/to',
      req.diff.some((d) => d.field === 'audioCapture' && d.from === true && d.to === false) &&
      req.diff.some((d) => d.field === 'rawRetention' && d.from === 'sealed' && d.to === 'blurAtCapture'),
      JSON.stringify(req.diff));
    check('tighten applies without acknowledgment',
      e.confirmOverride('RESTRICTED_DEFAULT', { nowMs: 0 }).ok === true);
    const rt = e.getResolved({ nowMs: 1000 });
    check('tightened override governs',
      rt.profile.id === 'RESTRICTED_DEFAULT' && rt.source === 'userOverride' && rt.isOverride === true);

    // Loosen: RESTRICTED_DEFAULT auto -> SG target requires acknowledgment.
    const l = newEngine();
    check('loosen tier', l.requestOverride('SG_PERSONAL', { nowMs: 0 }).tier === 'loosen');
    const noAck = l.confirmOverride('SG_PERSONAL', { nowMs: 0 });
    check('loosen without ack refused', noAck.ok === false && noAck.reason === 'acknowledgment-required');
    check('loosen with ack applies',
      l.confirmOverride('SG_PERSONAL', { nowMs: 0, ackIso: '2026-07-18T01:00:00Z' }).ok === true);
    const rl = l.getResolved({ nowMs: 1000 });
    check('loosened override: source userOverride + isOverride + ack recorded',
      rl.profile.id === 'SG_PERSONAL' && rl.source === 'userOverride' && rl.isOverride === true &&
      rl.overrideAcknowledgedAt === '2026-07-18T01:00:00Z');
    const st = l.getOverrideStatus({ nowMs: HOUR_MS });
    check('override status counts down 24h', st.active === true && st.remainingMs === 23 * HOUR_MS);
    // Expiry at +24h via tick -> event + reverts to default.
    const expEvents = l.tick({ nowMs: DAY_MS });
    check('tick at +24h returns override-expired event',
      expEvents.some((ev) => ev.type === 'override-expired'));
    check('expiry event queued for audit log',
      l.takeEvents().some((ev) => ev.type === 'override-expired'));
    check('expired override reverts to default',
      l.getResolved({ nowMs: DAY_MS }).profile.id === meta.defaultProfileId &&
      l.getOverrideStatus({ nowMs: DAY_MS }).active === false);

    // GPS landing on a different jurisdiction invalidates the override.
    const j = newEngine();
    atLoc(j, 'singapore', 0);
    j.confirmOverride('RESTRICTED_DEFAULT', { nowMs: 0 });
    j.takeEvents();
    atLoc(j, 'hong-kong', 1000);
    check('jurisdiction change invalidates override (event)',
      j.takeEvents().some((ev) => ev.type === 'override-invalidated-jurisdiction-change'));
    const rj = j.getResolved({ nowMs: 1000 });
    check('after invalidation GPS governs again', rj.profile.id === 'HK_PERSONAL' && rj.source === 'gps');

    // adminConfig pin beats an active override.
    const a = newEngine();
    a.confirmOverride('SG_PERSONAL', { nowMs: 0, ackIso: 'ack' });
    check('admin pin rejects unknown profile', a.setAdminPin('NOPE').ok === false);
    a.setAdminPin('RECORDING_BLOCKED');
    const ra = a.getResolved({ nowMs: 1000 });
    check('adminConfig beats active override',
      ra.profile.id === 'RECORDING_BLOCKED' && ra.source === 'adminConfig' && ra.isOverride === false);
    a.setAdminPin(null);
    check('unpin restores the override', a.getResolved({ nowMs: 1000 }).source === 'userOverride');
    // clearOverride() manual disable.
    a.clearOverride();
    check('clearOverride reverts to base resolution', a.getResolved({ nowMs: 1000 }).source === 'default');
  }

  console.log('policy-session:');
  {
    const e = newEngine();
    atLoc(e, 'brisbane', 0);
    const snap = e.beginSession({ nowMs: 0, nowIso: '2026-07-18T02:00:00Z' });
    check('session begins under AU-QLD with audio on',
      snap.profile.id === 'AU_ONE_PARTY' && snap.profile.audioCapture === true);
    atLoc(e, 'melbourne', 1000);
    const t = e.evaluateSessionPolicy({ nowMs: 1000 });
    check('QLD -> VIC mid-session: action tighten, audio off',
      t.action === 'tighten' && t.newPolicy.profile.id === 'AU_ALL_PARTY' &&
      t.newPolicy.profile.audioCapture === false, `(action=${t.action})`);
    check('tighten advances the session snapshot',
      e.evaluateSessionPolicy({ nowMs: 1100 }).action === 'none');

    const e2 = newEngine();
    atLoc(e2, 'melbourne', 0);
    e2.beginSession({ nowMs: 0 });
    atLoc(e2, 'brisbane', 1000);
    const n = e2.evaluateSessionPolicy({ nowMs: 1000 });
    check('VIC -> QLD mid-session: looser NEVER applies (none + pending)',
      n.action === 'none' && n.pendingLooserPolicy && n.pendingLooserPolicy.profile.id === 'AU_ONE_PARTY',
      `(action=${n.action})`);
    atLoc(e2, 'paris', 2000);
    const s = e2.evaluateSessionPolicy({ nowMs: 2000 });
    check('-> FR mid-session: action stop (recordingAllowed false)',
      s.action === 'stop' && s.newPolicy.profile.recordingAllowed === false, `(action=${s.action})`);
    e2.endSession();
    check('endSession clears the snapshot', e2.evaluateSessionPolicy({ nowMs: 3000 }).action === 'none');
  }
}

// ---- Policy fail-safe floor + deterrent cooldown + manifest ----
{
  console.log('misc:');
  const failSafe = new PolicyEngine();
  check('no-ruleset engine governs by built-in FAILSAFE',
    failSafe.getResolved({ nowMs: 0 }).profile === FAILSAFE_PROFILE);
  check('profileDiff of identical profiles is empty',
    profileDiff(FAILSAFE_PROFILE, FAILSAFE_PROFILE).length === 0);
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
