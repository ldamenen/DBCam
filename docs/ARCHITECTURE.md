# DBCam — Three-Client Architecture

**Clients:** Web/HTML (current) · iOS native (Swift, no Capacitor) · Android native (Kotlin)
**Principle:** one feature, implemented once, takes effect on all three — unless a platform
cannot support it, in which case it degrades explicitly via the capability manifest.
**Constraint:** every client is **fully self-contained** — no backend, no accounts, no
runtime server dependency. Everything (Core, models, rules, storage, crypto) lives on the
device. See §0.

---

## 0. Self-contained by construction (no servers)

There is **no DBCam server** anywhere in this architecture. What that means per layer:

- **The Core is embedded, not fetched.** It is bundled into each app at *build time*
  (ES modules for web, `core.bundle.js` inside the iOS/Android binaries). No runtime
  download, no version check, no phone-home.
- **ML models are bundled.** Native apps ship face/animal models inside the app binary
  (Vision/ML Kit are on-device by design; any TFLite model is packaged as an asset).
  The web client currently loads MediaPipe from a CDN — that is a server dependency and
  gets fixed in Phase A: models + wasm are vendored into the repo and served as part of
  the app's own static files, plus a service worker so the web app works fully offline
  after first load (a web page inherently arrives from a host once; after that, nothing).
- **Jurisdiction rule tables ship as bundled data.** The original spec suggested
  server-updatable rules; under the no-server constraint they are versioned data files
  inside each release, updated by shipping a new app/page version (or manual file import
  for enterprise). The Core treats them as data either way, so this is a packaging choice,
  not an architecture change.
- **All storage is local.** Recordings, sealed evidence, audit chains, settings — on-device
  only (files + Keystore/Secure Enclave native; browser storage on web). Nothing is
  uploaded, ever. Export is an explicit user action (share sheet / download).
- **No telemetry, no analytics, no crash reporters** that call out. Diagnostics stay in
  the on-screen panel and local logs.
- **One honest exception to flag:** *web* speech recognition (the voice trigger) is
  routed by the browser to Apple/Google servers — that is how the Web Speech API works and
  no app can change it. Under the no-server rule the capability manifest marks it
  `selfContained: false` on web (user-visible warning); iOS/Android use **on-device**
  recognition (`SFSpeechRecognizer(requiresOnDeviceRecognition: true)` / Android offline
  recognizer), which satisfies the constraint fully.

---

## 1. The one honest constraint this design is built around

Not all code *can* be shared, and pretending otherwise produces bad apps. DBCam's code
splits cleanly into two kinds:

1. **Decision logic** — *what the app decides*: when an animal is hostile, when an incident
   opens and closes, what the active jurisdiction profile allows, which raw window gets
   sealed, what goes into the audit chain, what the retention rules are. This is scalar
   math, state machines, and data tables. **It is 100% shareable**, and it is where almost
   every feature we have built so far actually lives (threat tuning, pre-roll windows,
   voice-word semantics, policy gating, audit entries).

2. **Pixel & sensor pipelines** — *how the platform touches hardware*: camera frames, face
   boxes, mosaic blur, video encoding, mic FFT, speech recognition, secure storage,
   wake locks. Apple, Google, and the browser each expose these through incompatible,
   non-negotiable APIs (AVFoundation/Vision vs CameraX/ML Kit vs getUserMedia/MediaPipe).
   **This layer cannot be shared** — but it can be made *thin, dumb, and mechanical*.

So the architecture is **a shared Core that owns every decision, surrounded by
per-platform adapters that own no decisions at all**. A feature = a change to the Core
(once) + at most a few lines of mechanical adapter wiring per platform.

```
                 ┌─────────────────────────────────────────────┐
                 │              DBCAM CORE (shared)             │
                 │                                             │
                 │  PolicyEngine · ThreatScorer · IncidentFSM  │
                 │  EvidenceSealer · AuditChain · SessionFSM   │
                 │  Config/Tuning · Capability rules           │
                 │                                             │
                 │        pure logic — no I/O, no UI           │
                 └───────┬──────────────┬──────────────┬───────┘
                         │ ports        │ ports        │ ports
              ┌──────────┴───┐  ┌───────┴──────┐  ┌────┴─────────┐
              │  WEB adapter │  │ iOS adapter  │  │ ANDROID      │
              │  getUserMedia│  │ AVFoundation │  │ adapter      │
              │  MediaPipe   │  │ Vision       │  │ CameraX      │
              │  Canvas blur │  │ CoreImage    │  │ ML Kit       │
              │  MediaRecorder│ │ AVAssetWriter│  │ MediaCodec   │
              │  WebCrypto   │  │ CryptoKit/SE │  │ Keystore     │
              │  HTML UI     │  │ SwiftUI      │  │ Compose      │
              └──────────────┘  └──────────────┘  └──────────────┘
```

