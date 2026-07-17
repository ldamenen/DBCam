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
you should see the **blurred** preview. Detection boxes, an FPS counter, and status
pills show what the pipeline is doing. Press **Stop** to get inline playback and a
download link. The **Event** button and an approaching animal both flag an incident;
an approaching animal also triggers the audible deterrent (with a cooldown).

## What maps to what

Each JS module mirrors a native module from the spec (§2.2), so the architecture
reads the same across the web PoC and the future iOS/Android apps:

| Module | Native spec (§2.2) | Notes |
| --- | --- | --- |
| `captureLayer.js` | Capture Layer | Camera opened **once**; single source of truth. |
| `detection.js` | Face/Animal detect | MediaPipe Tasks (same family as Android ML Kit; mirrors iOS Vision). |
| `faceBlur.js` | Face Detect + Blur | **Fail-safe over-blur** on stale/low-confidence detection. |
| `animalDeterrent.js` | Animal Deterrent Detector | Approach = box large + growing + centered. |
| `deterrentSound.js` | (deterrent output) | Web Audio alarm, cooldown, sensitivity. |
| `incidentDetector.js` | Incident Detector | Manual button + animal approach (audio/IMU = native). |
| `recorder.js` | Encrypted Store (blurred layer) | Records the **blurred canvas**, never the raw feed. |
| `sessionController.js` | Session Controller | Screen Wake Lock + interruption **gap markers**. |
| `policyEngine.js` | Jurisdiction Policy Engine (§7) | **Injectable stub**; capture reads behavior from the profile. |
| `auditLog.js` | Audit Log | Append-only, hash-chained shape (in-memory PoC). |
| `ui.js` | Review/Download UI | Overlays, FPS, profile/incident banners, playback. |

## Scope limits

Per §11.2, this PoC deliberately does **not** provide:

- **Encryption at rest** — no Secure-Enclave / Keystore-backed keys.
- **Always-on / background recording** — browsers suspend hidden tabs; the wake
  lock is best-effort.
- **Sealed raw evidence** — the encrypted raw pre-roll ring buffer + authorized
  unseal are stubbed. Capture is raw, but blur is applied on the canvas *before*
  display/recording, and the raw feed is never persisted.
- **Jurisdiction enforcement** — the Policy Engine is a static injectable stub.

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
