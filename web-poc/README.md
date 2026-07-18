# DBCam — Web Proof-of-Concept

A **throwaway browser demo** of the session-based privacy body-cam core loop:

> capture (raw) → detect faces + animals → **blur faces** → fire a deterrent on
> animal approach → **record the blurred stream** → play back + download.

It exists to prove the concept fast, with zero app-store/install friction. It is
**not** the shippable product — the evidence-grade guarantees are native-only (see
[Scope limits](#scope-limits)).

## Live demo (GitHub Pages)

Pushes to `main` deploy this folder to GitHub Pages via
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml), served over HTTPS at:

> **https://ldamenen.github.io/DBCam/**

That HTTPS URL is what makes the camera work on **iOS Safari** (`getUserMedia`
requires a secure context). Open it in Safari, tap **Start session**, allow the
camera.

**One-time enablement is required** before the workflow can publish:

- The repo must be able to serve Pages — that means a **public** repo (free), or a
  **private** repo on a **paid plan** (Pro/Team/Enterprise).
- Turn Pages on once: **Settings → Pages → Build and deployment → Source:
  GitHub Actions**. After that, every push to `main` (or a manual re-run of the
  workflow) deploys automatically.

If you'd rather not use Pages at all, use the local `python3 -m http.server` route
below with a tunnel such as `cloudflared` — it works regardless of repo visibility
or plan.

## Run it locally

`getUserMedia` requires a secure context, so serve over `localhost` or HTTPS
(opening `index.html` via `file://` will not get camera access). Network access is
also required at runtime — the MediaPipe models are loaded from a CDN.

```bash
cd web-poc
python3 -m http.server 8000
# then open http://localhost:8000  (Chrome/Edge/Firefox; iOS Safari has caveats below)
```

Press **Start session**, grant camera (+ mic if the active profile allows it), and
you should see the **blurred** (pixelated) preview. Detection boxes, an FPS counter,
and status pills show what the pipeline is doing.

**Ways to flag an incident:**
- **Event button** — manual hard override.
- **Voice trigger word** (Settings & diagnostics) — speak a word you set (default
  "help") to flag hands-free. Web Speech API only; on iOS Safari it needs a separate
  permission and routes audio to Apple's servers, and it can pause/restart — so it's
  PoC-grade. Native would use on-device wake-word spotting.
- **Hostile animal** — a **threat score** combining what it looks like (proximity,
  lunge speed from box-area growth, agitation) **and what it sounds like** (a loud
  low-frequency sound spike from the mic — a bark/growl proxy). It only fires when the
  combined score reads as hostile. Both cues are behaviour-based inference, **not**
  aggression/emotion or sound *classification* (a generic detector only sees a box +
  label; the audio term only knows "loud + low + sudden"). A hostile animal also
  triggers the audible deterrent (with a cooldown); the Settings slider tunes threat
  sensitivity, and a `sound:` chip shows the live audio level.

Press **Stop** to get the review:
- **Blurred recording** — the privacy-safe default, freely playable/downloadable.
- **Sealed raw evidence** — each incident is a segment of the *unblurred* recording,
  reaching back `prerollSeconds` before the trigger (the buildup). It stays sealed
  until you click **Authorize & unseal**, which writes to the audit log and then
  plays *only* that incident's window. Once unsealed, **⬇ Export raw** downloads the
  raw file — every export is also audit-logged. (Browser caveat: the export is the
  full raw session file, since trimming to the window would need a re-encode; the
  in-app player stays clamped.) The live preview is never unblurred — raw is
  release-time only (§1).
- **Audit log** — append-only, hash-chained; every incident open/close and every
  raw unseal is recorded.

The raw is only recorded when the active policy profile is `raw-sealed`; a
`blur-at-capture` profile retains no raw at all (§7).

## What maps to what

Each JS module mirrors a native module from the spec (§2.2), so the architecture
reads the same across the web PoC and the future iOS/Android apps:

| Module | Native spec (§2.2) | Notes |
| --- | --- | --- |
| `captureLayer.js` | Capture Layer | Camera opened **once**; single source of truth. |
| `detection.js` | Face/Animal detect | MediaPipe Tasks (same family as Android ML Kit; mirrors iOS Vision). |
| `faceBlur.js` | Face Detect + Blur | **Fail-safe over-blur** on stale/low-confidence detection. |
| `animalDeterrent.js` | Animal Deterrent Detector | **Threat score** = proximity + lunge speed + agitation + sound; behaviour-based, not aggression recognition. |
| `audioMonitor.js` | Incident Detector (audio) | Loud low-frequency spike (bark/growl proxy) via Web Audio; feeds the threat score. |
| `deterrentSound.js` | (deterrent output) | Web Audio alarm, cooldown, sensitivity. |
| `voiceTrigger.js` | Incident Detector (audio) | Web Speech API keyword listener → incident (PoC-grade; native = on-device wake-word). |
| `incidentDetector.js` | Incident Detector | Manual button + voice word + hostile animal; tracks each incident's start/end window (IMU = native). |
| `recorder.js` | Encrypted Store (both layers) | Records the **blurred canvas** (default) and, in parallel, the **raw camera feed** (sealed). |
| `evidenceStore.js` | Evidence Sealer + Store | Builds sealed segments (with pre-roll) from incidents; gates authorized unseal. |
| `sessionController.js` | Session Controller | Screen Wake Lock + interruption **gap markers**. |
| `policyEngine.js` | Jurisdiction Policy Engine (§7) | **Injectable stub**; capture + raw-retention read from the profile. |
| `auditLog.js` | Audit Log | Append-only, hash-chained; logs incidents + every raw unseal. |
| `ui.js` | Review/Download UI | Overlays, FPS, banners, blurred playback, sealed-evidence review, audit view. |

## Scope limits

Per §11.2, this PoC deliberately does **not** provide:

- **Encryption at rest** — no Secure-Enclave / Keystore-backed keys; the raw blob is
  held in memory, not encrypted.
- **Always-on / background recording** — browsers suspend hidden tabs; the wake
  lock is best-effort.
- **Cryptographic sealing / split-key authorization** — the PoC *demonstrates* the
  flow (raw recorded continuously, incidents sealed as segments with pre-roll,
  authorized unseal + audit log), but "authorization" is a UI confirm, not a
  split-key/approver control, and playback is only *clamped* to the window rather
  than cryptographically sealed.
- **Jurisdiction enforcement** — the Policy Engine is a static injectable stub (it
  does drive raw-retention on/off, but does not resolve or enforce real law).

## Where browser limitations bite

- **Backgrounding**: switching tabs/apps throttles `requestAnimationFrame` and
  effectively pauses capture. The session controller records a **gap marker** when
  the tab is hidden, but true always-on needs native.
- **Wake lock**: `navigator.wakeLock` is unsupported on some browsers and can be
  released by the OS; we re-acquire on visibility change, but it is not guaranteed.
- **iOS Safari**: rear-camera selection, autoplay of the deterrent sound (needs the
  Start user-gesture — handled), and `DeviceMotion`/mic permission prompts are
  quirkier than Chrome. `MediaRecorder` support/codecs vary by iOS version.
- **Performance**: real-time blur + **two** detectors strains a warm phone. Tune
  `faceEveryN` / `animalEveryN` and blur radius in `js/config.js`; drop capture
  resolution if FPS sags. Native (Neural Engine / GPU delegate) is far cheaper.

## Config

All tunables live in [`js/config.js`](js/config.js): capture resolution, detection
cadence + confidence thresholds, blur radius + fail-safe timings, animal-approach
thresholds, deterrent tone/cooldown, and recorder codecs.