---

## 2. Core language: TypeScript, embedded everywhere

The Core is written in **TypeScript** and runs on all three platforms:

| Platform | How the Core runs |
| --- | --- |
| Web | Natively — it *is* JavaScript. Imported directly by the web client. |
| iOS | Embedded via **JavaScriptCore** — Apple's system JS engine, a public framework shipped with iOS (zero extra binary size, App-Store-legal, used this way by many production apps). |
| Android | Embedded via **androidx.javascriptengine** (JavaScriptSandbox, V8-backed) or QuickJS. |

**Why TypeScript and not the alternatives:**

- **Kotlin Multiplatform** — the industry's other good answer. Rejected because (a) it would
  force an immediate rewrite of the working, tested logic we already have in JS, (b) its
  JS/web target would make the *current* client the second-class one, and (c) it moves the
  iteration loop into Gradle/Xcode toolchains, giving up today's edit-refresh speed.
- **Rust core (wasm + FFI)** — technically excellent, best-in-class for the crypto parts,
  but the steepest learning curve and toolchain cost; overkill while the product is still
  discovering its shape. Can be revisited later for the sealing module specifically.
- **C/C++ core** — shareable everywhere but hostile to fast iteration; no.

**Performance is a non-issue by design:** the Core is called at *decision rate*
(once per frame with a handful of floats — threat terms, box geometry — plus occasional
events), never at *pixel rate*. Scoring math on ~30 scalars at 30 Hz is negligible in any
JS engine. All per-pixel work (blur, encode) stays native on each platform.

**Crypto note:** the Core defines *what* to hash/seal/log and the canonical byte layout;
the actual primitives (SHA-256, AES-GCM, key storage) are **injected as a port** so each
platform uses its best implementation (WebCrypto / CryptoKit + Secure Enclave / Keystore).
Golden test vectors (§6) guarantee all three produce identical chains.

---

## 3. What lives in the Core (shared, implement-once)

Everything below ships as one package, `core/`, and a change here lands on all three
clients simultaneously:

| Core module | Today's file (web-poc) | Responsibility |
| --- | --- | --- |
| `policy` | `policyEngine.js` | Jurisdiction profiles, fail-safe-to-most-restrictive, raw mode / audio / retention gating (spec §7). |
| `threat` | `animalDeterrent.js` | Threat scoring: proximity / lunge / agitation / audio terms, walk-floor, sustain dwell, sensitivity scaling. |
| `incident` | `incidentDetector.js` | Incident state machine: open/extend/close, hold windows, reasons, trigger fusion (manual / voice / hostile-animal / future IMU). |
| `evidence` | `evidenceStore.js` (logic half) | Segment math: pre-roll reach-back, window clamping rules, seal/unseal/export state, authorization gating semantics. |
| `audit` | `auditLog.js` | Append-only hash-chained log: canonical serialization, chain rules, entry vocabulary. (Hash fn injected.) |
| `session` | parts of `main.js` + `sessionController.js` | Session state machine: idle → recording → review; gap markers; what starts/stops when. |
| `config` | `config.js` | Every tunable: thresholds, weights, pre-roll seconds, cooldowns, mosaic strength, version string. |
| `capabilities` | new | The capability manifest logic (§5). |
| `deterrent-policy` | part of `deterrentSound.js` | *When* to fire / cooldown bookkeeping (the tone synthesis itself is a platform port). |

Notice what this list is: **it is every feature you have asked for so far.** The calm-dog
fix, the voice-word semantics, the sealing windows, the export-must-be-logged rule — all of
it is Core. Under this architecture each of those would have been implemented exactly once.

## 4. What stays per-platform (the ports)

Each platform implements the same small set of interfaces ("ports"). Adapters contain
**no thresholds, no rules, no decisions** — they move data and obey the Core.

