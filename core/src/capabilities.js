// core/capabilities.js  (shared Core — ARCHITECTURE §5)
// The capability manifest: adapters REPORT what the platform can do; the Core
// merges those reports over conservative defaults and gates features in ONE
// place. No `if (isIOS)` scattered through clients.
//
// Shape per capability: { supported: boolean, selfContained?: boolean, reason?: string }
//   - supported:     the feature can run on this platform at all
//   - selfContained: it runs without any external server (ARCHITECTURE §0);
//                    defaults to `supported` when omitted
//   - reason:        user-facing explanation for degradation

/** Conservative defaults: everything off until an adapter says otherwise. */
export const CAPABILITY_DEFAULTS = Object.freeze({
  camera:         { supported: false, reason: 'no adapter reported' },
  faceDetection:  { supported: false, reason: 'no adapter reported' },
  animalDetection:{ supported: false, reason: 'no adapter reported' },
  audioMonitor:   { supported: false, reason: 'no adapter reported' },
  voiceTrigger:   { supported: false, reason: 'no adapter reported' },
  deterrent:      { supported: false, reason: 'no adapter reported' },
  rawRecording:   { supported: false, reason: 'no adapter reported' },
  secureSealing:  { supported: false, reason: 'no hardware keystore' },
  backgroundSafe: { supported: false, reason: 'platform may suspend the app' },
  motionSensor:   { supported: false, reason: 'no adapter reported' },
});

/**
 * Merge adapter reports over the defaults into the session's manifest.
 * @param {Record<string, {supported:boolean, selfContained?:boolean, reason?:string}>} reported
 */
export function buildManifest(reported = {}) {
  const out = {};
  for (const key of Object.keys(CAPABILITY_DEFAULTS)) {
    const r = reported[key];
    const base = r ? { ...r } : { ...CAPABILITY_DEFAULTS[key] };
    if (base.selfContained === undefined) base.selfContained = !!base.supported;
    out[key] = Object.freeze(base);
  }
  // Unknown keys from adapters pass through (forward compatibility).
  for (const key of Object.keys(reported)) {
    if (!(key in out)) {
      const base = { ...reported[key] };
      if (base.selfContained === undefined) base.selfContained = !!base.supported;
      out[key] = Object.freeze(base);
    }
  }
  return Object.freeze(out);
}

/** Compact summary for audit/session logs. */
export function summarize(manifest) {
  const on = [], off = [], leaky = [];
  for (const [k, v] of Object.entries(manifest)) {
    (v.supported ? on : off).push(k);
    if (v.supported && !v.selfContained) leaky.push(k);
  }
  return { on, off, notSelfContained: leaky };
}