| Port | Web impl | iOS impl | Android impl |
| --- | --- | --- | --- |
| `CameraSource` | getUserMedia + `<video>` | AVCaptureSession | CameraX |
| `FaceDetector` | MediaPipe Tasks | Vision `VNDetectFaceRectangles` | ML Kit Face Detection |
| `AnimalDetector` | MediaPipe ObjectDetector | Vision `VNRecognizeAnimals` / CoreML | ML Kit Object Detection + TFLite |
| `BlurRenderer` | Canvas mosaic | CoreImage/Metal pixellate | RenderEffect / GPU shader |
| `VideoRecorder` (blurred + raw) | MediaRecorder ×2 | AVAssetWriter ×2 | MediaCodec ×2 |
| `AudioLevelMonitor` | Web Audio AnalyserNode | AVAudioEngine tap + vDSP | AudioRecord + FFT |
| `SpeechTrigger` | Web Speech API | SFSpeechRecognizer (on-device) | Android SpeechRecognizer / wake-word lib |
| `DeterrentSpeaker` | Web Audio oscillator | AVAudioEngine | SoundPool |
| `SecureStore` | WebCrypto + IndexedDB (weak) | CryptoKit + Secure Enclave + files | Keystore + EncryptedFile |
| `KeepAwake` | Screen Wake Lock (best-effort) | `isIdleTimerDisabled` | `FLAG_KEEP_SCREEN_ON` |
| `MotionSensor` (future IMU) | DeviceMotionEvent | CoreMotion | SensorManager |
| `Clock`, `Rng`, `Hash` | trivial injections so the Core stays pure & testable | | |

**UI is also per-platform** (HTML / SwiftUI / Compose — there is no honest way to share
it natively), but it is kept *thin* the same way: the Core's session state machine emits a
**view state** (mode, timer, threat %, incident banner, chips, review list, capability
flags) and the three UIs are dumb renderers of that state. New UI-visible feature =
new field in the view state (Core, once) + one small render addition per platform.

## 5. "Unless the feature is not supported" — the capability manifest

Every adapter reports what it can actually do at startup; the Core merges this into a
**capability manifest** that gates features *in one place*:

```ts
// reported by adapters, consumed by Core + UI
capabilities = {
  voiceTrigger:   { supported: true,  selfContained: false,  // web: browser routes audio
                    reason: "Web Speech API uses vendor servers" },
  secureSealing:  { supported: false, reason: "no hardware keystore" }, // web
  backgroundSafe: { supported: false, reason: "browser suspends tabs" }, // web
  onDeviceSpeech: { supported: true,  selfContained: true },  // iOS/Android
  ...
}
```

Rules:
- A feature's *logic* always ships in the Core. Whether it is *active* on a platform is a
  manifest lookup, never an `if (isIOS)` scattered through code.
- Unsupported ⇒ the UI shows the feature disabled **with the reason** (we already do this
  ad-hoc for voice: `voice: unsupported`) — honest degradation, not silent absence.
- Partial support (e.g. web speech = server-side) is *declared*, so product decisions
  ("allow it but warn") are Core policy, not platform improvisation.

## 6. Conformance: how we prove "one feature = same behavior ×3"

Sharing code is not enough — embedding differences and adapter bugs can still diverge
behavior. Two mechanisms keep the three clients honest:

1. **Golden fixtures** (`core/fixtures/*.json`): input → expected output vectors for every
   Core module. Example: a recorded sequence of animal boxes + audio levels → expected
   threat scores and the exact frame the incident opens. The calm-dog scenario from field
   testing becomes a permanent fixture. Same for audit chains: given these events, byte-
   for-byte this hash chain.
2. **Conformance runner per platform**: each client has a debug target that loads the
   fixtures through its *embedded* Core (web: node/browser; iOS: XCTest via
   JavaScriptCore; Android: instrumented test via the JS engine) and asserts identical
   results. CI runs all three. If iOS's JS engine ever rounds differently, we find out in
   CI, not in court.

## 7. Repository layout (monorepo)

```
DBCam/
├─ core/                      # THE shared library (TypeScript, zero deps, pure)
│  ├─ src/
│  │  ├─ policy.ts  threat.ts  incident.ts  evidence.ts
│  │  ├─ audit.ts   session.ts config.ts    capabilities.ts
│  │  └─ index.ts             # single entry; also bundled to core.bundle.js for embedding
│  ├─ fixtures/               # golden test vectors (JSON, platform-agnostic)
│  └─ test/                   # unit tests (run in node; same fixtures reused by clients)
├─ clients/
│  ├─ web/                    # current web-poc, refactored to import core/
│  ├─ ios/                    # SwiftUI app; embeds core.bundle.js via JavaScriptCore
│  │  ├─ DBCam.xcodeproj  Sources/  Adapters/  CoreBridge/
│  └─ android/                # Kotlin/Compose app; embeds core.bundle.js
│     ├─ app/src/...  adapters/  corebridge/
├─ contracts/                 # port interface definitions + capability schema (source of truth)
├─ docs/
│  └─ ARCHITECTURE.md         # this file
└─ .github/workflows/         # web deploy (existing) + core tests + conformance
```

The web client keeps its GitHub Pages deploy exactly as today (the workflow path moves
with it). `core/` is consumed by the web client as plain ES modules — no bundler required
initially — and bundled into a single `core.bundle.js` artifact for the two native embeds.

## 8. The feature workflow (what "extend once" means day-to-day)

Example A — **"tighten hostile-animal detection"** (what we just did):
1. Change `core/src/threat.ts` weights/floors; add the calm-dog fixture.
2. Done. All three clients behave identically on their next build/deploy. Zero adapter work.

Example B — **"add IMU shake trigger"** (spec §2.2, future):
1. Core: add `imu` term to the incident FSM + fixtures. (The feature's brain, once.)
2. Adapters: ~20 mechanical lines each — web `DeviceMotionEvent`, iOS CoreMotion,
   Android SensorManager — each just forwarding `(ax, ay, az, t)` to the Core.
3. Manifest: platforms report `motionSensor.supported`.

Example C — **"new blur style"** (pixel work — the worst case):
1. Core: config knob + view-state field (so it's policy-driven and consistent).
2. Each platform implements the shader/filter natively. This is the honest cost of
   pixel features; the architecture minimizes but cannot remove it.

Rule of thumb enforced in review: **if a PR puts a number, threshold, or rule inside
`clients/`, it is wrong** — it belongs in `core/`.

## 9. Security placement (who is trusted with what)

- The Core decides **what** must be sealed, logged, retained, and exportable, and defines
  canonical bytes for hashing — so evidence semantics can never drift between platforms.
- Each platform's `SecureStore` adapter performs the actual cryptography with its best
  hardware: Secure Enclave (iOS), StrongBox/Keystore (Android), WebCrypto (web — declared
  `secureSealing: unsupported` in the manifest, which is the architecture telling the
  truth: web builds are demo-grade, per spec §11.2).
- Consequence: the *evidence-grade* promise ships on iOS/Android the day their adapters
  land, while the web client remains the fast-iteration prototype — same brain, weaker vault.

## 10. Migration plan from today's code

Phased so the working app never breaks; each phase lands on `main` green.
**Status: Phase A shipped** (Core extracted as JSDoc-typed ES modules — TS-checkable,
zero build step for web; MediaPipe + models vendored; offline service worker; golden
fixtures + CI). **Phase B shipped** (port contracts in `contracts/`; conformance
runner + fixtures in CI). Native embeds will bundle `core/src/` to `core.bundle.js`
when Phase C starts.

- **Phase A — Extract the Core + go self-contained.** Create `core/` and move the decision
  halves of `policyEngine / animalDeterrent / incidentDetector / evidenceStore / auditLog /
  config` into it; re-point the web client; convert the existing unit checks into fixtures.
  Vendor the MediaPipe wasm + models into the repo (drop the CDN) and add a service worker
  so the web app runs offline after first load (§0).
  *Deliverable: identical web app, now running on the shared Core, with no runtime server
  dependency. (Days.)*
- **Phase B — Contracts + conformance.** Write the port interfaces (`contracts/`), the
  capability manifest, and the fixture runner; wire CI. *(Days.)*
- **Phase C — iOS client, Phase 1 scope.** SwiftUI shell + CoreBridge (JavaScriptCore) +
  camera/face/blur/record adapters (spec §10's Phase-1 pipeline), driven by the Core.
  Requires a Mac + Apple account for device installs. *(Weeks.)*
- **Phase D — Android client.** Same shape as C. *(Weeks, faster after C.)*
- **Phase E — Native-only capabilities.** Secure sealing on hardware keys, on-device
  speech, encrypted ring buffer — adapters only; the Core semantics already exist.

---

## Appendix: what this buys you, concretely

| Feature change | Where it happens | Reaches |
| --- | --- | --- |
| Threat tuning, new trigger rules, policy/jurisdiction tables, retention, audit vocabulary, pre-roll length, cooldowns, capability policy, view-state/UI logic | `core/` once | all 3 automatically |
| New sensor input | `core/` once + ~20-line adapter ×3 | all 3 |
| Pixel/codec work (blur style, encoder settings) | config in `core/`, implementation ×3 | all 3, at native cost |
| Platform-impossible features | `core/` once + manifest says no | supported platforms only, honest UI on the rest |
```
